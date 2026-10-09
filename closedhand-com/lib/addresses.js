// Personal URLs (name.closedhand.ai). A copy of Closedhand asks for an
// address, its owner confirms it here after signing in and is shown a code,
// and the code typed into that copy finishes the request. The name is picked
// here (names.js) unless an older copy asks for one it chose; the owner can
// rename it later. A separate Cloudflare Worker builds the route, and the
// copy proves it answers at the new address before the address is marked
// ready. Only routing records live here.
//
// A copy that has just connected Microsoft mail through Closedhand's own
// Microsoft app can claim in one step instead (claim-microsoft): it passes
// on that sign-in, which is checked against Microsoft's keys.
//
// The sign-in that claims a personal URL is the owner's Closedhand account.
// Only its email is kept, with the address, and deleting it
// forgets the sign-in and takes the route down (deleteAccount).
const crypto = require('node:crypto');
const { encryptString, decryptString } = require('./crypto-tokens');
const { equal } = require('./session');
const { randomName, cleanName } = require('./names');
const { reportDnsRecords } = require('./alerts');
const { verifyMicrosoftToken } = require('./microsoft-token');
const { PROVIDERS } = require('./signin');
const { ownerFor } = require('./owners');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Names a person could mistake for a Closedhand or mail service address.
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'account', 'accounts', 'auth', 'login', 'mail', 'smtp', 'support', 'status', 'cloud', 'dashboard', 'closedhand',
  'autodiscover', 'autoconfig', 'mta-sts', 'webmail', 'imap', 'pop', 'mx', 'ns1', 'ns2', 'sso', 'id', 'help', 'security', 'docs', 'relay', 'assist',
  'billing', 'pay', 'secure', 'static', 'cdn', 'blog', 'open', 'keep', 'setup']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// Codes leave out characters that are easy to misread (0 and O, 1, I and L).
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');
const MAX_CODE_TRIES = 5;

function validHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname.endsWith('.closedhand.ai')) return false;
  const name = hostname.slice(0, -'.closedhand.ai'.length);
  // "xx--" is how lookalike international names are written, so it is out.
  return /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(name) && !/^..--/.test(name) && !RESERVED.has(name);
}

// A Cloudflare tunnel token is base64 JSON naming its account ("a") and
// tunnel ("t"). One for any other tunnel is refused.
function tokenTunnel(token) {
  try { return JSON.parse(Buffer.from(token, 'base64').toString('utf8')).t || null; } catch (_) { return null; }
}

// The copy's answer to the connection check is a few dozen bytes; stop
// reading long before a large one could matter.
async function smallJson(response, max = 2048) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return null; }
}

// A copy of Closedhand signs its requests with "Bearer <install id>.<secret>".
// It is known by its secret alone: the ID it states proves nothing, so
// knowing a copy's ID never lets anyone take its place.
function installation(req) {
  const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  return match ? { secret: match[2], secret_hash: hash(match[2]) } : null;
}

// A ticket carries a naming request from the copy to its owner's browser.
// It names the copy (by the hash of its secret, never the secret) and the
// address asked for, and is good for thirty minutes.
function ticketFor(request, secret, now = Date.now()) {
  const text = Buffer.from(JSON.stringify({ ...request, version: 3, expires: now + 30 * 60000 })).toString('base64url');
  return text + '.' + crypto.createHmac('sha256', secret).update('phone-pair:' + text).digest('hex');
}
function readTicket(ticket, secret) {
  if (typeof ticket !== 'string' || ticket.length > 1000) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
  if (!equal(parts[1], crypto.createHmac('sha256', secret).update('phone-pair:' + parts[0]).digest('hex'))) return null;
  try {
    const t = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return t.version === 3 && /^[a-f0-9]{64}$/.test(t.secret_hash) && validHostname(t.hostname) &&
      Number.isInteger(t.port) && t.port >= 1024 && t.port <= 65535 && typeof t.expires === 'number' &&
      (t.auto === undefined || t.auto === true) ? t : null;
  } catch (_) { return null; }
}

class Refusal extends Error {}

// A name is taken when an address has it, or when it is somebody else's
// old name or held name that has not been released yet. A held name with
// no owner (its account was deleted) is nobody's, so it is taken for all.
async function nameTaken(db, hostname, ownerId = null) {
  const found = await db.query(
    `SELECT 1 FROM addresses WHERE hostname = $1
     UNION ALL SELECT 1 FROM retired_names WHERE hostname = $1 AND owner_id IS DISTINCT FROM $2::uuid
     UNION ALL SELECT 1 FROM held_names WHERE hostname = $1 AND owner_id IS DISTINCT FROM $2::uuid LIMIT 1`,
    [hostname, ownerId]);
  return found.rowCount > 0;
}
// The name held for an owner whose address was released for lack of use,
// which they get back when they set Closedhand up again.
async function heldName(db, ownerId) {
  const found = await db.query(
    `SELECT h.hostname FROM held_names h WHERE h.owner_id = $1
       AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.hostname = h.hostname)
     ORDER BY h.created_at DESC LIMIT 1`, [ownerId]);
  return found.rows[0]?.hostname || null;
}
// A free name for a new address. Nearly always the first try: there are
// over a hundred thousand.
async function freeName(db) {
  for (let i = 0; i < 20; i++) {
    const hostname = randomName() + '.closedhand.ai';
    if (validHostname(hostname) && !(await nameTaken(db, hostname))) return hostname;
  }
  throw new Error('No free name found');
}

