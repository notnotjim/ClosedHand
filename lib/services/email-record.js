// lib/services/email-record.js: one shape for every email Closedhand keeps.
//
// Gmail, Outlook and IMAP each map their own format into this, so everything
// that reads mail (search, the dashboard's flight and booking cards, files,
// drafts) reads it one way and never needs to know which mailbox it came
// from. A field a mailbox can't supply is present and empty, never missing:
// IMAP mail has no web address, so its webLink is null and the dashboard
// opens Closedhand's own copy instead. SHAPE marks records written in this
// form; each sync brings its older records up to it.

const SHAPE = 2;

function gmailWebLink(account, threadId) {
  if (!threadId) return null;
  return "https://mail.google.com/mail/" + (account ? "?authuser=" + encodeURIComponent(account) : "") + "#all/" + encodeURIComponent(threadId);
}

function emailRecord(f) {
  const id = String(f.id || f.external_id || "");
  return {
    external_id: id,
    id,
    threadId: f.threadId ? String(f.threadId) : id,
    account: f.account || null,
    from: f.from || "",
    to: f.to || "",
    subject: f.subject || "",
    date: f.date || "",
    messageId_header: f.messageId_header || "",
    snippet: f.snippet || "",
    body: f.body || "",
    labels: Array.isArray(f.labels) ? f.labels : [],
    // Explicit rather than inferred from labels: an unsent draft is an
    // outstanding action, not a message that happened.
    is_draft: !!f.is_draft,
    draft_id: f.draft_id || null,
    // A draft's version where the mailbox gives one apart from its id
    // (Outlook's changeKey), so a rewrite can tell whether the person edited
    // it since. Gmail's message id and an IMAP draft's number change on every
    // save, so they are their own version.
    version: f.version || null,
    attachments: (Array.isArray(f.attachments) ? f.attachments : []).map((a) => ({
      filename: a.filename || "attachment",
      mimeType: a.mimeType || "application/octet-stream",
      size: a.size || 0,
      attachmentId: String(a.attachmentId),
      inline: !!a.inline,
    })),
    webLink: f.webLink || null,
    // Read back from older mail (mail-history.js): indexed from its own words,
    // never summarised.
    from_history: !!f.from_history,
    shape: SHAPE,
  };
}

module.exports = { emailRecord, gmailWebLink, SHAPE };
