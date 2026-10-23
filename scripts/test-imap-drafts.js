// Drafts in other (IMAP) mail work as Gmail's do. IMAP cannot change a
// message, so a rewrite saves the new version to Drafts and removes the old,
// as mail apps do, keeping recipients, thread, files and the pictures placed
// in the wording (unless asked to drop them); a draft the person's mail app
// saved again is found, not overwritten; a send goes out as the draft stands,
// Bcc in the envelope only, and leaves Drafts. The server is a stand-in
// holding Drafts in memory; the mail itself is built and read by the real
// nodemailer and mailparser. (Tried once against a real IMAP server too.)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const drafts = new Map();
let nextUid = 1;
const header = (raw, name) => (String(raw).match(new RegExp(`^${name}:\\s*(.*)$`, "im")) || [])[1]?.trim() || "";
class FakeImap {
  async connect() {}
  async logout() {}
  async list() { return [{ path: "INBOX", specialUse: "\\Inbox" }, { path: "Drafts", specialUse: "\\Drafts" }]; }
  async getMailboxLock() { return { release() {} }; }
  async append(box, raw) { const uid = nextUid++; drafts.set(uid, Buffer.from(raw)); return { uid }; }
  async fetchOne(uid) { const source = drafts.get(Number(uid)); return source ? { uid: Number(uid), source } : false; }
  async search(q) {
    return [...drafts].filter(([, raw]) => (q.header ? header(raw, "Message-ID") === q.header["message-id"] : header(raw, "Subject") === q.subject)).map(([uid]) => uid);
  }
  async messageDelete(uid) { drafts.delete(Number(uid)); }
}
const sent = [];
const stand = (mod, exports) => { const file = require.resolve(mod); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
stand("imapflow", { ImapFlow: FakeImap });
const nodemailer = require("nodemailer");
stand("nodemailer", { ...nodemailer, createTransport: () => ({ sendMail: async (opts) => { sent.push(opts); return { messageId: "<sent-1@harbour.test>" }; } }) });
const imap = require(path.join(__dirname, "..", "lib", "services", "imap-mail"));
const { simpleParser } = require("mailparser");
const MailComposer = require("nodemailer/lib/mail-composer");

const conn = { metadata: { email: "ana@harbour.test" }, tokens: { app_password: "pw" }, config: { imap_host: "imap.harbour.test", smtp_host: "smtp.harbour.test" } };
const store = { getConnection: (k) => (k === "imap" ? conn : null) };
const parsed = (uid) => simpleParser(drafts.get(Number(uid)), { keepCidLinks: true });

test("a rewrite replaces the draft and keeps its recipients, thread, files and pictures", async () => {
  const raw = await new MailComposer({
    from: "ana@harbour.test", to: "mara@harbourpost.example", subject: "Court photos", inReplyTo: "<shoot-1@harbourpost.example>",
    text: "See the court", html: '<p>See the court</p><img src="cid:court-1">',
    attachments: [{ filename: "court.png", content: Buffer.from("png"), cid: "court-1", contentType: "image/png" }, { filename: "list.txt", content: Buffer.from("list") }],
  }).compile().build();
  const { uid } = await new FakeImap().append("Drafts", raw);

  const r1 = await imap.rewriteImapDraft(store, uid, { body: "See the court, now with nets" });
  assert.ok(r1.uid && r1.uid !== uid && !drafts.has(uid), "the new version replaces the old");
  const p1 = await parsed(r1.uid);
  assert.match(p1.html, /now with nets[\s\S]*<img src="cid:court-1">/, "the picture stays where the wording put it");
  assert.equal(p1.text.trim(), "See the court, now with nets");
  assert.deepEqual(p1.attachments.map((a) => a.filename).sort(), ["court.png", "list.txt"]);
  assert.equal(p1.to.text, "mara@harbourpost.example");
  assert.equal(p1.inReplyTo, "<shoot-1@harbourpost.example>", "still in its thread");
  assert.equal(r1.images_removed, 0);

  const r2 = await imap.rewriteImapDraft(store, r1.uid, { body: "No photos now", keep_inline_images: false });
  const p2 = await parsed(r2.uid);
  assert.ok(!/cid:/.test(p2.html || ""), "no picture in the wording");
  assert.deepEqual(p2.attachments.map((a) => a.filename), ["list.txt"], "the picture's file went with it, the other file stayed");
  assert.equal(r2.images_removed, 1);

  // A plain-text draft stays plain text.
  const plain = await imap.appendImapDraft(store, { to: "mara@harbourpost.example", subject: "Plain", body: "Hi" });
  const r3 = await imap.rewriteImapDraft(store, plain.uid, { body: "Hi again" });
  const p3 = await parsed(r3.uid);
  assert.equal(p3.headers.get("content-type").value, "text/plain");
  assert.ok(!p3.html);
  assert.equal(p3.text.trim(), "Hi again");
});

test("a draft the mail app saved again is found, never overwritten", async () => {
  const made = await imap.appendImapDraft(store, { to: "ellie@harbourpost.example", subject: "Prize bundle", body: "Sending Monday." });
  const id = (await parsed(made.uid)).messageId;
  // The person's mail app saves an edit as a new message and drops the old.
  const edited = await new MailComposer({ from: "ana@harbour.test", to: "ellie@harbourpost.example", subject: "Prize bundle", text: "Sending Monday, with the pavilion note.", messageId: id }).compile().build();
  await new FakeImap().append("Drafts", edited);
  drafts.delete(made.uid);
  assert.equal(await imap.rewriteImapDraft(store, made.uid, { body: "overwrite" }), null, "nothing under the old number to overwrite");
  const now = await imap.findImapDraft(store, { messageId: id, subject: "Prize bundle" });
  assert.equal(now.body, "Sending Monday, with the pavilion note.");
});

test("a draft is sent as it stands, Bcc kept off the headers, and leaves Drafts; no discards it", async () => {
  // Mail apps keep a draft's Bcc in it; it must survive a rewrite.
  const mail = new MailComposer({ from: "ana@harbour.test", to: "mara@harbourpost.example", bcc: "boss@harbour.test", subject: "Racquets", text: "Two land", html: "<p>Two land</p>" }).compile();
  mail.keepBcc = true;
  const first = await new FakeImap().append("Drafts", await mail.build());
  const { uid } = await imap.rewriteImapDraft(store, first.uid, { body: "Two land Monday.", body_html: "<p>Two land Monday.</p>" });
  assert.equal((await parsed(uid)).bcc.text, "boss@harbour.test", "a rewrite keeps the Bcc");
  const r = await imap.sendImapDraft(store, uid);
  assert.equal(r.to, "mara@harbourpost.example");
  const opts = sent.at(-1);
  assert.equal(opts.bcc, "boss@harbour.test", "Bcc goes to the envelope");
  assert.equal(opts.html, "<p>Two land Monday.</p>");
  assert.ok(!drafts.has(uid), "out of Drafts once sent");
  assert.equal(await imap.sendImapDraft(store, uid), null, "a draft no longer there sends nothing");

  const other = await imap.appendImapDraft(store, { to: "mara@harbourpost.example", subject: "Maybe", body: "Not sure" });
  await imap.deleteImapDraft(store, other.uid);
  assert.equal(await imap.readImapDraft(store, other.uid), null);
});