// A personal URL on its way to another copy reads as being built.
const shown = row => row.state === 'revoked' && row.reprovision ? 'provisioning' : row.state;

// Give an owner's personal URL to the copy that typed in their code. Under
// one lock, so two owners can never take the same name, one owner never gets
// two addresses, and the address limit is exact. An owner's existing address
// moves to the new copy: the old computer's connection is cut and the route
// is built again for this one.
async function reserve(pool, { ownerId, secretHash, hostname, port, limit }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(490048)');
    const mine = (await client.query('SELECT * FROM addresses WHERE owner_id = $1 FOR UPDATE', [ownerId])).rows[0];
    const copy = (await client.query('SELECT id FROM addresses WHERE secret_hash = $1', [secretHash])).rows[0];
    if (copy && copy.id !== mine?.id) throw new Refusal('This computer already has a personal URL on another account.');
    let row;
    if (mine) {
      if (mine.hostname !== hostname) throw new Refusal('This account already has a personal URL, ' + mine.hostname + '.');
      row = mine.secret_hash === secretHash && mine.state !== 'revoked' ? mine : (await client.query(
        `UPDATE addresses SET secret_hash = $2, web_port = $3, state = 'revoked', revocation_complete = false, reprovision = true,
           tunnel_token = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [mine.id, secretHash, port])).rows[0];
    } else {
      if (await nameTaken(client, hostname, ownerId)) throw new Refusal('That personal URL is already taken. Choose another name.');
      // Working addresses and fresh reservations count; released ones do not.
      const live = await client.query("SELECT count(*)::int AS n FROM addresses WHERE state <> 'revoked' AND (activated_at IS NOT NULL OR created_at > now() - interval '24 hours')");
      if (live.rows[0].n >= limit) throw new Refusal('Personal URLs are full for now. Try again later.');
      row = (await client.query(
        'INSERT INTO addresses (id, owner_id, secret_hash, hostname, web_port) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [crypto.randomUUID(), ownerId, secretHash, hostname, port])).rows[0];
      await client.query('DELETE FROM held_names WHERE hostname = $1 AND owner_id = $2', [hostname, ownerId]);
    }
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Renaming. The old name is kept for this address: for thirty days it sends
// visitors on to the new one (see the Worker), then it says it has moved,
// and six months after the rename it is released for anyone to take. Until
// then it is reserved to the owner, who can take it back. Each old name
// holds a route for those thirty days, so three in thirty days is the most.
// Coming back to one of your own old names reuses its route, so it doesn't
// count.
const RENAMES_PER_MONTH = 3;
async function rename(pool, { secretHash, hostname }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(490048)');
    const row = (await client.query('SELECT * FROM addresses WHERE secret_hash = $1 FOR UPDATE', [secretHash])).rows[0];
    if (!row || shown(row) === 'revoked') throw new Refusal('This computer does not have a personal URL yet.');
    if (!row.activated_at) throw new Refusal('Your personal URL is still being set up. Try again once it opens.');
    if (row.hostname === hostname) { await client.query('COMMIT'); return { row, until: null }; }
    if (await nameTaken(client, hostname, row.owner_id)) throw new Refusal('That name is taken. Try another.');
    const recent = (await client.query(
      "SELECT count(*)::int AS n FROM retired_names WHERE address_id = $1 AND created_at > now() - interval '30 days'", [row.id])).rows[0].n;
    if (recent >= RENAMES_PER_MONTH) throw new Refusal('You can change your personal URL three times in thirty days. Try again later.');
    // Coming back to an old name: its route, if still there, is found again
    // by name when the Worker rebuilds (never by a record the thirty-day
    // clean-up might be removing at that moment).
    await client.query('DELETE FROM retired_names WHERE hostname = $1 AND owner_id = $2', [hostname, row.owner_id]);
    await client.query('DELETE FROM held_names WHERE hostname = $1 AND owner_id = $2', [hostname, row.owner_id]);
    const until = (await client.query(
      `INSERT INTO retired_names (hostname, owner_id, address_id, redirect_to, redirect_until, release_at, dns_id)
       VALUES ($1, $2, $3, $4, now() + interval '30 days', now() + interval '6 months', $5) RETURNING redirect_until`,
      [row.hostname, row.owner_id, row.id, hostname, row.dns_id])).rows[0].redirect_until;
    // Older names still redirecting follow to the newest.
    await client.query(
      'UPDATE retired_names SET redirect_to = $2, announced = false WHERE address_id = $1 AND hostname <> $3 AND redirect_until > now()',
      [row.id, hostname, row.hostname]);
    // The Worker routes the new name to the same tunnel, then this copy
    // reconnects and proves it answers there, as for a new address.
    const updated = (await client.query(
      `UPDATE addresses SET hostname = $2, dns_id = NULL, state = 'pending', tunnel_token = NULL, lease_until = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [row.id, hostname])).rows[0];
    await client.query('COMMIT');
    return { row: updated, until };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Letting an owner's address go, when their account is deleted or the
// address has gone unused. Its name, and any old names, are held for six
// months: for the owner (holdFor) or, after a deletion, for nobody. The
// Worker takes every route down. The row loses its owner and its computer at
// once, so both are free to start again straight away.
async function letGo(client, ownerId, holdFor) {
  const hold = (sql, values) => client.query(
    `INSERT INTO held_names (hostname, owner_id, release_at) ${sql}
     ON CONFLICT (hostname) DO UPDATE SET owner_id = EXCLUDED.owner_id, release_at = GREATEST(held_names.release_at, EXCLUDED.release_at)`, values);
  const row = (await client.query('SELECT * FROM addresses WHERE owner_id = $1 FOR UPDATE', [ownerId])).rows[0];
  if (row) {
    // A name that never opened anything has no bookmarks to protect.
    if (row.activated_at) await hold("VALUES ($1, $2::uuid, now() + interval '6 months')", [row.hostname, holdFor]);
    await client.query(
      `UPDATE addresses SET owner_id = NULL, secret_hash = encode(digest(gen_random_uuid()::text, 'sha256'), 'hex'),
         state = 'revoked', reprovision = false, revocation_complete = (tunnel_id IS NULL AND dns_id IS NULL),
         tunnel_token = NULL, lease_until = NULL, updated_at = now() WHERE id = $1`, [row.id]);
  }
  // Old names keep their own release dates, and stop redirecting now: the
  // Worker releases them (removing their routes), and the hold keeps them.
  await hold('SELECT hostname, $2::uuid, release_at FROM retired_names WHERE owner_id = $1', [ownerId, holdFor]);
  await client.query('UPDATE retired_names SET owner_id = NULL, release_at = now() WHERE owner_id = $1', [ownerId]);
  await client.query("DELETE FROM addresses WHERE owner_id IS NULL AND state = 'revoked' AND revocation_complete");
  return row || null;
}
async function locked(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(490048)');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
// Deleting a Closedhand account: the sign-in is forgotten, and nothing left
// here links its names to anyone.
async function deleteAccount(pool, ownerId) {
  return locked(pool, async client => {
    const row = await letGo(client, ownerId, null);
    await client.query('DELETE FROM owners WHERE id = $1', [ownerId]);
    return { hostname: row?.hostname || null };
  });
}
// Addresses whose computer has not connected for this many days are let go,
// their names held for their owners (who get them back by setting up again).
async function releaseIdle(pool, days) {
  const idle = (await pool.query(
    `SELECT owner_id FROM addresses WHERE owner_id IS NOT NULL AND activated_at IS NOT NULL AND state <> 'revoked'
       AND last_seen_at < now() - make_interval(days => $1) LIMIT 20`, [days])).rows;
  for (const { owner_id: ownerId } of idle) {
    await locked(pool, async client => {
      // Checked again under the lock, in case it came back.
      const still = await client.query(
        "SELECT 1 FROM addresses WHERE owner_id = $1 AND state <> 'revoked' AND last_seen_at < now() - make_interval(days => $2)", [ownerId, days]);
      if (still.rowCount) await letGo(client, ownerId, ownerId);
    });
  }
  return idle.length;
}

function register(app, { db, sessions, secret, baseUrl, env = process.env, request = fetch }) {
  const enabled = () => env.PHONE_ENROLLMENT_ENABLED === '1';
  const limit = Number.parseInt(env.ADDRESS_LIMIT || '100', 10);
  // Requests a minute from one address (the tests raise it).
  const perMinute = Number.parseInt(env.ADDRESS_RATE_PER_MINUTE || '120', 10);
  const hits = new Map();
  let total = 0, resetAt = 0;
  // Switching new personal URLs off never stops anyone deleting their account.
  const wrap = (fn, { always = false } = {}) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!always && !enabled()) return res.status(503).json({ error: 'Personal URLs are not available right now. You can still use Closedhand on the computer running it.' });
    const now = Date.now();
    if (now > resetAt) { hits.clear(); total = 0; resetAt = now + 60000; }
    const key = req.ip || '?', count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    // Only requests let through count towards the overall cap, so one busy
    // address cannot use it up for everyone else.
    if (count > perMinute || total >= 10 * perMinute) return res.status(429).json({ error: 'Please wait a minute and try again.' });
    total++;
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof Refusal) return res.status(409).json({ error: e.message });
      console.error('[addresses]', req.path, e.message);
      res.status(503).json({ error: 'Could not finish setting up your personal URL. Please try again.' });
    }
  };
  async function owned(req) {
    const copy = installation(req);
    if (!copy) return null;
    const row = (await db.query('SELECT * FROM addresses WHERE secret_hash = $1', [copy.secret_hash])).rows[0];
    return row && shown(row) !== 'revoked' ? { row, copy } : null;
  }

  app.post('/api/phone-enrollment/register', wrap(async (req, res) => {
    const copy = installation(req), { name, port, confirm } = req.body || {};
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    // Copies from before confirmation codes could never finish.
    if (confirm !== 'code') return res.status(400).json({ error: 'Update Closedhand on your computer, then choose your personal URL again.' });
    // Asked without a name, the address gets one picked here.
    if (name === undefined || name === null || name === '') {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return res.status(400).json({ error: 'Update Closedhand on your computer and try again.' });
      return res.json({ ticket: ticketFor({ secret_hash: copy.secret_hash, hostname: await freeName(db), port, auto: true }, secret) });
    }
    const hostname = typeof name === 'string' ? name + '.closedhand.ai' : '';
    if (!validHostname(hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return res.status(400).json({ error: 'Use 3 to 32 lowercase letters, numbers or hyphens. Start with a letter and end with a letter or number.' });
    }
    res.json({ ticket: ticketFor({ secret_hash: copy.secret_hash, hostname, port }, secret) });
  }));

  // What the confirmation page shows. Progress, and the code while it is
  // waiting to be typed in, are revealed only to the owner who confirmed;
  // an expired ticket can still show its owner a finished request, but can
  // never approve anything. "move" means this owner's address currently
  // opens another copy.
  app.post('/api/phone-enrollment/details', wrap(async (req, res) => {
    const t = readTicket(req.body?.ticket, secret);
    if (!t) return res.status(400).json({ error: 'This claim link is not valid. Start again in Closedhand.' });
    const answer = { url: 'https://' + t.hostname, state: 'unconfirmed' };
    const owner = sessions.owner(req);
    if (owner) {
      const mine = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [owner])).rows[0];
      // A picked name gives way to the address the owner already has, or to
      // the name held for them.
      const hostname = t.auto ? mine?.hostname || await heldName(db, owner) || t.hostname : t.hostname;
      answer.url = 'https://' + hostname;
      if (mine && mine.hostname === hostname && mine.secret_hash === t.secret_hash) answer.state = shown(mine);
      else {
        if (mine?.hostname === hostname && mine.state !== 'revoked') answer.move = true;
        const waiting = (await db.query('SELECT code, hostname FROM approvals WHERE secret_hash = $1 AND owner_id = $2 AND expires_at > now()' + (t.auto ? '' : ' AND hostname = $3'),
          t.auto ? [t.secret_hash, owner] : [t.secret_hash, owner, t.hostname])).rows[0];
        const code = waiting && decryptString(waiting.code);
        if (code) Object.assign(answer, { state: 'awaiting-code', code, url: 'https://' + waiting.hostname });
      }
    }
    if (t.expires <= Date.now() && answer.state === 'unconfirmed') return res.status(400).json({ error: 'This claim link expired. Start again in Closedhand.' });
    res.json(answer);
  }));

  // The owner confirms. Nothing changes yet: they are shown a code, and only
  // the copy that asked can finish by typing it in (see claim). Anything the
  // code could not fix is refused now.
  app.post('/api/phone-enrollment/approve', wrap(async (req, res) => {
    const owner = sessions.owner(req), t = readTicket(req.body?.ticket, secret);
    if (!owner) return res.status(401).json({ error: 'Sign in to claim this personal URL.' });
    if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this claim page on closedhand.com.' });
    if (!t || t.expires <= Date.now()) return res.status(400).json({ error: 'This claim link expired. Start again in Closedhand.' });
    const mine = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [owner])).rows[0];
    // A picked name gives way to the owner's own address, or the name held
    // for them, or to another free one if somebody took it in the meantime.
    let hostname = t.hostname;
    if (t.auto) hostname = mine ? mine.hostname : await heldName(db, owner) || ((await nameTaken(db, hostname, owner)) ? await freeName(db) : hostname);
    const url = 'https://' + hostname;
    if (mine && mine.hostname !== hostname) {
      throw new Refusal('This account already has a personal URL, ' + mine.hostname + '. To use it with this computer, choose ' + mine.hostname.split('.')[0] + ' in Closedhand.');
    }
    if (mine && mine.secret_hash === t.secret_hash && mine.state !== 'revoked') return res.json({ state: shown(mine), url });
    if (!mine && (await nameTaken(db, hostname, owner))) throw new Refusal('That personal URL is already taken. Choose another name.');
    const copy = (await db.query('SELECT owner_id FROM addresses WHERE secret_hash = $1', [t.secret_hash])).rows[0];
    if (copy && copy.owner_id !== owner) throw new Refusal('This computer already has a personal URL on another account.');
    const code = newCode(), sealed = encryptString(code);
    if (!sealed?.startsWith('enc:v1:')) throw new Error('Encryption unavailable');
    await db.query('DELETE FROM approvals WHERE expires_at < now()');
    // Confirming again replaces the waiting code.
    await db.query(
      `INSERT INTO approvals (secret_hash, owner_id, hostname, web_port, code, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')
       ON CONFLICT (secret_hash) DO UPDATE SET owner_id = EXCLUDED.owner_id, hostname = EXCLUDED.hostname, web_port = EXCLUDED.web_port,
         code = EXCLUDED.code, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [t.secret_hash, owner, hostname, t.port, sealed]);
    res.json({ state: 'awaiting-code', url, code, ...(mine && mine.state !== 'revoked' ? { move: true } : {}) });
  }));

  // The copy types in the code its owner was shown. Each try is counted
  // before the code is compared, so trying many at once gains nothing.
  app.post('/api/phone-enrollment/claim', wrap(async (req, res) => {
    const copy = installation(req);
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    const code = String(req.body?.code || '').toUpperCase().replace(/[\s-]/g, '');
    const waiting = (await db.query(
      'UPDATE approvals SET attempts = attempts + 1 WHERE secret_hash = $1 AND expires_at > now() AND attempts < $2 RETURNING *',
      [copy.secret_hash, MAX_CODE_TRIES])).rows[0];
    if (!waiting) return res.status(409).json({ error: 'Claim your personal URL on closedhand.com first. It then shows the code to type here.' });
    if (!/^[A-Z0-9]{6}$/.test(code) || !equal(code, decryptString(waiting.code) || '')) {
      if (waiting.attempts < MAX_CODE_TRIES) return res.status(400).json({ error: 'That code does not match. Check the code on closedhand.com and try again.' });
      await db.query('DELETE FROM approvals WHERE secret_hash = $1 AND code = $2', [copy.secret_hash, waiting.code]);
      return res.status(400).json({ error: 'That code did not match, so it no longer works. Claim it again on closedhand.com for a new code.' });
    }
    // One use: only the request that removes it goes on.
    const used = await db.query('DELETE FROM approvals WHERE secret_hash = $1 AND code = $2 RETURNING owner_id, hostname, web_port', [copy.secret_hash, waiting.code]);
    if (!used.rowCount) return res.status(409).json({ error: 'Claim your personal URL on closedhand.com first. It then shows the code to type here.' });
    const a = used.rows[0];
    const row = await reserve(db, { ownerId: a.owner_id, secretHash: copy.secret_hash, hostname: a.hostname, port: a.web_port, limit });
    res.json({ state: shown(row), url: 'https://' + row.hostname });
  }));

  // A copy that just connected Microsoft mail through Closedhand's own
  // Microsoft app passes on that sign-in and claims in one step: Microsoft's
  // signature stands in for signing in here, and the copy's own secret for
  // the code. An address the owner already uses on another computer is never
  // moved this way; the copy is told to claim it on the confirmation page.
  app.post('/api/phone-enrollment/claim-microsoft', wrap(async (req, res) => {
    const copy = installation(req), { idToken, port } = req.body || {};
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return res.status(400).json({ error: 'Update Closedhand on your computer and try again.' });
    const apps = String(env.MICROSOFT_ASSOCIATED_APP_IDS || '').split(',').map(s => s.trim()).filter(id => uuid.test(id) && id !== env.MICROSOFT_CLIENT_ID);
    const claims = apps.length ? await verifyMicrosoftToken(idToken, { appIds: apps, request }) : null;
    const identity = claims && PROVIDERS.microsoft.identity(claims, claims.aud);
    if (!identity) return res.status(400).json({ error: 'The Microsoft sign-in could not be checked. Claim your personal URL with the button instead.' });
    const owner = await ownerFor(db, identity);
    const mine = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [owner])).rows[0];
    if (mine && mine.secret_hash === copy.secret_hash && mine.state !== 'revoked') return res.json({ state: shown(mine), url: 'https://' + mine.hostname });
    const held = (await db.query('SELECT owner_id FROM addresses WHERE secret_hash = $1', [copy.secret_hash])).rows[0];
    if ((mine && mine.state !== 'revoked') || (held && held.owner_id !== owner)) return res.json({ state: 'unconfirmed', claimHere: true });
    const hostname = mine ? mine.hostname : await heldName(db, owner) || await freeName(db);
    const row = await reserve(db, { ownerId: owner, secretHash: copy.secret_hash, hostname, port, limit });
    res.json({ state: shown(row), url: 'https://' + row.hostname });
  }));

  // The copy renames its address. It is known by its secret, like every
  // request from it; the name is tidied first, as the copy shows it.
  app.post('/api/phone-enrollment/rename', wrap(async (req, res) => {
    const copy = installation(req);
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    const hostname = cleanName(req.body?.name) + '.closedhand.ai';
    if (!validHostname(hostname)) {
      return res.status(400).json({ error: 'Use 3 to 32 letters, numbers or hyphens, starting with a letter. A few names, like admin and mail, are kept back.' });
    }
    const { row, until } = await rename(db, { secretHash: copy.secret_hash, hostname });
    res.json({ state: shown(row), url: 'https://' + row.hostname, ...(until ? { redirectUntil: until } : {}) });
  }));

  app.get('/api/phone-enrollment/connection', wrap(async (req, res) => {
    const found = await owned(req);
    if (!found) return res.json({ state: 'unconfirmed' });
    const { row } = found;
    if (!['connecting', 'active'].includes(row.state)) return res.json({ state: shown(row) });
    const token = decryptString(row.tunnel_token);
    if (!token || token.length < 30) throw new Error('Missing connection');
    res.json({ state: row.state, url: 'https://' + row.hostname, token });
  }));

  // The copy says it is connected. Check by asking it, through the new
  // address, to sign a fresh challenge with the secret only it holds.
  app.post('/api/phone-enrollment/connected', wrap(async (req, res) => {
    const found = await owned(req);
    if (!found || !['connecting', 'active'].includes(found.row.state)) return res.status(409).json({ error: 'Your personal URL is not ready yet.' });
    const { row, copy } = found;
    const nonce = crypto.randomBytes(32).toString('hex');
    let proof = null;
    try {
      const response = await request('https://' + row.hostname + '/.well-known/closedhand-installation?nonce=' + nonce, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      proof = response.ok ? (await smallJson(response))?.proof : null;
    } catch (_) { /* not reachable yet */ }
    const expected = crypto.createHmac('sha256', copy.secret).update('closedhand-address:' + nonce).digest('hex');
    if (!equal(proof, expected)) return res.status(409).json({ error: 'Waiting for this computer to connect. Please try again shortly.' });
    const updated = await db.query(
      "UPDATE addresses SET state = 'active', activated_at = COALESCE(activated_at, now()), last_seen_at = now(), updated_at = now() WHERE id = $1 AND secret_hash = $2 AND state IN ('connecting', 'active') RETURNING id",
      [row.id, row.secret_hash]);
    if (!updated.rowCount) throw new Error('Address changed while connecting');
    res.json({ state: 'active' });
  }));

  // A Closedhand account is the Google or Microsoft sign-in that confirmed a
  // personal URL, and it holds that personal URL and nothing else. The
  // computer the URL opens can see which sign-in it is, and can delete the
  // account (Settings in Closedhand); so can the owner here, signed in.
  app.get('/api/phone-enrollment/account', wrap(async (req, res) => {
    const found = await owned(req);
    const person = found && (await db.query('SELECT provider, email FROM owners WHERE id = $1', [found.row.owner_id])).rows[0];
    res.json({ account: person ? { provider: person.provider, email: person.email, url: 'https://' + found.row.hostname } : null });
  }, { always: true }));
  app.post('/api/phone-enrollment/account/delete', wrap(async (req, res) => {
    if (!installation(req)) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    const found = await owned(req);
    // Nothing on closedhand.com is linked to this computer: nothing to delete.
    if (!found) return res.json({ deleted: false });
    await deleteAccount(db, found.row.owner_id);
    res.json({ deleted: true });
  }, { always: true }));
  app.post('/api/account/delete', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const owner = sessions.owner(req);
    if (!owner) return res.status(401).json({ error: 'Sign in to delete your Closedhand account.' });
    if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this on closedhand.com.' });
    try {
      await deleteAccount(db, owner);
      sessions.signOut(res);
      res.json({ deleted: true });
    } catch (e) {
      console.error('[addresses] delete account:', e.message);
      res.status(503).json({ error: 'Could not delete your account. Please try again.' });
    }
  });

  // Who is signed in here, and their personal URL: "url" once it works (to
  // open it), "address" while it exists at all (for the account page).
  app.get('/api/account', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const owner = sessions.owner(req);
      let url = null, address = null, email = null, provider = null, person = null, emailVerified = false;
      if (owner) {
        person = (await db.query('SELECT provider, email, email_verified FROM owners WHERE id = $1', [owner])).rows[0];
        if (person) ({ provider, email } = person), emailVerified = person.email_verified === true;
        const row = person && (await db.query('SELECT hostname, state, reprovision FROM addresses WHERE owner_id = $1', [owner])).rows[0];
        if (row && shown(row) !== 'revoked' && validHostname(row.hostname)) address = row.hostname;
        if (row?.state === 'active' && validHostname(row.hostname)) url = 'https://' + row.hostname;
      }
      // A sign-in whose account was deleted is no sign-in at all.
      res.json({ signedIn: !!person, provider, email, emailVerified, url, address, available: enabled() });
    } catch (e) {
      console.error('[addresses] account:', e.message);
      res.status(503).json({ error: 'Could not look up your account. Please try again.' });
    }
  });

  // The Cloudflare Worker that builds routes. It receives routing jobs only,
  // never owners or anything else about them. It has its own gate: switching
  // new addresses off, or a flood of other traffic, must not stop it from
  // finishing or removing routes.
  const job = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!env.PHONE_PROVISIONER_SECRET || !equal(req.headers.authorization, 'Bearer ' + env.PHONE_PROVISIONER_SECRET)) {
      return res.status(401).json({ error: 'Unauthorised' });
    }
    try { await fn(req, res); }
    catch (e) { console.error('[addresses] job:', e.message); res.status(503).json({ error: 'Job unavailable' }); }
  };
  // A reservation that has not worked within a day is released: its route,
  // if any, is removed by the Worker first, then the row goes. Held names
  // are freed when their six months are up. Unused addresses are let go,
  // but only while the Worker's last-seen reports are current (seenAt), so
  // a broken report can never make every address look unused. A sign-in
  // that holds nothing, a day on, is forgotten: an account exists only
  // while it has a personal URL (or a name held for it).
  const idleDays = Number.parseInt(env.ADDRESS_IDLE_DAYS || '90', 10);
  let seenAt = 0;
  async function releaseStale() {
    await db.query(
      `UPDATE addresses SET state = 'revoked', revocation_complete = (tunnel_id IS NULL AND dns_id IS NULL), lease_until = NULL, updated_at = now()
       WHERE activated_at IS NULL AND state IN ('pending', 'provisioning', 'connecting', 'error')
         AND created_at < now() - interval '24 hours' AND (lease_until IS NULL OR lease_until < now())`);
    await db.query("DELETE FROM addresses WHERE (activated_at IS NULL OR owner_id IS NULL) AND state = 'revoked' AND revocation_complete");
    await db.query('DELETE FROM held_names WHERE release_at <= now()');
    if (Date.now() - seenAt < 3 * 3600000) await releaseIdle(db, idleDays);
    await db.query(
      `DELETE FROM owners o WHERE o.updated_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.owner_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM retired_names r WHERE r.owner_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM held_names h WHERE h.owner_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM approvals p WHERE p.owner_id = o.id)`);
  }
  // When each address's computer was last connected, from Cloudflare's
  // record of its tunnel, reported by the Worker every hour.
  app.post('/api/phone-enrollment/jobs/seen', job(async (req, res) => {
    const tunnels = Array.isArray(req.body?.tunnels) ? req.body.tunnels.slice(0, 5000) : null;
    if (!tunnels) return res.status(400).json({ error: 'Invalid report' });
    const valid = tunnels.filter(t => uuid.test(t?.address || '') && uuid.test(t?.tunnel || '') && Number.isFinite(Date.parse(t?.seen)));
    const seen = valid.map(t => new Date(Math.min(Date.parse(t.seen), Date.now())));
    const matched = (await db.query(
      `UPDATE addresses a SET last_seen_at = GREATEST(a.last_seen_at, s.seen)
       FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) AS s(address, tunnel, seen)
       WHERE a.id = s.address AND a.tunnel_id = s.tunnel`,
      [valid.map(t => t.address), valid.map(t => t.tunnel), seen])).rowCount;
    const working = (await db.query(
      "SELECT count(*)::int AS n FROM addresses WHERE activated_at IS NOT NULL AND tunnel_id IS NOT NULL AND state <> 'revoked'")).rows[0].n;
    // Current only when it covers most working addresses.
    if (matched >= Math.ceil(working / 2)) seenAt = Date.now();
    res.json({ matched, working });
  }));
  app.post('/api/phone-enrollment/jobs/lease', job(async (req, res) => {
    await releaseStale();
    const row = (await db.query(
      `UPDATE addresses SET state = CASE WHEN state = 'revoked' THEN 'revoked' ELSE 'provisioning' END,
         attempt_id = gen_random_uuid(), lease_until = now() + interval '3 minutes', updated_at = now()
       WHERE id = (SELECT id FROM addresses
                   WHERE (state IN ('pending', 'provisioning', 'error') OR (state = 'revoked' AND NOT revocation_complete))
                     AND (lease_until IS NULL OR lease_until < now())
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`)).rows[0];
    // A revoked address moving to another computer keeps its tunnel and
    // route; any other revoked address is taken down completely.
    res.json({ job: row ? { id: row.id, hostname: row.hostname, port: row.web_port, attempt: row.attempt_id, tunnelId: row.tunnel_id, dnsId: row.dns_id,
      revoked: row.state === 'revoked', teardown: row.state === 'revoked' && !row.reprovision } : null });
  }));
  // Renamed addresses, for the Worker. Old names whose redirect it has not
  // set up; old names past their thirty days, whose own route it removes
  // (the catch-all record then brings visitors to the moved page); and old
  // names due for release, which it forgets entirely.
  app.post('/api/phone-enrollment/jobs/moves', job(async (req, res) => {
    const announce = (await db.query(
      'SELECT hostname, redirect_to, redirect_until, release_at FROM retired_names WHERE NOT announced AND release_at > now() ORDER BY created_at LIMIT 20')).rows;
    const remove = (await db.query(
      'SELECT hostname, dns_id FROM retired_names WHERE redirect_until <= now() AND NOT dns_removed AND release_at > now() ORDER BY redirect_until LIMIT 20')).rows;
    const release = (await db.query(
      'SELECT hostname, dns_id, dns_removed FROM retired_names WHERE release_at <= now() ORDER BY release_at LIMIT 20')).rows;
    res.json({ moves: [
      ...announce.map(r => ({ hostname: r.hostname, to: r.redirect_to, until: r.redirect_until.toISOString(), release: r.release_at.toISOString() })),
      ...remove.map(r => ({ hostname: r.hostname, dnsId: r.dns_id, remove: true })),
      ...release.map(r => ({ hostname: r.hostname, dnsId: r.dns_removed ? null : r.dns_id, release: true })),
    ] });
  }));
  app.post('/api/phone-enrollment/jobs/moves/done', job(async (req, res) => {
    const { hostname, to, removed, released } = req.body || {};
    const name = /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/;
    if (!name.test(hostname || '') || (!removed && !released && !name.test(to || ''))) return res.status(400).json({ error: 'Invalid move' });
    // An announcement counts only for the destination it announced. A
    // released name's row goes: nothing is left linking it to its owner.
    const done = released
      ? await db.query('DELETE FROM retired_names WHERE hostname = $1 AND release_at <= now()', [hostname])
      : removed
        ? await db.query('UPDATE retired_names SET dns_removed = true WHERE hostname = $1 AND redirect_until <= now()', [hostname])
        : await db.query('UPDATE retired_names SET announced = true WHERE hostname = $1 AND redirect_to = $2', [hostname, to]);
    res.json({ ok: done.rowCount > 0 });
  }));
  // How many DNS records personal URLs use, counted by the Worker. Past the
  // alert level the operator is emailed (alerts.js).
  app.post('/api/phone-enrollment/jobs/usage', job(async (req, res) => {
    const count = req.body?.dnsRecords;
    if (!Number.isInteger(count) || count < 0 || count > 1000000) return res.status(400).json({ error: 'Invalid usage' });
    res.json(await reportDnsRecords(db, env, count, request));
  }));

  app.post('/api/phone-enrollment/jobs/checkpoint', job(async (req, res) => {
    const { id, attempt, tunnelId, dnsId, token, error: failed, revoked } = req.body || {};
    if (!uuid.test(id || '') || !uuid.test(attempt || '') || (tunnelId && !uuid.test(tunnelId)) || (dnsId && !/^[a-f0-9]{32}$/.test(dnsId))) {
      return res.status(400).json({ error: 'Invalid checkpoint' });
    }
    if (revoked) {
      // A personal URL moving to another copy is built again straight away.
      const done = await db.query(
        `UPDATE addresses SET tunnel_token = NULL, updated_at = now(),
           state = CASE WHEN reprovision THEN 'pending' ELSE 'revoked' END, revocation_complete = NOT reprovision,
           lease_until = CASE WHEN reprovision THEN NULL ELSE lease_until END, reprovision = false
         WHERE id = $1 AND attempt_id = $2 AND state = 'revoked' AND lease_until > now() RETURNING id`,
        [id, attempt]);
      // An address let go has nothing left once its route is down.
      if (done.rowCount) await db.query("DELETE FROM addresses WHERE id = $1 AND owner_id IS NULL AND state = 'revoked' AND revocation_complete", [id]);
      return done.rowCount ? res.json({ ok: true }) : res.status(409).json({ error: 'Revocation lease changed' });
    }
    const set = ['updated_at = now()'], values = [id, attempt];
    const add = (sql, value) => { values.push(value); set.push(sql.replace('?', '$' + values.length)); };
    if (tunnelId) add('tunnel_id = ?', tunnelId);
    if (dnsId) add('dns_id = ?', dnsId);
    if (failed) set.push("state = 'error'", "lease_until = now() + interval '1 minute'");
    if (token) {
      if (typeof token !== 'string' || token.length < 30 || token.length > 8192 || !tunnelId || !dnsId || tokenTunnel(token) !== tunnelId) {
        return res.status(400).json({ error: 'Invalid connection' });
      }
      const sealed = encryptString(token);
      if (!sealed?.startsWith('enc:v1:')) throw new Error('Encryption unavailable');
      add('tunnel_token = ?', sealed);
      set.push("state = 'connecting'", 'lease_until = NULL');
    }
    const done = await db.query(
      `UPDATE addresses SET ${set.join(', ')} WHERE id = $1 AND attempt_id = $2 AND state = 'provisioning' AND lease_until > now() RETURNING id`, values);
    done.rowCount ? res.json({ ok: true }) : res.status(409).json({ error: 'Job lease expired or revoked' });
  }));
}

module.exports = { register, reserve, rename, deleteAccount, releaseIdle, heldName, nameTaken, freeName, ticketFor, readTicket, installation, validHostname, tokenTunnel, Refusal };
