// lib/bug-reports.js — /bug, a zero-friction flag for anything that looked wrong.
//
// Most real bugs are noticed in normal use and then lost: by the time anyone
// looks, the chat has moved on and nobody can say what the screen showed. This
// captures the moment where it happened. Reports are worked through from
// scripts/bug-queue.js, which is what the session-start hook lists.
//
// Reports contain verbatim conversation content and screenshots. They are
// written with the service key into a table with RLS on and no policies,
// and read back only for the authenticated reporter.

const ctx = require("./context");
const { supabase, UserStore } = require("../user-store");

const BUG_PREFIX = /^\s*\/bug\b[:,\s]*/i;
const BUGS_PREFIX = /^\s*\/bugs(?:\s|$)/i;
// A platform prefixes a reply with the message it answers ("[replying to
// ...]\n/bug ..."), which is exactly how people flag a bad answer. The command
// is read past that prefix, and the quoted message rides along in the comment.
const REPLY_PREFIX = /^\s*\[replying to ([^\]]*)\]\s*/i;
// Five turns: enough to see what went wrong, small enough that people are
// willing to send it on. The comment carries the rest.
const SNAPSHOT_TURNS = 5;
// Where a self-host report goes when the person says yes to sending it. The
// hosted tier writes straight into the same table this posts to.
const INTAKE_URL = process.env.BUG_INTAKE_URL || "https://closedhand.com/api/bug-intake";
const SEND_OFFER_MS = 15 * 60 * 1000;
const MAX_TURN_CHARS = 1500;
const MAX_SCREENSHOTS = 4;

function isBugReport(text) {
  return typeof text === "string" && BUG_PREFIX.test(text.replace(REPLY_PREFIX, ""));
}

function stripCommand(text) {
  const m = String(text || "").match(REPLY_PREFIX);
  const body = String(text || "").replace(REPLY_PREFIX, "").replace(BUG_PREFIX, "").trim();
  return m ? `${body} (in reply to: ${m[1].trim()})`.trim() : body;
}

// Self-host runs against the person's own database, where a report is seen by
// nobody unless they send it on. Hosted reports already land in the queue.
function isSelfHost() {
  return process.env.DB_DRIVER === "pg" || (!!process.env.DATABASE_URL && !process.env.SUPABASE_URL);
}
// Maintainer mode is an explicit, operator-controlled setting. A chat message
// or an ordinary user's admin role cannot enable access to the development queue.
function isMaintainer() {
  return isSelfHost() && process.env.BUG_REPORT_MODE === "maintainer";
}

function appVersion() {
  let v = "";
  try { v = require("../package.json").version || ""; } catch (_) {}
  const sha = (process.env.CLOSEDHAND_SHA || "").slice(0, 7);
  return sha ? `${v}+${sha}` : v;
}
// One opaque id per install, so reports from the same machine group together
// without saying anything about who it is.
function installId() {
  const seed = ctx.activeUserStore?.profile?.created_at || "";
  if (!seed) return null;
  return require("crypto").createHash("sha256").update(String(seed)).digest("hex").slice(0, 12);
}

// Conversation entries are a mix of plain strings and Anthropic-shaped block
// arrays (tool_use, tool_result, images). Flatten to something readable and
// drop base64: the screenshot is stored once, and a transcript full of image
// data is unreadable and enormous.
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        parts.push(block.text || "");
        break;
      case "image":
        parts.push("[image]");
        break;
      case "document":
        parts.push(`[document: ${block.source?.filename || "file"}]`);
        break;
      case "tool_use":
        parts.push(`[called ${block.name} ${JSON.stringify(block.input || {}).substring(0, 300)}]`);
        break;
      case "tool_result": {
        const inner = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map(b => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ")
            : JSON.stringify(block.content ?? "");
        parts.push(`[result${block.is_error ? " (error)" : ""}: ${String(inner).substring(0, 400)}]`);
        break;
      }
      default:
        parts.push(`[${block.type}]`);
    }
  }
  return parts.filter(Boolean).join("\n");
}

async function snapshotTurns(userId) {
  // In-memory first: it holds the turn that just went wrong, which may not have
  // been saved yet. Falling back to the store covers being called from a timer
  // (WhatsApp batches images that way) where the context bubble has moved on.
  let turns = [];
  try {
    turns = ctx.store?.conversations?.[userId] || [];
  } catch (_) {
    turns = [];
  }
  if (turns.length === 0) {
    try {
      const store = await UserStore.load(userId);
      turns = store.conversations || [];
    } catch (e) {
      console.error("[bug] Could not load conversation:", e.message);
    }
  }

  return turns.slice(-SNAPSHOT_TURNS).map(m => ({
    role: m.role,
    content: flattenContent(m.content).substring(0, MAX_TURN_CHARS),
  }));
}

