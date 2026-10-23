// lib/bug-reports.js: /bug, a zero-friction flag for anything that looked wrong.
//
// Most real bugs are noticed in normal use and then lost: by the time anyone
// looks, the chat has moved on and nobody can say what the screen showed. So
// /bug, with a description or with nothing (the conversation says what went
// wrong), captures the moment: the last few messages and any screenshot sent
// with it. Closedhand then says what it would send and asks first, and only a
// yes sends it to Closedhand's bug database on closedhand.com, where it is
// worked through. Nothing is kept on the person's computer: until the answer
// the report is held in memory, and a no or no answer drops it.
//
// What comes back is a receipt that can check this report's outcome and
// nothing else (closedhand-com/lib/bugs.js). Closedhand checks its receipts a
// few times a day and tells the person, once, when one is fixed: nobody has
// to remember to ask.

const ctx = require("./context");
const { UserStore } = require("../user-store");

const BUG_PREFIX = /^\s*\/bug\b[:,\s]*/i;
// A platform prefixes a reply with the message it answers ("[replying to
// ...]\n/bug ..."), which is exactly how people flag a bad answer. The command
// is read past that prefix, and the quoted message rides along in the comment.
const REPLY_PREFIX = /^\s*\[replying to ([^\]]*)\]\s*/i;
// Five turns: enough to see what went wrong, small enough that people are
// willing to send it. The comment carries the rest.
const SNAPSHOT_TURNS = 5;
const INTAKE_URL = process.env.BUG_INTAKE_URL || "https://closedhand.com/api/bug-intake";
const ANSWER_MS = 15 * 60 * 1000;
const MAX_TURN_CHARS = 1500;
const MAX_SCREENSHOTS = 4;
const RECEIPTS_KEPT = 20;
const CHECK_EVERY_MS = 6 * 3600 * 1000;

function isBugReport(text) {
  return typeof text === "string" && BUG_PREFIX.test(text.replace(REPLY_PREFIX, ""));
}

function stripCommand(text) {
  const m = String(text || "").match(REPLY_PREFIX);
  const body = String(text || "").replace(REPLY_PREFIX, "").replace(BUG_PREFIX, "").trim();
  return m ? `${body} (in reply to: ${m[1].trim()})`.trim() : body;
}

function appVersion() {
  let v = "";
  try { v = require("../package.json").version || ""; } catch (_) {}
  const sha = (process.env.CLOSEDHAND_SHA || "").slice(0, 7);
  return sha ? `${v}+${sha}` : v;
}
// One opaque id per Closedhand, so reports from the same one group together
// without saying anything about who it is.
function installId() {
  const seed = ctx.activeUserStore?.profile?.created_at || "";
  if (!seed) return null;
  return require("crypto").createHash("sha256").update(String(seed)).digest("hex").slice(0, 12);
}

// Conversation entries are a mix of plain strings and Anthropic-shaped block
// arrays (tool_use, tool_result, images). Flatten to something readable and
// drop base64: a transcript full of image data is unreadable and enormous.
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text": parts.push(block.text || ""); break;
      case "image": parts.push("[image]"); break;
      case "document": parts.push(`[document: ${block.source?.filename || "file"}]`); break;
      case "tool_use": parts.push(`[called ${block.name} ${JSON.stringify(block.input || {}).substring(0, 300)}]`); break;
      case "tool_result": {
        const inner = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map(b => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ")
            : JSON.stringify(block.content ?? "");
        parts.push(`[result${block.is_error ? " (error)" : ""}: ${String(inner).substring(0, 400)}]`);
        break;
      }
      default: parts.push(`[${block.type}]`);
    }
  }
  return parts.filter(Boolean).join("\n");
}

async function snapshotTurns(userId) {
  // In-memory first: it holds the turn that just went wrong, which may not have
  // been saved yet. Falling back to the store covers being called from a timer
  // (WhatsApp batches images that way) where the context bubble has moved on.
  let turns = [];
  try { turns = ctx.store?.conversations?.[userId] || []; } catch (_) { turns = []; }
  if (turns.length === 0) {
    try { turns = (await UserStore.load(userId)).conversations || []; }
    catch (e) { console.error("[bug] Could not load conversation:", e.message); }
  }
  return turns.slice(-SNAPSHOT_TURNS).map(m => ({ role: m.role, content: flattenContent(m.content).substring(0, MAX_TURN_CHARS) }));
}

