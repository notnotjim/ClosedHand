// lib/services/imap-mail.js — the zero-project email tier.
//
// One app password, no Google Cloud project: IMAP reads the mailbox into the
// same data_cache/vector pipeline as the Gmail API sync (identical row shape,
// so recall, triage and search are shared), SMTP sends, and drafts are
// appended to the Drafts mailbox. Aliases the user declared in config can be
// sent from; there is no discovery endpoint on this tier by nature.
//
// The connection row: service "imap", tokens { app_password } (encrypted),
// metadata { email }, config { imap_host, imap_port, smtp_host, smtp_port,
// aliases: [] }. Known providers get host presets so setup is email+password.

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");

const SYNC_BATCH = 50;      // full messages downloaded per cycle, per folder
const BODY_CAP = 10000;

// Same slice of the mailbox the Gmail API sync takes (see data-sync.js:
// 500 inbox, 300 sent, 100 drafts), so a self-hosted install and a hosted one
// answer from the same material. Reading only INBOX, and only 200 of it, meant
// recall covered a few days on a busy account and never saw a sent message.
// Folders are found by their IMAP special-use flag rather than by name,
// because "Sent" is [Gmail]/Sent Mail on Gmail, Sent Items on Outlook, and
// whatever the user's language calls it elsewhere.
const FOLDERS = [
  { key: "inbox",  label: "INBOX", specialUse: "\\Inbox",  window: 500 },
  { key: "sent",   label: "SENT",  specialUse: "\\Sent",   window: 300 },
  { key: "drafts", label: "DRAFT", specialUse: "\\Drafts", window: 100 },
];

