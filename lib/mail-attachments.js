// lib/mail-attachments.js — the itinerary is in the attachment, not the mail.
//
// A forwarded booking often carries nothing in its body ("Your reservation
// itinerary is attached") and everything in a PDF. The flight and booking
// scanners read bodies, so a VietJet itinerary forwarded by a spouse was
// invisible to them. This reads the readable attachments of an email whose
// body is thin, extracts their text once (read-only: nothing is saved to the
// person's files), and keeps it on the cached email row so later passes do
// not fetch it again. Runs inside the user's context, like the scanners.

const ctx = require("./context");
const { supabase } = require("./db");

const THIN_BODY = 400;
const MAX_TEXT = 6000;
const MAX_BYTES = 5 * 1024 * 1024;
const READABLE = /\.(pdf|txt|docx?|ics|html?)$/i;

function nameOf(a) { return String(a.filename || a.name || ""); }
function idOf(a) { return a.attachmentId || a.attachment_id || a.id; }

// Text of one attachment, read-only. Same account walk as the flight scan:
// the message only exists on the account that holds it, the source tag is
// often the primary, and the wrong account fails fast.
async function readAttachmentText(email, att) {
  const { extractAttachmentText } = require("./services/usi");
  const name = nameOf(att);
  try {
    if (email.source === "imap") {
      const { fetchImapAttachment } = require("./services/imap-mail");
      const { buffer } = await fetchImapAttachment(ctx.activeUserStore, email.id, idOf(att));
      return (await extractAttachmentText(buffer, name)) || "";
    }
    if (/^gmail(_|$)/.test(email.source || "")) {
      const { googleApiRequest, serviceKeyForSourceTag, listGoogleAccounts } = require("./services/google");
      const firstKey = serviceKeyForSourceTag(email.source);
      const keys = [firstKey, ...listGoogleAccounts(ctx.activeUserStore).map((a) => a.serviceKey).filter((k) => k !== firstKey)];
      for (const key of keys) {
        try {
          const data = await googleApiRequest("GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${email.id}/attachments/${idOf(att)}`, null, null, key);
          if (data && data.data) return (await extractAttachmentText(Buffer.from(data.data, "base64url"), name)) || "";
        } catch (_) { /* wrong account: try the next */ }
      }
      return "";
    }
    if (/^outlook(_|$)/.test(email.source || "")) {
      const { microsoftApiRequest, msServiceKeyForSourceTag } = require("./services/microsoft");
      const data = await microsoftApiRequest("GET", `https://graph.microsoft.com/v1.0/me/messages/${email.id}/attachments/${idOf(att)}/$value`, null, null, msServiceKeyForSourceTag(email.source));
      const buf = Buffer.isBuffer(data) ? data : typeof data === "string" ? Buffer.from(data, "base64") : null;
      return buf ? (await extractAttachmentText(buf, name)) || "" : "";
    }
  } catch (e) {
    console.log(`[mail-attachments] could not read ${name || idOf(att)}: ${e.message}`);
  }
  return "";
}

// Returns the text of the email's readable attachments (cached), or "".
// A forwarded PDF is often flagged inline by the mail provider, so the flag
// is not a reason to skip it: the name says whether it is readable.
async function attachmentTextFor(userId, email) {
  const atts = Array.isArray(email.attachments) ? email.attachments : [];
  const readable = atts.filter((a) => a && idOf(a) && READABLE.test(nameOf(a)) && (a.size || 0) < MAX_BYTES).slice(0, 2);
  if (!readable.length) return "";
  let row = null;
  try {
    const r = await supabase.from("data_cache").select("id, data").eq("user_id", userId).eq("external_id", email.id).limit(1).maybeSingle();
    row = r.data || null;
    if (row && row.data && typeof row.data.attachment_text === "string" && row.data.attachment_text) return row.data.attachment_text;
  } catch (_) { /* no cache: read fresh */ }
  const parts = [];
  for (const a of readable) {
    const t = (await readAttachmentText(email, a)).replace(/\s+/g, " ").trim();
    if (t) parts.push(`[Attachment ${nameOf(a)}] ${t.slice(0, MAX_TEXT)}`);
  }
  const text = parts.join("\n\n").slice(0, MAX_TEXT);
  // Only a successful read is remembered: an empty one is retried next pass.
  if (text && row) {
    const { error } = await supabase.from("data_cache").update({ data: { ...row.data, attachment_text: text } }).eq("id", row.id);
    if (error) console.error("[mail-attachments] cache write failed:", error.message);
  }
  return text;
}

// The body a scanner should read: the mail's own text, plus its attachments
// when the mail itself says little.
async function bodyForScan(userId, email, cap = 2200) {
  const body = String(email.summary || email.body || "");
  if (body.trim().length >= THIN_BODY) return body.slice(0, cap);
  const extra = await attachmentTextFor(userId, email);
  return (body + (extra ? "\n\n" + extra : "")).slice(0, Math.max(cap, 5000));
}

module.exports = { attachmentTextFor, bodyForScan, readAttachmentText, THIN_BODY };
