// The last year of every mailbox is read into the cache and index, not just
// the newest few hundred messages: archived and sent mail too, never spam or
// trash, indexed from its own words with no summary. Invented mail and
// stand-in services only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const DAY = 86400000;

function withModules(stubs, target) {
  const saved = {};
  for (const [rel, exports] of Object.entries(stubs)) {
    const p = require.resolve(rel);
    saved[p] = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  const t = require.resolve(target);
  delete require.cache[t];
  const mod = require(target);
  return { mod, restore() { for (const [p, m] of Object.entries(saved)) { if (m) require.cache[p] = m; else delete require.cache[p]; } delete require.cache[t]; } };
}

// data_cache and mail_coverage, enough of the query builder for mail-history.
function fakeDb(tables) {
  return {
    from(name) {
      const rows = tables[name] || (tables[name] = []);
      const filters = [];
      const q = {
        select() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        async maybeSingle() { return { data: rows.find((r) => filters.every((f) => f(r))) || null, error: null }; },
        async upsert(row) {
          const at = rows.findIndex((r) => r.user_id === row.user_id && r.source === row.source);
          if (at >= 0) rows[at] = { ...rows[at], ...row }; else rows.push({ done: false, ...row });
          return { error: null };
        },
        then(resolve) { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(resolve); },
      };
      return q;
    },
  };
}

// A Gmail account holding `mail` ({ id, at, spam? }), answering list and
// get. Like Gmail, its order is only roughly newest first: neighbours are
// swapped, across page edges too.
function fakeGmail(mail, asked) {
  return async (method, url) => {
    const u = new URL(url);
    const one = /\/messages\/([^/?]+)$/.exec(u.pathname);
    if (one) { asked.gets.push(one[1]); const m = mail.find((x) => x.id === one[1]); return { id: m.id, internalDate: String(m.at) }; }
    const q = u.searchParams.get('q');
    asked.lists.push(q);
    const before = Number(/before:(\d+)/.exec(q)[1]) * 1000, after = Number(/after:(\d+)/.exec(q)[1]) * 1000;
    const hits = mail.filter((m) => !m.spam && m.at < before && m.at > after).sort((a, b) => b.at - a.at);
    for (let i = 4; i + 1 < hits.length; i += 5) [hits[i], hits[i + 1]] = [hits[i + 1], hits[i]];
    const from = Number(u.searchParams.get('pageToken') || 0), size = Number(u.searchParams.get('maxResults'));
    return { messages: hits.slice(from, from + size).map((m) => ({ id: m.id })), ...(from + size < hits.length ? { nextPageToken: String(from + size) } : {}) };
  };
}

function setup(mail, cached = []) {
  const tables = { data_cache: cached.map((m) => ({ user_id: 'u1', source: 'gmail', type: 'email', external_id: m.id, received_at: new Date(m.at).toISOString() })), mail_coverage: [] };
  const asked = { lists: [], gets: [] }, stored = [], indexed = [];
  const { mod, restore } = withModules({
    '../user-store': { supabase: fakeDb(tables) },
    '../lib/services/google': { googleApiRequest: fakeGmail(mail, asked) },
    '../lib/services/data-sync': {
      gmailItem: (d, account) => ({ external_id: d.id, id: d.id, account, date: new Date(Number(d.internalDate)).toUTCString() }),
      upsertCacheItems: async (userId, source, type, items) => { stored.push(...items); for (const i of items) tables.data_cache.push({ user_id: userId, source, type, external_id: i.external_id, received_at: new Date(i.date).toISOString() }); },
    },
    '../lib/services/usi': { indexSyncedCacheRows: async (userId, type, rows) => { indexed.push(...rows); } },
  }, '../lib/services/mail-history');
  return { mod, restore, tables, asked, stored, indexed };
}

const now = Date.now();
const mailbox = () => {
  const mail = [];
  for (let i = 0; i < 500; i++) mail.push({ id: 'm' + i, at: now - i * 0.9 * DAY - 3600000 });
  mail.push({ id: 'junk', at: now - 5 * DAY, spam: true });
  return mail;
};

test('a mailbox is read back a year, newest first, keeping only what is not cached yet', async () => {
  const mail = mailbox();
  const recent = mail.filter((m) => !m.spam && m.at > now - 20 * DAY);
  const s = setup(mail, recent);
  try {
    const done = await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.equal(done, true);
    const want = mail.filter((m) => !m.spam && m.at > now - 365 * DAY && !recent.includes(m)).map((m) => m.id).sort();
    assert.deepEqual(s.stored.map((i) => i.external_id).sort(), want, 'everything in the year that was missing, and nothing older');
    assert.ok(s.stored.every((i) => i.from_history), 'marked, so it is indexed without a summary');
    assert.deepEqual(s.indexed.map((r) => r.external_id).sort(), want, 'and indexed');
    assert.equal(s.asked.gets.filter((id) => recent.some((m) => m.id === id)).length, 0, 'mail already cached is never fetched again');
    assert.ok(s.asked.lists.every((q) => /-in:spam -in:trash -in:drafts/.test(q)), 'spam, trash and drafts are left out');
    const cov = s.tables.mail_coverage[0];
    assert.equal(cov.done, true);
    assert.ok(Math.abs(Date.parse(cov.complete_since) - (now - 365 * DAY)) < 60000, 'complete back to the year');
  } finally { s.restore(); }
});

test('a run that runs out of time keeps how far it got, and the next carries on', async () => {
  const mail = mailbox();
  const s = setup(mail);
  try {
    let pages = 0;
    const deadlineAfterTwoPages = { valueOf: () => (pages++ < 2 ? Date.now() + 60000 : 0) };
    const done = await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: deadlineAfterTwoPages });
    assert.equal(done, false);
    const cov = s.tables.mail_coverage[0];
    assert.equal(cov.done, false);
    const reached = Date.parse(cov.complete_since);
    assert.ok(reached < now - 60 * DAY && reached > now - 365 * DAY, 'claimed up to the second page');
    const kept = new Set(s.stored.map((i) => i.external_id));
    assert.ok(mail.filter((m) => !m.spam && m.at >= reached).every((m) => kept.has(m.id)), 'everything newer than what is claimed is kept');
    assert.ok(cov.walk_next, 'and where to carry on');
    await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.equal(s.tables.mail_coverage[0].done, true);
    assert.equal(new Set(s.stored.map((i) => i.external_id)).size, s.stored.length, 'nothing read twice');
  } finally { s.restore(); }
});