function imagesFrom(fileData) {
  if (!fileData) return [];
  if (fileData.isMultiImage && Array.isArray(fileData.images)) {
    return fileData.images
      .map(img => ({
        buffer: img.buffer || (img.base64 ? Buffer.from(img.base64, "base64") : null),
        mediaType: img.mediaType || "image/jpeg",
      }))
      .filter(i => i.buffer);
  }
  const buffer = fileData.buffer || (fileData.base64 ? Buffer.from(fileData.base64, "base64") : null);
  if (!buffer) return [];
  return [{ buffer, mediaType: fileData.mediaType || "application/octet-stream" }];
}

function extFor(mediaType) {
  const map = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
  return map[mediaType] || "bin";
}

/**
 * File a report and return the line to send back to the user.
 * Never throws: a failure here must not also swallow the user's message.
 */
async function fileBugReport({ userId, text, fileData, platform, chatId }) {
  try {
    const comment = stripCommand(text);
    const transcript = await snapshotTurns(userId);

    const { data: row, error } = await supabase
      .from("bug_reports")
      .insert({
        user_id: userId,
        platform: platform || null,
        chat_id: chatId ? String(chatId) : null,
        comment: comment || null,
        transcript,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[bug] Insert failed:", error.message);
      return "Couldn't save that report. Please try /bug again in a moment.";
    }

    // Screenshots go up after the row exists so they can be named by report id.
    const images = imagesFrom(fileData).slice(0, MAX_SCREENSHOTS);
    let savedShots = 0;
    if (images.length > 0) {
      const stored = [];
      for (let i = 0; i < images.length; i++) {
        const path = `${userId}/bug/${row.id}_${i}.${extFor(images[i].mediaType)}`;
        const { error: upErr } = await supabase.storage
          .from("attachments")
          .upload(path, images[i].buffer, { contentType: images[i].mediaType, upsert: true });
        if (upErr) console.error("[bug] Screenshot upload failed:", upErr.message);
        else stored.push({ path, mediaType: images[i].mediaType });
      }
      if (stored.length > 0) {
        const { error: shotErr } = await supabase.from("bug_reports").update({ screenshots: stored }).eq("id", row.id);
        if (shotErr) console.error("[bug] Screenshot record failed:", shotErr.message);
        else savedShots = stored.length;
      }
    }

    console.log(`[bug] ${row.id} from ${userId} on ${platform}: "${comment.substring(0, 80)}" (${transcript.length} turns, ${images.length} screenshots)`);

    const ref = String(row.id).substring(0, 8);
    const shotNote = images.length > savedShots
      ? ` Saved ${savedShots} of ${images.length} screenshots.`
      : savedShots ? ` ${savedShots === 1 ? "Screenshot" : "Screenshots"} saved.` : "";
    if (isMaintainer()) {
      return `Saved in your development queue.${shotNote} Reference ${ref}. Use /bugs to check the outcome.`;
    }
    if (isSelfHost()) {
      // The report is on their machine and nobody else can see it. Offer the
      // last hop, say exactly what it carries, and wait for a yes.
      await saveSetting(userId, "bug_send_pending", { id: row.id, at: Date.now() });
      const carries = `your description, up to ${SNAPSHOT_TURNS} recent conversation entries${savedShots ? " and the saved screenshots" : ""}, plus the app version and an installation identifier`;
      return `Saved here.${shotNote} Reference ${ref}.\n\nSend this to ClosedHand to check? It includes ${carries}. Reply yes to send or no to keep it local. Use /bugs ${ref} to review the text first.`;
    }
    return `Sent to ClosedHand to check.${shotNote} Reference ${ref}. Your description and up to ${SNAPSHOT_TURNS} recent conversation entries are included. Use /bugs to check the outcome.`;
  } catch (e) {
    console.error("[bug] Report failed:", e.message);
    return "Couldn't save that report. Try again in a moment?";
  }
}

async function saveSetting(userId, key, value) {
  const store = ctx.activeUserStore;
  if (!store || !store.profile) return;
  const settings = { ...(store.profile.settings || {}) };
  if (value === null || value === undefined) delete settings[key]; else settings[key] = value;
  store.profile.settings = settings;
  const { error } = await supabase.from("profiles").update({ settings }).eq("id", userId);
  if (error) console.error("[bug] settings write failed:", error.message);
}

// The yes or no after a self-host report. Only a bare answer within a few
// minutes of the offer counts; anything else means they moved on, and the
// offer is dropped so a later "yes" to something else is never read as this.
// Synchronous decision (the caller is not async): returns null to let the
// message through, or a promise of the reply to send instead.
function handleBugSendReply(userId, text) {
  if (!isSelfHost() || isMaintainer()) return null;
  const pending = ctx.activeUserStore?.profile?.settings?.bug_send_pending;
  if (!pending || !pending.id) return null;
  const t = String(text || "").trim().toLowerCase();
  const yes = /^(yes|y|yep|yeah|yup|sure|ok|okay|send|send it|go ahead|please do)[.! ]*$/.test(t);
  const no = /^(no|n|nope|nah|keep it|don'?t|keep it here|not now)[.! ]*$/.test(t);
  const fresh = Date.now() - (pending.at || 0) < SEND_OFFER_MS;
  const clear = saveSetting(userId, "bug_send_pending", null).catch(() => {});
  if (!fresh || (!yes && !no)) return null;
  if (no) return clear.then(() => "Kept here only. Use /bugs to review or delete the local copy.");
  return clear.then(() => sendReport(userId, pending.id));
}

const sendingReports = new Map();
function sendReport(userId, reportId) {
  const key = userId + ":" + reportId;
  if (!sendingReports.has(key)) {
    sendingReports.set(key, sendReportOnce(userId, reportId).finally(() => sendingReports.delete(key)));
  }
  return sendingReports.get(key);
}
async function sendReportOnce(userId, reportId) {
  try {
    const { data: r, error } = await supabase.from("bug_reports").select("*").eq("id", reportId).eq("user_id", userId).single();
    if (error || !r) return "Couldn't find that report any more, so nothing was sent.";
    if (r.sent_at) return "This report has already been sent to ClosedHand. Use /bugs to check the outcome.";
    const receipt = r.remote_receipt || { submission_key: require("crypto").randomBytes(32).toString("hex") };
    const { error: receiptErr } = await supabase.from("bug_reports").update({ remote_receipt: receipt }).eq("id", reportId).eq("user_id", userId);
    if (receiptErr) throw new Error(receiptErr.message);
    const screenshots = [];
    for (const s of (r.screenshots || []).slice(0, MAX_SCREENSHOTS)) {
      try {
        const { data: blob } = await supabase.storage.from("attachments").download(s.path);
        if (!blob) continue;
        const buf = Buffer.from(await blob.arrayBuffer());
        screenshots.push({ mediaType: s.mediaType, base64: buf.toString("base64") });
      } catch (e) { console.error("[bug] screenshot read failed:", e.message); }
    }
    const body = {
      submission_key: receipt.submission_key,
      install_id: installId(),
      app_version: appVersion(),
      platform: r.platform,
      comment: r.comment,
      transcript: (r.transcript || []).slice(-SNAPSHOT_TURNS),
      screenshots,
      created_at: r.created_at,
    };
    const res = await fetch(INTAKE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`intake replied ${res.status}`);
    const accepted = await res.json();
    if (!accepted.ok || !accepted.id) throw new Error("intake did not acknowledge the report");
    const { error: markErr } = await supabase.from("bug_reports").update({
      sent_at: new Date().toISOString(),
      remote_receipt: { ...receipt, id: accepted.id, token: accepted.receipt || null },
    }).eq("id", reportId).eq("user_id", userId);
    if (markErr) console.error("[bug] sent_at write failed:", markErr.message);
    console.log(`[bug] ${reportId} sent to ${INTAKE_URL}`);
    const shotWarning = Number.isInteger(accepted.screenshots) && accepted.screenshots < (r.screenshots || []).length
      ? " Some screenshots could not be included; your saved copies are still here." : "";
    return markErr
      ? "Sent to ClosedHand to check, but I couldn't save the receipt here. Use /bugs send " + reportId.slice(0, 8) + " to recover it."
      : "Sent to ClosedHand to check. Your local copy stays here. Use /bugs to check the outcome." + shotWarning;
  } catch (e) {
    console.error("[bug] send failed:", e.message);
    return `Couldn't confirm delivery to ClosedHand. Your report is saved here. Retry with /bugs send ${String(reportId).slice(0, 8)}.`;
  }
}

async function refreshReport(userId, report) {
  const receipt = report.remote_receipt;
  if (!isSelfHost() || !receipt?.id || !receipt?.token || report.status === "resolved") return report;
  const res = await fetch(INTAKE_URL + "/status", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: receipt.id, receipt: receipt.token }), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Could not check with ClosedHand just now");
  const update = await res.json();
  if (!["open", "resolved"].includes(update.status)) throw new Error("Invalid report status");
  const patch = { status: update.status, resolution_note: update.resolution_note || null, resolved_at: update.resolved_at || null };
  const { error } = await supabase.from("bug_reports").update(patch).eq("id", report.id).eq("user_id", userId);
  if (error) throw new Error(error.message);
  return { ...report, ...patch };
}

// These commands are scoped to the authenticated reporter, never a supplied user ID.
function handleBugCommand(userId, text) {
  if (typeof text !== "string" || !BUGS_PREFIX.test(text)) return null;
  return bugCommand(userId, text).catch(e => {
    console.error("[bug] command failed:", e.message);
    return "Couldn't read your reports just now. Please try /bugs again in a moment.";
  });
}
async function bugCommand(userId, text) {
  const [, action = "", arg = ""] = text.trim().split(/\s+/);
  const help = "Use /bugs to list reports or /bugs <reference> to review one." + (isSelfHost()
    ? " Use /bugs send <reference> to send it to ClosedHand, or /bugs delete <reference> to delete your local copy." : "");
  const prefix = ["send", "delete"].includes(action.toLowerCase()) ? arg : action;
  if (prefix && !/^[a-f0-9-]{8,36}$/i.test(prefix)) return help;
  let query = supabase.from("bug_reports").select("*").eq("user_id", userId);
  if (prefix.length === 36) query = query.eq("id", prefix.toLowerCase());
  const { data, error } = await query.order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  if (!data?.length) return "You haven't saved any bug reports yet. Use /bug followed by what went wrong.";
  if (!prefix) {
    const rows = await Promise.all(data.slice(0, 10).map(async r => {
      let stale = false;
      try { r = await refreshReport(userId, r); } catch (_) { stale = true; }
      const status = r.status === "resolved" ? "Resolved" : r.sent_at || !isSelfHost() ? "Sent to ClosedHand" : isMaintainer() ? "In your development queue" : "Saved locally";
      return `${r.id.slice(0, 8)}: ${status}${stale ? " (update unavailable)" : ""}${r.comment ? " · " + r.comment.slice(0, 100) : ""}${r.resolution_note ? "\n" + r.resolution_note : ""}`;
    }));
    return rows.join("\n\n") + "\n\n" + help;
  }
  const matches = data.filter(r => r.id.startsWith(prefix.toLowerCase()));
  if (matches.length !== 1) return matches.length ? "That reference matches more than one report. Use the full reference." : "No report of yours matches that reference.";
  let r = matches[0];
  if (action.toLowerCase() === "send") {
    if (!isSelfHost()) return "This report is already with ClosedHand. Use /bugs to check the outcome.";
    return sendReport(userId, r.id);
  }
  if (action.toLowerCase() === "delete") {
    if (!isSelfHost()) return "Hosted reports are already with ClosedHand. Contact ClosedHand to request removal.";
    const shots = (r.screenshots || []).map(s => s.path);
    if (shots.length) {
      const { error: shotErr } = await supabase.storage.from("attachments").remove(shots);
      if (shotErr) throw new Error(shotErr.message);
    }
    const { error: deleteErr } = await supabase.from("bug_reports").delete().eq("id", r.id).eq("user_id", userId);
    if (deleteErr) throw new Error(deleteErr.message);
    return r.sent_at ? "Deleted your local copy. The copy you sent to ClosedHand is still with the team." : "Deleted your local report and its saved screenshots.";
  }
  let statusNote = "";
  try { r = await refreshReport(userId, r); } catch (_) { statusNote = "\nCouldn't check for an update from ClosedHand just now."; }
  const conversation = (r.transcript || []).map(t => `${t.role}: ${t.content}`).join("\n\n");
  return `Report ${r.id.slice(0, 8)} (${r.status})${statusNote}\n${r.comment || "No description added."}\n\n${conversation}\n\n${(r.screenshots || []).length} saved screenshots.${r.resolution_note ? "\nOutcome: " + r.resolution_note : ""}\n\n${help}`;
}

module.exports = { isBugReport, fileBugReport, stripCommand, handleBugSendReply, sendReport, isSelfHost, isMaintainer, handleBugCommand, refreshReport };
