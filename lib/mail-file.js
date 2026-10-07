// lib/mail-file.js: the files attached to an email ClosedHand keeps, for the
// dashboard's flight and booking cards.
//
// The webapp can't use the bot's mail code (the two services share only the
// database), so it asks here over the bot's own HTTP server, with the same
// short-lived signed token the web chat uses. Each mail source fetches its
// own way: Gmail and Outlook through their APIs (with the account's sign-in
// kept fresh), IMAP by downloading the message again.

const { supabase } = require("./db");

const SOURCE = /^(gmail|outlook)(_[a-z0-9]+)?$|^imap$/;
// Gmail ids are hex, Outlook's are base64-like, IMAP's imap-<folder>-<n>-<n>.
const ID = /^[A-Za-z0-9_=+\/.-]{3,300}$/;

function failure(message, status) { return Object.assign(new Error(message), { status }); }
const mailFiles = (data) => (data?.attachments || []).filter((a) => !a.inline && a.attachmentId != null && a.filename);

async function cachedEmail(userId, source, id) {
  if (!SOURCE.test(String(source)) || !ID.test(String(id))) throw failure("That file link isn't valid.", 400);
  const { data, error } = await supabase.from("data_cache").select("data").eq("user_id", userId)
    .eq("type", "email").eq("source", source).eq("external_id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw failure("That email is no longer in what ClosedHand keeps.", 404);
  return data.data || {};
}

// Run with this person's store active, as the mail helpers expect.
function asUser(userId, work) {
  const ctx = require("./context");
  return ctx.runWithInheritedContext(async () => {
    const store = await require("../user-store").UserStore.load(userId);
    ctx.activeUserStore = store;
    ctx.activeUserId = userId;
    return work(store);
  });
}

// The files on one email, as every mailbox's cached copy lists them
// (lib/services/email-record.js).
async function listMailFiles(userId, source, id) {
  return mailFiles(await cachedEmail(userId, source, id));
}

// The bytes of the nth file on one email.
async function mailFile(userId, source, id, n) {
  if (!Number.isInteger(n) || n < 0) throw failure("That file link isn't valid.", 400);
  const file = (await listMailFiles(userId, source, id))[n];
  if (!file) throw failure("That file is no longer in your mail.", 404);
  const buffer = await asUser(userId, async (store) => source === "imap"
    ? (await require("./services/imap-mail").fetchImapAttachment(store, id, file.attachmentId)).buffer
    : require("./services/usi").fetchAttachmentBuffer(userId, source, id, file.attachmentId, file.filename));
  if (!buffer) throw failure("Your mail didn't send the file. Try again, or sign in to that account again on the dashboard.", 502);
  return { buffer, filename: file.filename, mimeType: file.mimeType || "application/octet-stream" };
}

// GET /internal/mail-file on the bot, for the webapp.
function register(app) {
  const { verifyToken } = require("./web-chat-ws");
  const guard = (handler) => async (req, res) => {
    const userId = verifyToken(req.get("x-closedhand-token"));
    if (!userId) return res.status(401).json({ error: "Not allowed" });
    try { await handler(userId, req, res); }
    catch (e) {
      if (!e.status) console.error("[mail-file]", e.message);
      res.status(e.status || 500).json({ error: e.status ? e.message : "Could not open that file. Try again." });
    }
  };
  app.get("/internal/mail-file", guard(async (userId, req, res) => {
    const f = await mailFile(userId, String(req.query.source || ""), String(req.query.id || ""), Number(req.query.n));
    res.set({ "Content-Type": f.mimeType, "X-File-Name": encodeURIComponent(f.filename) });
    res.send(f.buffer);
  }));
}

module.exports = { register, listMailFiles, mailFile, mailFiles, SOURCE, ID };