test('an email that fails to come stops the walk there, to be read again', async () => {
  const mail = mailbox();
  const s = setup(mail);
  try {
    const google = require.cache[require.resolve('../lib/services/google')].exports;
    const real = google.googleApiRequest;
    let failing = true;
    google.googleApiRequest = async (method, url) => { if (failing && /\/messages\/m150\?/.test(url)) throw new Error('Google API 403: insufficient permission'); return real(method, url); };
    await assert.rejects(s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 }), /could not be read/);
    assert.equal(s.tables.mail_coverage[0].done, false);
    failing = false;
    await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.ok(s.stored.some((i) => i.external_id === 'm150'), 'read on the next run');
    assert.equal(s.tables.mail_coverage[0].done, true);
  } finally { s.restore(); }
});

test('a read Gmail turns away is tried again, and an email deleted meanwhile is skipped', async () => {
  const mail = mailbox();
  const s = setup(mail);
  try {
    const google = require.cache[require.resolve('../lib/services/google')].exports;
    const real = google.googleApiRequest;
    const tries = {};
    google.googleApiRequest = async (method, url) => {
      const id = (/\/messages\/([^/?]+)\?/.exec(url) || [])[1];
      if (id === 'm40' && (tries.m40 = (tries.m40 || 0) + 1) === 1) throw new Error('Google API 429: rateLimitExceeded');
      if (id === 'm41') throw new Error('Google API 404: Requested entity was not found.');
      return real(method, url);
    };
    const done = await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.equal(done, true, 'neither stops the walk');
    assert.equal(tries.m40, 2);
    assert.ok(s.stored.some((i) => i.external_id === 'm40'));
    assert.ok(!s.stored.some((i) => i.external_id === 'm41'));
  } finally { s.restore(); }
});

test("Gmail's per-minute quota is waited out, while a refusal of another kind is not tried again", async () => {
  const { mod, restore } = setup(mailbox());
  try {
    const quota = new Error('Google API 403: {"error":{"code":403,"message":"Quota exceeded for quota metric \'Total Query Cost\' and limit \'Units per minute\'"}}');
    assert.match(quota.message, mod.TRY_AGAIN);
    let n = 0;
    assert.deepEqual(await mod.fetchOnce(async () => { if (n++ < 2) throw quota; return { id: 'x' }; }, [1, 1]), { id: 'x' });
    const denied = new Error('Google API 403: {"error":{"code":403,"message":"Request had insufficient authentication scopes."}}');
    assert.doesNotMatch(denied.message, mod.TRY_AGAIN);
    await assert.rejects(mod.fetchOnce(async () => { throw denied; }, [1, 1]), /insufficient/);
  } finally { restore(); }
});

test('mail archived before the regular sync saw it is caught by the next sweep', async () => {
  const mail = mailbox();
  const s = setup(mail);
  try {
    await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    mail.push({ id: 'archived-at-once', at: Date.now() - 3600000 });
    s.tables.mail_coverage[0].swept_at = new Date(Date.now() - 7 * 3600000).toISOString();
    await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.ok(s.stored.some((i) => i.external_id === 'archived-at-once'));
  } finally { s.restore(); }
});

