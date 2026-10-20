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
// nothing else (closedhand-com/lib/bugs.js), so /bugs can say when it is fixed.

const ctx = require("./context");
const { UserStore } = require("../user-store");

const BUG_PREFIX = /^\s*\/bug\b[:,\s]*/i;
const BUGS_PREFIX = /^\s*\/bugs(?:\s|$)/i;
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

// The yes or no after /bug. Only a bare answer within a few minutes counts;
// anything else means they moved on, and the report is dropped so a later
// "yes" to something else is never read as this. Synchronous decision (the
// caller is not async): null lets the message through, or a promise of the
// reply to send instead.
function handleBugSendReply(userId, text) {
  const pending = waiting.get(userId);
  if (!pending) return null;
  const t = String(text || "").trim().toLowerCase();
  const yes = /^(yes|y|yep|yeah|yup|sure|ok|okay|send|send it|go ahead|please do)[.! ]*$/.test(t);
  const no = /^(no|n|nope|nah|don'?t|not now|cancel)[.! ]*$/.test(t);
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
    return `Sent to Closedhand. Reference ${accepted.id.slice(0, 8)}.${lost} Use /bugs to see when it's fixed.`;
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

// /bugs: the reports this person sent, and what came of each.
function handleBugCommand(userId, text) {
  if (typeof text !== "string" || !BUGS_PREFIX.test(text)) return null;
  return listReports(userId).catch(e => {
    console.error("[bug] /bugs failed:", e.message);
    return "Couldn't check your reports just now. Try /bugs again in a moment.";
  });
}
async function listReports(userId) {
  let sent = ctx.activeUserStore?.profile?.settings?.bug_receipts;
  if (!sent) {
    try { sent = (await UserStore.load(userId))?.profile?.settings?.bug_receipts; } catch (_) {}
  }
  if (!sent?.length) return "You haven't sent any bug reports. Send /bug, with what went wrong or on its own, and Closedhand will ask before sending.";
  const rows = await Promise.all(sent.slice(0, 10).map(async (r) => {
    let state = "Sent", note = "";
    try {
      const o = await outcome(r);
      if (o?.status === "resolved") { state = "Fixed"; note = o.resolution_note ? "\n" + o.resolution_note : ""; }
    } catch (_) { state = "Sent (couldn't check for news just now)"; }
    return `${r.id.slice(0, 8)}: ${state}${r.comment ? " · " + r.comment : ""}${note}`;
  }));
  return rows.join("\n\n");
}

module.exports = { isBugReport, fileBugReport, stripCommand, handleBugSendReply, handleBugCommand, _waiting: waiting };
