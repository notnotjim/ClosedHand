// lib/mail-attachments.js — the itinerary is in the attachment, not the mail.
//
// A forwarded booking often carries nothing in its body ("Your reservation
// itinerary is attached") and everything in a PDF. The flight and booking
// scanners read bodies, so an airline itinerary forwarded by a family member was
// invisible to them. This reads the readable attachments of an email whose
// body is thin, extracts their text once (read-only: nothing is saved to the
// person's files), and keeps it on the cached email row so later passes do
// not fetch it again. Runs inside the user's context, like the scanners.

const ctx = require("./context");
const { supabase } = require("./db");

const THIN_BODY = 400;
const MAX_TEXT = 6000;
const MAX_BYTES = 5 * 1024 * 1024;
// Every kind lib/file-reader.js reads, except sound and video; pictures only
// when big enough to be a ticket or a scan rather than a logo.
const MEDIA = /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac|mp4|m4v|mov|webm|avi)$/i;
const PICTURE = /\.(jpe?g|png|gif|webp|tiff?|bmp|heic|heif)$/i;
const readableAttachment = (a) => !MEDIA.test(nameOf(a)) && (!PICTURE.test(nameOf(a)) || (a.size || 0) > 30 * 1024);

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
  const readable = atts.filter((a) => a && idOf(a) && readableAttachment(a) && (a.size || 0) < MAX_BYTES).slice(0, 2);
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

// Characters that print nothing are taken out (readable-text.js).
const { readable } = require("./readable-text");

// Search results carry a window of about 800 characters around the words
// searched for, not the email. A reader that takes facts out of an email (a
// stay's dates, a flight's new times) reads the whole cached email instead:
// the window around "booking" near the top of a confirmation stopped before
// its dates, and the reader made up a stay's dates and room. One-time codes
// stay hidden, as they are in search results.
async function withWholeBodies(userId, emails) {
  const ids = [...new Set((emails || []).map((e) => e && e.id).filter(Boolean))];
  if (!ids.length) return emails;
  const { data, error } = await supabase.from("data_cache").select("external_id, data").eq("user_id", userId).eq("type", "email").in("external_id", ids);
  if (error) { console.error("[mail] whole emails unavailable:", error.message); return emails; }
  const byId = new Map((data || []).map((row) => [row.external_id, row.data || {}]));
  const { redactEmail } = require("./otp-guard");
  return emails.map((e) => {
    const full = e && byId.get(e.id);
    if (!full || !full.body) return e;
    const whole = redactEmail({ ...e, body: full.body }, userId);
    return { ...e, body: whole.body, attachments: e.attachments && e.attachments.length ? e.attachments : full.attachments || e.attachments, date: e.date || full.date };
  });
}

// The body a scanner should read: the mail's own text, plus its attachments
// when the mail itself says little.
async function bodyForScan(userId, email, cap = 2200) {
  const body = readable(email.summary || email.body || "");
  if (body.trim().length >= THIN_BODY) return body.slice(0, cap);
  const extra = await attachmentTextFor(userId, email);
  return (body + (extra ? "\n\n" + extra : "")).slice(0, Math.max(cap, 5000));
}

module.exports = { attachmentTextFor, bodyForScan, readAttachmentText, readable, withWholeBodies, THIN_BODY };
