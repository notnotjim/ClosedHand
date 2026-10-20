// lib/services/mail-history.js: the last year of every mailbox, read into the
// cache and index, so recall finds older mail by meaning.
//
// The regular sync (data-sync.js) lists each mailbox's newest 500 inbox and
// 300 sent messages. For someone who gets 1,600 emails a month that reaches
// back three weeks, and anything older could only be found by its exact words
// through a live search: a question about "my Osaka gym" found nothing in
// that gym's Japanese emails, which only their brand name matches. This walks
// each mailbox back a page at a time, newest first, to a year, and keeps every
// email (archived and sent too, never spam, trash or drafts) in the same cache
// and index as the rest. Older mail is indexed from its own words with no
// summary (the summary pass skips it), so a year of mail costs no AI use: it
// costs disk (about 25 KB an email) and some hours of the computer's spare time.
//
// mail_coverage records, per mailbox, how far back the copy is complete; search
// reads it to know whether the copy is the answer or the mailbox must be asked
// too (data-sync.js cacheCovers). Each run first walks again the stretch since
// its last sweep, for mail archived before the regular sync listed it, then
// carries on back. Runs are started by each sync cycle and one runs at a time
// per person.
const { supabase } = require("../../user-store");

const HORIZON_DAYS = 365;
const PAGE = 100;
const RUN_MS = 20 * 60000;
const SWEEP_MS = 6 * 3600000;
const FETCHES_AT_ONCE = 8;

const horizon = (now = Date.now()) => new Date(now - HORIZON_DAYS * 86400000).toISOString();
const iso = (ms) => new Date(ms).toISOString();

async function coverage(userId, source) {
  const { data } = await supabase.from("mail_coverage").select("complete_since, swept_at, done, walk_before, walk_next").eq("user_id", userId).eq("source", source).maybeSingle();
  return data || null;
}
async function saveCoverage(userId, source, patch) {
  const { error } = await supabase.from("mail_coverage").upsert({ user_id: userId, source, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id,source" });
  if (error) throw new Error(`coverage not saved: ${error.message}`);
}

// When each of these is already cached: id -> ms.
async function cachedTimes(userId, source, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("data_cache").select("external_id, received_at")
      .eq("user_id", userId).eq("source", source).eq("type", "email").in("external_id", ids.slice(i, i + 200));
    if (error) throw new Error(`cache read failed: ${error.message}`);
    for (const r of data || []) out.set(r.external_id, r.received_at ? Date.parse(r.received_at) : NaN);
  }
  return out;
}

// An Outlook mailbox's folder ids by their well-known names.
const _folders = new Map();

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => { if (active >= n || !queue.length) return; active++; const { fn, resolve } = queue.shift(); fn().then(resolve, () => resolve(null)).finally(() => { active--; next(); }); };
  return (fn) => new Promise((resolve) => { queue.push({ fn, resolve }); next(); });
}