const HOST_PRESETS = {
  "gmail.com":      { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 },
  "googlemail.com": { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 },
  "outlook.com":    { imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp-mail.outlook.com", smtp_port: 587 },
  "hotmail.com":    { imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp-mail.outlook.com", smtp_port: 587 },
  "live.com":       { imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp-mail.outlook.com", smtp_port: 587 },
  "icloud.com":     { imap_host: "imap.mail.me.com", imap_port: 993, smtp_host: "smtp.mail.me.com", smtp_port: 587 },
  "me.com":         { imap_host: "imap.mail.me.com", imap_port: 993, smtp_host: "smtp.mail.me.com", smtp_port: 587 },
  "yahoo.com":      { imap_host: "imap.mail.yahoo.com", imap_port: 993, smtp_host: "smtp.mail.yahoo.com", smtp_port: 465 },
  "fastmail.com":   { imap_host: "imap.fastmail.com", imap_port: 993, smtp_host: "smtp.fastmail.com", smtp_port: 465 },
};

function presetsForEmail(email) {
  const domain = String(email || "").split("@")[1]?.toLowerCase() || "";
  return HOST_PRESETS[domain] || null;
}

function imapSettings(conn) {
  const email = conn.metadata?.email;
  const preset = presetsForEmail(email) || {};
  const cfg = conn.config || {};
  const s = {
    email,
    password: conn.tokens?.app_password,
    imap_host: cfg.imap_host || preset.imap_host,
    imap_port: Number(cfg.imap_port || preset.imap_port || 993),
    smtp_host: cfg.smtp_host || preset.smtp_host,
    smtp_port: Number(cfg.smtp_port || preset.smtp_port || 465),
    aliases: Array.isArray(cfg.aliases) ? cfg.aliases : [],
  };
  if (!s.email || !s.password || !s.imap_host) return null;
  return s;
}

async function withClient(settings, fn) {
  const client = new ImapFlow({
    host: settings.imap_host,
    port: settings.imap_port,
    secure: true,
    auth: { user: settings.email, pass: settings.password },
    logger: false,
  });
  await client.connect();
  try { return await fn(client); }
  finally { try { await client.logout(); } catch (_) {} }
}

// Resolve one of our folder keys to a real mailbox path on this server.
async function folderPath(client, folderKey) {
  if (folderKey === "inbox") return "INBOX";
  const folder = FOLDERS.find((f) => f.key === folderKey);
  if (!folder) return null;
  const boxes = await client.list().catch(() => []);
  return (boxes.find((b) => b.specialUse === folder.specialUse) || {}).path || null;
}

// The id a message gets in data_cache. INBOX keeps the original bare form so
// existing installs do not re-fetch everything they already hold.
function idPrefix(folderKey, uidValidity) {
  return folderKey === "inbox" ? `imap-${uidValidity}-` : `imap-${folderKey}-${uidValidity}-`;
}

// Map one parsed message into the exact cached-email shape syncGmail writes,
// so every downstream reader, writer and indexer treats IMAP rows identically.
function itemFromParsed(externalId, parsed, accountEmail, mailboxLabel) {
  const text = parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
  const refs = Array.isArray(parsed.references) ? parsed.references : (parsed.references ? [parsed.references] : []);
  return {
    external_id: externalId,
    id: externalId,
    // No server-side threads on IMAP: the thread key is the root Message-ID
    // from References, falling back to the message's own.
    threadId: refs[0] || parsed.messageId || externalId,
    from: parsed.from?.text || "",
    to: parsed.to?.text || "",
    subject: parsed.subject || "",
    date: (parsed.date ? new Date(parsed.date) : new Date()).toISOString(),
    messageId_header: parsed.messageId || "",
    snippet: text.substring(0, 200),
    body: text.substring(0, BODY_CAP),
    labels: [mailboxLabel],
    is_draft: false,
    draft_id: null,
    account: accountEmail,
    attachments: (parsed.attachments || []).map((a, i) => ({
      filename: a.filename || `attachment-${i + 1}`,
      mimeType: a.contentType || "application/octet-stream",
      size: a.size || (a.content ? a.content.length : 0),
      attachmentId: String(i),
      inline: a.contentDisposition === "inline",
    })),
  };
}

// Sync the INBOX into data_cache. Cheap scan of recent UIDs first, full
// download only for messages not already cached, same economy as syncGmail's
// "N new of M total".
async function syncImapMail(userId, userStore) {
  const conn = userStore.getConnection("imap");
  if (!conn) return;
  const settings = imapSettings(conn);
  if (!settings) return;

  const { supabase } = require("../../user-store");
  // Paginate: a select caps at 1000 rows, and a silently truncated cache set
  // makes everything past it look new, so every cycle re-downloads messages it
  // already has. Same trap the vector indexer hit (cost incident 2026-07-19).
  const cached = new Set();
  for (let from = 0; ; from += 1000) {
    const { data: page } = await supabase
      .from("data_cache").select("external_id")
      .eq("user_id", userId).eq("source", "imap").eq("type", "email")
      .range(from, from + 999);
    for (const r of page || []) cached.add(r.external_id);
    if (!page || page.length < 1000) break;
  }

  const newItems = await withClient(settings, async (client) => {
    const boxes = await client.list().catch(() => []);
    const items = [];

    for (const folder of FOLDERS) {
      const path = folder.key === "inbox"
        ? "INBOX"
        : (boxes.find((b) => b.specialUse === folder.specialUse) || {}).path;
      if (!path) continue; // provider has no such folder; skip rather than guess

      let mailbox;
      try { mailbox = await client.mailboxOpen(path, { readOnly: true }); }
      catch (e) { console.log(`[data-sync] IMAP cannot open ${path}: ${e.message}`); continue; }
      if (!mailbox.exists) continue;

      const prefix = idPrefix(folder.key, mailbox.uidValidity);

      // Newest `window` messages by sequence; collect their UIDs cheaply.
      const firstSeq = Math.max(1, mailbox.exists - folder.window + 1);
      const uids = [];
      for await (const msg of client.fetch(`${firstSeq}:*`, { uid: true })) {
        if (!cached.has(prefix + msg.uid)) uids.push(msg.uid);
      }
      const toFetch = uids.slice(-SYNC_BATCH);
      if (!toFetch.length) continue;

      for await (const msg of client.fetch(toFetch, { uid: true, source: true }, { uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const item = itemFromParsed(prefix + msg.uid, parsed, settings.email, folder.label);
          if (folder.key === "drafts") { item.is_draft = true; item.draft_id = String(msg.uid); }
          items.push(item);
        } catch (e) {
          console.log(`[data-sync] IMAP parse failed for uid ${msg.uid} in ${path}: ${e.message}`);
        }
      }
    }
    return items;
  });

  if (newItems.length) {
    const { upsertCacheItems } = require("./data-sync");
    await upsertCacheItems(userId, "imap", "email", newItems);
  }
  console.log(`[data-sync] IMAP(${settings.email}): synced ${newItems.length} new messages for ${userId}`);
  return newItems.length;
}

// Resolve the From address: the account itself, or a declared alias. Never an
// arbitrary address; an undeclared alias is refused rather than silently
// rewritten by the provider.
function resolveFrom(settings, fromAlias) {
  if (!fromAlias || !String(fromAlias).trim()) return settings.email;
  const want = String(fromAlias).trim().toLowerCase();
  const match = settings.aliases.find((a) => String(a).toLowerCase() === want)
    || settings.aliases.find((a) => String(a).toLowerCase().includes(want));
  if (!match) throw new Error(`"${fromAlias}" is not a declared alias for ${settings.email}. Declared: ${settings.aliases.join(", ") || "none"}. Add it in the email connection settings first.`);
  return match;
}

async function sendSmtpMail(userStore, { to, cc, subject, body, from_alias, attachments = [], inReplyTo, references }) {
  const conn = userStore.getConnection("imap");
  const settings = conn && imapSettings(conn);
  if (!settings) throw new Error("Email (IMAP) is not connected");
  const from = resolveFrom(settings, from_alias);

  const transport = nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port,
    secure: settings.smtp_port === 465,
    auth: { user: settings.email, pass: settings.password },
  });
  const info = await transport.sendMail({
    from,
    to,
    cc: cc || undefined,
    subject,
    text: body,
    inReplyTo: inReplyTo || undefined,
    references: references && references.length ? references : undefined,
    attachments: attachments.map((a) => ({ filename: a.fileName, content: a.buffer, contentType: a.mimeType })),
  });
  return { messageId: info.messageId, from };
}

// Save an unsent draft by appending to the Drafts mailbox (the IMAP-native
// equivalent of drafts.create). The Drafts mailbox is found by special-use
// flag, falling back to the common names.
async function appendImapDraft(userStore, { to, cc, subject, body, from_alias, attachments = [], inReplyTo, references }) {
  const conn = userStore.getConnection("imap");
  const settings = conn && imapSettings(conn);
  if (!settings) throw new Error("Email (IMAP) is not connected");
  const from = resolveFrom(settings, from_alias);

  const MailComposer = require("nodemailer/lib/mail-composer");
  const raw = await new MailComposer({
    from,
    to,
    cc: cc || undefined,
    subject,
    text: body,
    inReplyTo: inReplyTo || undefined,
    references: references && references.length ? references : undefined,
    attachments: attachments.map((a) => ({ filename: a.fileName, content: a.buffer, contentType: a.mimeType })),
  }).compile().build();

  return withClient(settings, async (client) => {
    let draftsPath = null;
    for (const box of await client.list()) {
      if (box.specialUse === "\\Drafts") { draftsPath = box.path; break; }
    }
    if (!draftsPath) {
      const names = (await client.list()).map((b) => b.path);
      draftsPath = names.find((n) => /drafts/i.test(n)) || "Drafts";
    }
    await client.append(draftsPath, raw, ["\\Draft"]);
    return { drafts_mailbox: draftsPath, from };
  });
}

// Re-download one message and hand back a named attachment's bytes. IMAP has
// no per-part download id we persist, so the source is refetched and parsed;
// fine at attachment sizes and rare enough not to matter.
async function fetchImapAttachment(userStore, externalId, attachmentIndex) {
  const conn = userStore.getConnection("imap");
  const settings = conn && imapSettings(conn);
  if (!settings) throw new Error("Email (IMAP) is not connected");
  // Two id shapes: imap-<uidValidity>-<uid> for INBOX, and
  // imap-<folder>-<uidValidity>-<uid> for the others. Reading the folder back
  // out matters because a UID only means anything in the mailbox that issued
  // it, so opening INBOX for a sent message fetches the wrong mail or none.
  const m = String(externalId).match(/^imap-(?:([a-z]+)-)?\d+-(\d+)$/);
  if (!m) throw new Error("Not an IMAP message id");
  const folderKey = m[1] || "inbox";
  const uid = Number(m[2]);

  return withClient(settings, async (client) => {
    const path = await folderPath(client, folderKey);
    if (!path) throw new Error(`Mailbox for ${folderKey} not found`);
    await client.mailboxOpen(path, { readOnly: true });
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg?.source) throw new Error("Message no longer in the mailbox");
    const parsed = await simpleParser(msg.source);
    const att = (parsed.attachments || [])[Number(attachmentIndex)];
    if (!att) throw new Error("No attachment at that position");
    return { buffer: att.content, mediaType: att.contentType || "application/octet-stream", filename: att.filename || "attachment" };
  });
}


// Search the WHOLE mailbox on the server, not just the synced window.
//
// The Gmail tier does this with messages?q= when the cache misses, which is how
// a booking made before the window still gets found. IMAP SEARCH is the same
// idea and also runs server-side, so a self-hosted install can answer about a
// six-month-old confirmation without embedding six months of mail. Results
// carry the ids the sync would have given them, so attachments still fetch.
async function searchImapMailbox(userStore, query, { limit = 5, folderKeys = ["inbox", "sent"] } = {}) {
  const conn = (userStore || require("../context").activeUserStore)?.getConnection?.("imap");
  const settings = conn && imapSettings(conn);
  if (!settings || !String(query || "").trim()) return [];

  return withClient(settings, async (client) => {
    const out = [];
    for (const key of folderKeys) {
      if (out.length >= limit) break;
      const path = await folderPath(client, key);
      if (!path) continue;
      let mailbox;
      try { mailbox = await client.mailboxOpen(path, { readOnly: true }); }
      catch (_) { continue; }
      if (!mailbox.exists) continue;

      let uids = [];
      try { uids = (await client.search({ text: String(query) }, { uid: true })) || []; }
      catch (e) { console.log(`[imap] search failed in ${path}: ${e.message}`); continue; }
      if (!uids.length) continue;

      const prefix = idPrefix(key, mailbox.uidValidity);
      const label = (FOLDERS.find((f) => f.key === key) || {}).label || "INBOX";
      // Newest matches first: SEARCH returns ascending UIDs.
      for await (const msg of client.fetch(uids.slice(-limit), { uid: true, source: true }, { uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const item = itemFromParsed(prefix + msg.uid, parsed, settings.email, label);
          item.source = "imap"; // readers key attachment handling off this
          out.push(item);
        } catch (_) { /* skip an unparseable message rather than lose the search */ }
      }
    }
    return out.slice(0, limit);
  });
}

// Live credential check used by the setup form: connect, open INBOX, done.
async function verifyImapLogin(settings) {
  return withClient(settings, async (client) => {
    const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
    return { ok: true, messages: mailbox.exists };
  });
}

function isImapConnected(userStore) {
  return !!(userStore || require("../context").activeUserStore)?.connections?.imap;
}

module.exports = { syncImapMail, searchImapMailbox, sendSmtpMail, appendImapDraft, fetchImapAttachment, verifyImapLogin, imapSettings, presetsForEmail, isImapConnected };