function imagesFrom(fileData) {
  if (!fileData) return [];
  const list = fileData.isMultiImage && Array.isArray(fileData.images) ? fileData.images : [fileData];
  return list
    .map(img => ({ buffer: img.buffer || (img.base64 ? Buffer.from(img.base64, "base64") : null), mediaType: img.mediaType || "image/jpeg" }))
    .filter(i => i.buffer && /^image\/(jpeg|png|webp|gif)$/.test(i.mediaType))
    .slice(0, MAX_SCREENSHOTS);
}

// Reports waiting for their yes or no, by person. Memory only.
const waiting = new Map();

/**
 * Take a /bug and return the line to send back: what would be sent, and the
 * question. Never throws: a failure here must not also swallow the message.
 */
async function fileBugReport({ userId, text, fileData, platform }) {
  try {
    const shots = imagesFrom(fileData);
    const report = {
      submission_key: require("crypto").randomBytes(32).toString("hex"),
      install_id: installId(),
      app_version: appVersion(),
      platform: platform || null,
      comment: stripCommand(text) || null,
      transcript: await snapshotTurns(userId),
      screenshots: shots.map(s => ({ mediaType: s.mediaType, base64: s.buffer.toString("base64") })),
      created_at: new Date().toISOString(),
    };
    waiting.set(userId, { report, at: Date.now() });
    const parts = [report.comment && "your note", `the last ${SNAPSHOT_TURNS} messages of this chat`, shots.length && (shots.length === 1 ? "your screenshot" : "your screenshots")].filter(Boolean);
    const what = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts.at(-1) : parts[0];
    return `This sends ${what} to Closedhand, so the problem can be found and fixed. Send it? Reply yes or no.`;
  } catch (e) {
    console.error("[bug] Report failed:", e.message);
    return "Couldn't put that report together. Try /bug again in a moment?";
  }
}

// Whether this message is the yes or no to a report waiting to be sent,
// without deciding anything: it goes straight through, not behind a reply
// still running (lib/fold-in.js).
function answersBugQuestion(userId, text) {
  const pending = waiting.get(userId);
  if (!pending || Date.now() - pending.at > ANSWER_MS) return false;
  const t = String(text || "").trim().toLowerCase();
  return SEND_YES.test(t) || SEND_NO.test(t);
}

// The yes or no after /bug. Only a bare answer within a few minutes counts;
// anything else means they moved on, and the report is dropped so a later
// "yes" to something else is never read as this. Synchronous decision (the
// caller is not async): null lets the message through, or a promise of the
// reply to send instead.
const SEND_YES = /^(yes|y|yep|yeah|yup|sure|ok|okay|send|send it|go ahead|please do)[.! ]*$/;
const SEND_NO = /^(no|n|nope|nah|don'?t|not now|cancel)[.! ]*$/;
function handleBugSendReply(userId, text) {
  const pending = waiting.get(userId);
  if (!pending) return null;
  const t = String(text || "").trim().toLowerCase();
  const yes = SEND_YES.test(t);
  const no = SEND_NO.test(t);
  if (Date.now() - pending.at > ANSWER_MS || (!yes && !no)) { waiting.delete(userId); return null; }
  if (no) { waiting.delete(userId); return Promise.resolve("Not sent."); }
  return sendReport(userId, pending);
}

const sending = new Map();
function sendReport(userId, pending) {
  if (!sending.has(userId)) sending.set(userId, sendOnce(userId, pending).finally(() => sending.delete(userId)));
  return sending.get(userId);
}
async function sendOnce(userId, pending) {
  try {
    const res = await fetch(INTAKE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.report), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`intake replied ${res.status}`);
    const accepted = await res.json();
    if (!accepted.ok || !accepted.id) throw new Error("intake did not acknowledge the report");
    waiting.delete(userId);
    await keepReceipt(userId, { id: accepted.id, receipt: accepted.receipt || null, comment: (pending.report.comment || "").slice(0, 100), at: pending.report.created_at });
    console.log(`[bug] ${accepted.id} sent to ${INTAKE_URL}`);
    const lost = Number.isInteger(accepted.screenshots) && accepted.screenshots < pending.report.screenshots.length ? " Some screenshots were too big to include." : "";
    return `Sent to Closedhand as report ${reportRef(accepted.id)}.${lost} I'll tell you when it's fixed.`;
  } catch (e) {
    console.error("[bug] send failed:", e.message);
    // Kept for another yes: a retry carries the same key, so it can't arrive twice.
    pending.at = Date.now();
    return "Couldn't reach Closedhand just now, so nothing was sent. Reply yes to try again.";
  }
}

