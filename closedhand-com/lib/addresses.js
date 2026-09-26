// Personal URLs (name.closedhand.ai). A copy of ClosedHand asks for a name,
// its owner confirms it here after signing in and is shown a code, and the
// code typed into that copy finishes the request. A separate Cloudflare
// Worker builds the route, and the copy proves it answers at the new address
// before the address is marked ready. Only routing records live here.
const crypto = require('node:crypto');
const { encryptString, decryptString } = require('./crypto-tokens');
const { equal } = require('./session');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Names a person could mistake for a ClosedHand or mail service address.
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

// A copy of ClosedHand signs its requests with "Bearer <install id>.<secret>".
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
      Number.isInteger(t.port) && t.port >= 1024 && t.port <= 65535 && typeof t.expires === 'number' ? t : null;
  } catch (_) { return null; }
}

class Refusal extends Error {}

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
      if ((await client.query('SELECT 1 FROM addresses WHERE hostname = $1', [hostname])).rowCount) throw new Refusal('That personal URL is already taken. Choose another name.');
      // Working addresses and fresh reservations count; released ones do not.
      const live = await client.query("SELECT count(*)::int AS n FROM addresses WHERE state <> 'revoked' AND (activated_at IS NOT NULL OR created_at > now() - interval '24 hours')");
      if (live.rows[0].n >= limit) throw new Refusal('Personal URLs are full for now. Try again later.');
      row = (await client.query(
        'INSERT INTO addresses (id, owner_id, secret_hash, hostname, web_port) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [crypto.randomUUID(), ownerId, secretHash, hostname, port])).rows[0];
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

function register(app, { db, sessions, secret, baseUrl, env = process.env, request = fetch }) {
  const enabled = () => env.PHONE_ENROLLMENT_ENABLED === '1';
  const limit = Number.parseInt(env.ADDRESS_LIMIT || '100', 10);
  const hits = new Map();
  let total = 0, resetAt = 0;
  const wrap = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled()) return res.status(503).json({ error: 'Personal URLs are not available right now. You can still use ClosedHand on the computer running it.' });
    const now = Date.now();
    if (now > resetAt) { hits.clear(); total = 0; resetAt = now + 60000; }
    const key = req.ip || '?', count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    // Only requests let through count towards the overall cap, so one busy
    // address cannot use it up for everyone else.
    if (count > 120 || total >= 1200) return res.status(429).json({ error: 'Please wait a minute and try again.' });
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
    if (!copy) return res.status(401).json({ error: 'Invalid installation.' });
    // Copies from before confirmation codes could never finish.
    if (confirm !== 'code') return res.status(400).json({ error: 'Update ClosedHand on your computer, then choose your personal URL again.' });
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
    if (!t) return res.status(400).json({ error: 'This confirmation link is not valid. Start again in ClosedHand.' });
    const answer = { url: 'https://' + t.hostname, state: 'unconfirmed' };
    const owner = sessions.owner(req);
    if (owner) {
      const mine = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [owner])).rows[0];
      if (mine && mine.hostname === t.hostname && mine.secret_hash === t.secret_hash) answer.state = shown(mine);
      else {
        if (mine?.hostname === t.hostname && mine.state !== 'revoked') answer.move = true;
        const waiting = (await db.query('SELECT code FROM approvals WHERE secret_hash = $1 AND owner_id = $2 AND hostname = $3 AND expires_at > now()',
          [t.secret_hash, owner, t.hostname])).rows[0];
        const code = waiting && decryptString(waiting.code);
        if (code) Object.assign(answer, { state: 'awaiting-code', code });
      }
    }
    if (t.expires <= Date.now() && answer.state === 'unconfirmed') return res.status(400).json({ error: 'This confirmation expired. Start again in ClosedHand.' });
    res.json(answer);
  }));

  // The owner confirms. Nothing changes yet: they are shown a code, and only
  // the copy that asked can finish by typing it in (see claim). Anything the
  // code could not fix is refused now.
  app.post('/api/phone-enrollment/approve', wrap(async (req, res) => {
    const owner = sessions.owner(req), t = readTicket(req.body?.ticket, secret);
    if (!owner) return res.status(401).json({ error: 'Sign in to confirm that this personal URL is yours.' });
    if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this confirmation on ClosedHand.' });
    if (!t || t.expires <= Date.now()) return res.status(400).json({ error: 'This confirmation expired. Start again in ClosedHand.' });
    const url = 'https://' + t.hostname;
    const mine = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [owner])).rows[0];
    if (mine && mine.hostname !== t.hostname) {
      throw new Refusal('This account already has a personal URL, ' + mine.hostname + '. To use it with this computer, choose ' + mine.hostname.split('.')[0] + ' in ClosedHand.');
    }
    if (mine && mine.secret_hash === t.secret_hash && mine.state !== 'revoked') return res.json({ state: shown(mine), url });
    if (!mine && (await db.query('SELECT 1 FROM addresses WHERE hostname = $1', [t.hostname])).rowCount) throw new Refusal('That personal URL is already taken. Choose another name.');
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
      [t.secret_hash, owner, t.hostname, t.port, sealed]);
    res.json({ state: 'awaiting-code', url, code, ...(mine && mine.state !== 'revoked' ? { move: true } : {}) });
  }));

  // The copy types in the code its owner was shown. Each try is counted
  // before the code is compared, so trying many at once gains nothing.
  app.post('/api/phone-enrollment/claim', wrap(async (req, res) => {
    const copy = installation(req);
    if (!copy) return res.status(401).json({ error: 'Invalid installation.' });
    const code = String(req.body?.code || '').toUpperCase().replace(/[\s-]/g, '');
    const waiting = (await db.query(
      'UPDATE approvals SET attempts = attempts + 1 WHERE secret_hash = $1 AND expires_at > now() AND attempts < $2 RETURNING *',
      [copy.secret_hash, MAX_CODE_TRIES])).rows[0];
    if (!waiting) return res.status(409).json({ error: 'Confirm your personal URL on closedhand.com first. It then shows the code to type here.' });
    if (!/^[A-Z0-9]{6}$/.test(code) || !equal(code, decryptString(waiting.code) || '')) {
      if (waiting.attempts < MAX_CODE_TRIES) return res.status(400).json({ error: 'That code does not match. Check the code on closedhand.com and try again.' });
      await db.query('DELETE FROM approvals WHERE secret_hash = $1 AND code = $2', [copy.secret_hash, waiting.code]);
      return res.status(400).json({ error: 'That code did not match, so it no longer works. Confirm again on closedhand.com for a new code.' });
    }
    // One use: only the request that removes it goes on.
    const used = await db.query('DELETE FROM approvals WHERE secret_hash = $1 AND code = $2 RETURNING owner_id, hostname, web_port', [copy.secret_hash, waiting.code]);
    if (!used.rowCount) return res.status(409).json({ error: 'Confirm your personal URL on closedhand.com first. It then shows the code to type here.' });
    const a = used.rows[0];
    const row = await reserve(db, { ownerId: a.owner_id, secretHash: copy.secret_hash, hostname: a.hostname, port: a.web_port, limit });
    res.json({ state: shown(row), url: 'https://' + row.hostname });
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
      "UPDATE addresses SET state = 'active', activated_at = COALESCE(activated_at, now()), updated_at = now() WHERE id = $1 AND secret_hash = $2 AND state IN ('connecting', 'active') RETURNING id",
      [row.id, row.secret_hash]);
    if (!updated.rowCount) throw new Error('Address changed while connecting');
    res.json({ state: 'active' });
  }));

  // Who is signed in here, and their personal URL once it works.
  app.get('/api/account', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const owner = sessions.owner(req);
      let url = null, email = null, provider = null;
      if (owner) {
        const person = (await db.query('SELECT provider, email FROM owners WHERE id = $1', [owner])).rows[0];
        if (person) ({ provider, email } = person);
        const row = (await db.query('SELECT hostname, state FROM addresses WHERE owner_id = $1', [owner])).rows[0];
        if (row?.state === 'active' && validHostname(row.hostname)) url = 'https://' + row.hostname;
      }
      res.json({ signedIn: !!owner, provider, email, url, available: enabled() });
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
  // if any, is removed by the Worker first, then the row goes.
  async function releaseStale() {
    await db.query(
      `UPDATE addresses SET state = 'revoked', revocation_complete = (tunnel_id IS NULL AND dns_id IS NULL), lease_until = NULL, updated_at = now()
       WHERE activated_at IS NULL AND state IN ('pending', 'provisioning', 'connecting', 'error')
         AND created_at < now() - interval '24 hours' AND (lease_until IS NULL OR lease_until < now())`);
    await db.query("DELETE FROM addresses WHERE activated_at IS NULL AND state = 'revoked' AND revocation_complete");
  }
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
    res.json({ job: row ? { id: row.id, hostname: row.hostname, port: row.web_port, attempt: row.attempt_id, tunnelId: row.tunnel_id, dnsId: row.dns_id, revoked: row.state === 'revoked' } : null });
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

module.exports = { register, reserve, ticketFor, readTicket, installation, validHostname, tokenTunnel, Refusal };