test('an IMAP mailbox is read back too: inbox, sent and archive, newest first, missing ones only', async () => {
  const folders = { INBOX: [], Sent: [], Archive: [] };
  for (let i = 0; i < 260; i++) folders[['INBOX', 'Sent', 'Archive'][i % 3]].push({ uid: 1000 - i, at: now - i * 1.6 * DAY });
  const tables = { data_cache: [{ user_id: 'u1', source: 'imap', type: 'email', external_id: 'imap-7-1000', received_at: new Date(now).toISOString() }], mail_coverage: [] };
  const stored = [];
  const client = {
    open: null,
    async list() { return [{ path: 'Sent', specialUse: '\\Sent' }, { path: 'Archive', specialUse: '\\Archive' }, { path: 'All', specialUse: '\\All' }]; },
    async mailboxOpen(path) { this.open = path; return { exists: folders[path].length, uidValidity: 7 }; },
    async search({ since, before }) { return folders[this.open].filter((m) => m.at >= since.getTime() && m.at < before.getTime()).map((m) => m.uid); },
    async *fetch(uids) { for (const uid of uids) yield { uid, source: JSON.stringify(folders[this.open].find((m) => m.uid === uid)) }; },
  };
  const imap = {
    imapSettings: () => ({ email: 'robin@example.org' }),
    withClient: async (settings, fn) => fn(client),
    idPrefix: (key, v) => (key === 'inbox' ? `imap-${v}-` : `imap-${key}-${v}-`),
    parseMessage: async (source) => JSON.parse(source),
    itemFromParsed: (id, parsed, account, label) => ({ external_id: id, id, account, labels: [label], date: new Date(parsed.at).toISOString() }),
    HISTORY_FOLDERS: [{ key: 'inbox', label: 'INBOX' }, { key: 'sent', label: 'SENT', specialUse: '\\Sent' }, { key: 'archive', label: 'ARCHIVE', specialUse: '\\Archive' }],
  };
  const { mod, restore } = withModules({
    '../user-store': { supabase: fakeDb(tables) },
    '../lib/services/imap-mail': imap,
    '../lib/services/data-sync': { upsertCacheItems: async (userId, source, type, items) => { stored.push(...items); for (const i of items) tables.data_cache.push({ user_id: userId, source, type, external_id: i.external_id, received_at: i.date }); } },
    '../lib/services/usi': { indexSyncedCacheRows: async () => {} },
  }, '../lib/services/mail-history');
  try {
    const store = { getConnection: (k) => (k === 'imap' ? { metadata: { email: 'robin@example.org' } } : null) };
    assert.equal(await mod.runAccount({ reader: 'imap', userId: 'u1', store, serviceKey: 'imap', source: 'imap', deadline: Date.now() + 60000 }), true);
    const want = Object.values(folders).flat().filter((m) => m.at > now - 365 * DAY).length - 1;
    assert.equal(stored.length, want, 'every message of the year in the three folders, but the one already cached');
    assert.ok(stored.some((i) => i.external_id.startsWith('imap-sent-7-')) && stored.some((i) => i.external_id.startsWith('imap-archive-7-')));
    assert.ok(stored.every((i) => i.from_history));
    assert.equal(tables.mail_coverage[0].done, true);
  } finally { restore(); }
});

test('older mail is indexed from its own words and never summarised, and a year of it is kept', () => {
  const usi = read('lib/services/usi.js');
  assert.match(usi, /_raw: !!d\.from_history,/);
  assert.match(usi, /if \(item\._skipEnrich \|\| item\._raw\) return;/);
  assert.match(usi, /enrichment_level: enriched \? "full" : item\._raw \? "raw" : "basic",/);
  assert.match(usi, /\.eq\("enrichment_level", "basic"\)/, 'the summary pass reads only basic');
  assert.match(read('lib/services/email-record.js'), /from_history: !!f\.from_history,/);
  const sync = read('lib/services/data-sync.js');
  assert.equal((sync.match(/evictOldItems\(userId, sourceTag, "email", 5000, require\("\.\/mail-history"\)\.horizon\(\)\);/g) || []).length, 2, 'Gmail and Outlook keep their year');
  assert.match(sync, /if \(keepSince\) gone = gone\.lt\("received_at", keepSince\);/);
  assert.match(sync, /require\("\.\/mail-history"\)\.kick\(userId, store\);/);
  assert.match(read('migrations/061_mail_coverage.sql'), /CREATE TABLE IF NOT EXISTS mail_coverage/);
  assert.match(read('lib/services/mail-history.js'), /\{ quiet: true \}\);/, 'older mail never shows as new mail');
  assert.match(usi, /const progress = opts\.quiet \? async \(\) => \{\} : upsertProgress;/);
});

test('the dashboard says which kind of reading is going on', () => {
  const dash = read('webapp/views/dashboard.html');
  assert.match(dash, /'<div class="row"><span>Your older mail<\/span><b>back to ' \+ olderTo \+ '<\/b><\/div>'/, 'a row on the first-read card');
  assert.match(dash, /'Reading your last year of mail, now back to ' \+ olderTo/, 'one quiet line after it');
  assert.match(dash, /'Reading ' \+ routine\.join\(' and '\) \+ ', so recall stays up to date'/, 'new mail keeps its own line');
  assert.match(dash, /fetch\('\/api\/index\/older-mail'/);
  assert.match(read('webapp/server.js'), /app\.get\("\/api\/index\/older-mail"/);
});