// The receipts of sent reports, newest first, in the person's settings: the
// receipt keys are sealed like any stored secret.
async function keepReceipt(userId, entry) {
  const { encryptString } = require("../crypto-tokens");
  const store = ctx.activeUserStore;
  const kept = (store?.profile?.settings?.bug_receipts || []).filter(r => r.id !== entry.id);
  const next = [{ ...entry, receipt: entry.receipt ? encryptString(entry.receipt) : null }, ...kept].slice(0, RECEIPTS_KEPT);
  try { await require("./profile-settings").updateSettings(userId, { bug_receipts: next }, { store }); }
  catch (e) { console.error("[bug] receipt not kept:", e.message); }
}

async function outcome(entry) {
  const { decryptString } = require("../crypto-tokens");
  const receipt = entry.receipt ? decryptString(entry.receipt, "bug report receipt") : null;
  if (!receipt) return null;
  const res = await fetch(INTAKE_URL + "/status", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: entry.id, receipt }), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Could not check with Closedhand just now");
  return res.json();
}

// A report's reference, said when it is sent and again when it is fixed, so
// someone who sent several can tell which one is meant. It is the start of
// the report's id on closedhand.com, so it also finds the report there.
const reportRef = (id) => String(id || "").slice(0, 8);

// What the person is told when a report they sent is fixed: which report,
// by its reference, its day and the start of their note, the note that came back with the
// fix and, when a newer Closedhand is out, the one step that updates it here.
function fixedText(entry, note, howToUpdate = "") {
  const day = new Date(entry.at || Date.now()).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  let said = String(entry.comment || "").replace(/\s+/g, " ").trim();
  if (said.length > 80) said = said.slice(0, 80).replace(/\s+\S*$/, "") + "…";
  const which = said ? `the problem you reported on ${day} ("${said}")` : `the problem you reported on ${day}`;
  const ref = entry.id ? `report ${reportRef(entry.id)}, ` : "";
  return `Fixed: ${ref}${which}.${note ? " " + String(note).trim() : ""}${howToUpdate ? " " + howToUpdate : ""}`;
}

// Each sent report not yet told about is checked; a fixed one is told once,
// where the person gets Closedhand's other notices, and marked told.
async function checkOutcomes(userId) {
  const store = await UserStore.load(userId);
  const sent = store?.profile?.settings?.bug_receipts || [];
  const told = new Set();
  let howTo = null;
  for (const entry of sent.filter(r => !r.told && r.receipt)) {
    let o = null;
    try { o = await outcome(entry); } catch (_) { continue; }
    if (o?.status !== "resolved") continue;
    if (howTo === null) {
      const update = await require("./release-check").status();
      howTo = update.newer ? require("./release-check").howToUpdate(update.kind) : "";
    }
    if (await require("./connection-alert").tellAboutReport(userId, store, fixedText(entry, o.resolution_note, howTo))) told.add(entry.id);
  }
  if (!told.size) return 0;
  const next = sent.map(r => told.has(r.id) ? { ...r, told: new Date().toISOString() } : r);
  await require("./profile-settings").updateSettings(userId, { bug_receipts: next }, { store });
  return told.size;
}

function start() {
  const run = () => checkOutcomes(require("./admin").getAdminUserId()).catch(e => console.error("[bug] outcome check:", e.message));
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, CHECK_EVERY_MS).unref?.();
}

module.exports = { isBugReport, fileBugReport, stripCommand, handleBugSendReply, answersBugQuestion, reportRef, checkOutcomes, fixedText, start, _waiting: waiting };