// One page of a mailbox's mail older than `before` and newer than `after`:
// { items (the ones not cached yet), newest (ms, or null for an empty page),
// next (where the following page starts, or null at the end) }. Pages come in
// the mailbox's own order, which for Gmail is only roughly newest first, so a
// stretch is walked by the mailbox's own page tokens, never by dates: those
// list every email once whatever the order.
const READERS = {
  async gmail({ userId, store, serviceKey, source, before, after, next }) {
    const { googleApiRequest } = require("./google");
    const { gmailItem } = require("./data-sync");
    const q = `before:${Math.floor(before / 1000)} after:${Math.floor(after / 1000)} -in:spam -in:trash -in:drafts -in:chats`;
    const list = await googleApiRequest("GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${PAGE}&q=${encodeURIComponent(q)}${next ? "&pageToken=" + encodeURIComponent(next) : ""}`, null, store, serviceKey);
    const ids = (list.messages || []).map((m) => m.id);
    const cached = await cachedTimes(userId, source, ids);
    const account = store?.getConnection?.(serviceKey)?.metadata?.email || null;
    const limit = limiter(FETCHES_AT_ONCE);
    const todo = ids.filter((id) => !cached.has(id));
    const details = (await Promise.all(todo.map((id) =>
      limit(() => googleApiRequest("GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, null, store, serviceKey))))).filter(Boolean);
    // A page is kept whole or not at all: moving past an email that failed to
    // come would leave it out for good. The next run reads the page again.
    if (details.length < todo.length) throw new Error(`${todo.length - details.length} of ${todo.length} emails could not be read; trying again next run`);
    const times = [...cached.values(), ...details.map((d) => Number(d.internalDate))].filter(Number.isFinite);
    return { items: details.map((d) => ({ ...gmailItem(d, account), from_history: true })), newest: times.length ? Math.max(...times) : null, next: list.nextPageToken || null };
  },
  async outlook({ userId, store, serviceKey, source, before, after, next }) {
    const { microsoftApiRequest } = require("./microsoft");
    const { outlookItem, OUTLOOK_FIELDS } = require("./data-sync");
    const key = `${userId}:${serviceKey}`;
    if (!_folders.has(key)) {
      const found = {};
      for (const name of ["inbox", "sentitems", "junkemail", "deleteditems", "drafts"]) {
        const f = await microsoftApiRequest("GET", `https://graph.microsoft.com/v1.0/me/mailFolders/${name}?$select=id`, null, store, serviceKey).catch(() => null);
        if (f?.id) found[f.id] = name;
      }
      _folders.set(key, found);
    }
    const folders = _folders.get(key);
    const filter = `receivedDateTime lt ${iso(before)} and receivedDateTime gt ${iso(after)}`;
    const url = next || `https://graph.microsoft.com/v1.0/me/messages?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime desc&$top=${PAGE}&${OUTLOOK_FIELDS.replace("$select=id,", "$select=id,parentFolderId,")}`;
    const list = await microsoftApiRequest("GET", url, null, store, serviceKey);
    const msgs = list?.value || [];
    const times = msgs.map((m) => Date.parse(m.receivedDateTime)).filter(Number.isFinite);
    const cached = await cachedTimes(userId, source, msgs.map((m) => m.id));
    const account = store?.getConnection?.(serviceKey)?.metadata?.email || null;
    const keep = msgs.filter((m) => !cached.has(m.id) && !["junkemail", "deleteditems", "drafts"].includes(folders[m.parentFolderId]));
    const label = (m) => ({ inbox: "INBOX", sentitems: "SENT" })[folders[m.parentFolderId]] || "ARCHIVE";
    return { items: keep.map((m) => ({ ...outlookItem(m, label(m), account), from_history: true })), newest: times.length ? Math.max(...times) : null, next: list?.["@odata.nextLink"] || null };
  },
};

// Walks a stretch page by page, keeping and indexing what isn't cached, from
// `next` when resuming. Stops at `deadline`; after each page,
// onPage({ next, newest }). Returns true when the whole stretch is done.
async function walk({ reader, userId, store, serviceKey, source, before, after, next = null, deadline, onPage }) {
  const { upsertCacheItems } = require("./data-sync");
  for (;;) {
    if (Date.now() > deadline) return false;
    const page = await READERS[reader]({ userId, store, serviceKey, source, before, after, next });
    if (page.items.length) {
      await upsertCacheItems(userId, source, "email", page.items);
      const now = new Date().toISOString();
      await require("./usi").indexSyncedCacheRows(userId, "email", page.items.map((i) => ({ external_id: String(i.external_id), source, data: i, synced_at: now })));
    }
    if (!page.next) return true;
    next = page.next;
    if (onPage) await onPage({ next, newest: page.newest });
  }
}

// One mailbox's share of a run: the stretch since the last sweep again, then
// on back toward the year. While a walk is part way, complete_since claims
// only up to the newest email of the page just read, since the mailbox's order
// is rough and an email older than that may still be to come.
async function runAccount({ reader, userId, store, serviceKey, source, deadline }) {
  const started = Date.now();
  const floor = Date.parse(horizon(started));
  let cov = await coverage(userId, source);
  if (!cov) {
    cov = { complete_since: iso(started), swept_at: iso(started), done: false, walk_before: iso(started), walk_next: null };
    await saveCoverage(userId, source, cov);
  } else if (Date.parse(cov.swept_at) < started - SWEEP_MS) {
    const swept = await walk({ reader, userId, store, serviceKey, source, before: started, after: Date.parse(cov.swept_at), deadline });
    if (!swept) return false;
    await saveCoverage(userId, source, { swept_at: iso(started) });
  }
  if (cov.done) return true;
  const before = Date.parse(cov.walk_before || cov.complete_since);
  let claim = Date.parse(cov.complete_since);
  let done;
  try {
    done = await walk({
      reader, userId, store, serviceKey, source, before, after: floor, next: cov.walk_next || null, deadline,
      onPage: async ({ next, newest }) => {
        if (newest != null) claim = Math.min(claim, newest);
        await saveCoverage(userId, source, { walk_before: iso(before), walk_next: next, complete_since: iso(claim) });
      },
    });
  } catch (e) {
    // A page token the mailbox no longer accepts: the next run starts the
    // stretch again from what is claimed, reading cached pages cheaply.
    if (cov.walk_next) await saveCoverage(userId, source, { walk_before: cov.complete_since, walk_next: null });
    throw e;
  }
  if (done) await saveCoverage(userId, source, { complete_since: iso(floor), done: true, walk_before: null, walk_next: null });
  return done;
}

// Every mailbox of a person this reads: Gmail and Outlook, extra accounts too.
function mailboxes(store) {
  const out = [];
  try {
    const { listGoogleAccounts, loadGoogleTokens } = require("./google");
    for (const a of listGoogleAccounts(store)) if (loadGoogleTokens(store, a.serviceKey)) out.push({ reader: "gmail", serviceKey: a.serviceKey, source: a.primary ? "gmail" : "gmail_" + a.slug });
  } catch (_) {}
  try {
    const { listMicrosoftAccounts, isMicrosoftConnected } = require("./microsoft");
    for (const a of listMicrosoftAccounts(store)) if (isMicrosoftConnected(store, a.serviceKey)) out.push({ reader: "outlook", serviceKey: a.serviceKey, source: a.primary ? "outlook" : "outlook_" + a.slug });
  } catch (_) {}
  return out;
}

const _running = new Set();
// Starts a run for this person unless one is going. Returns at once.
function kick(userId, store) {
  if (_running.has(userId)) return;
  _running.add(userId);
  (async () => {
    const deadline = Date.now() + RUN_MS;
    for (const box of mailboxes(store)) {
      try {
        await runAccount({ ...box, userId, store, deadline });
      } catch (e) {
        console.log(`[mail-history] ${box.source}: ${e.message}`);
      }
    }
  })().finally(() => _running.delete(userId));
}

module.exports = { kick, runAccount, walk, horizon, HORIZON_DAYS, READERS };
