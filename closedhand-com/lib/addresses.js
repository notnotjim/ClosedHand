// Personal URLs (name.closedhand.ai). A copy of ClosedHand asks for a name,
// its owner confirms it here after signing in, a separate Cloudflare Worker
// builds the route, and the copy proves it answers at the new address before
// the address is marked ready. Only routing records live here.
const crypto = require('node:crypto');
const { encryptString, decryptString } = require('./crypto-tokens');
const { equal } = require('./session');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Names a person could mistake for a ClosedHand or mail service address.
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'account', 'accounts', 'auth', 'login', 'mail', 'smtp', 'support', 'status', 'cloud', 'dashboard', 'closedhand',
  'autodiscover', 'autoconfig', 'mta-sts', 'webmail', 'imap', 'pop', 'mx', 'ns1', 'ns2', 'sso', 'id', 'help', 'security', 'docs', 'relay', 'assist',
  'billing', 'pay', 'secure', 'static', 'cdn', 'blog', 'open', 'keep', 'setup']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

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
function installation(req) {
  const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  return match && uuid.test(match[1]) ? { id: match[1], secret: match[2], secret_hash: hash(match[2]) } : null;
}

// A ticket carries a naming request from the copy to its owner's browser.
// It names the copy (by the hash of its secret, never the secret) and the
// address asked for, and is good for thirty minutes.
function ticketFor(request, secret, now = Date.now()) {
  const text = Buffer.from(JSON.stringify({ ...request, version: 2, expires: now + 30 * 60000 })).toString('base64url');
  return text + '.' + crypto.createHmac('sha256', secret).update('phone-pair:' + text).digest('hex');
}
function readTicket(ticket, secret) {
  if (typeof ticket !== 'string' || ticket.length > 1000) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
  if (!equal(parts[1], crypto.createHmac('sha256', secret).update('phone-pair:' + parts[0]).digest('hex'))) return null;
  try {
    const t = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return t.version === 2 && uuid.test(t.id) && /^[a-f0-9]{64}$/.test(t.secret_hash) && validHostname(t.hostname) &&
      Number.isInteger(t.port) && t.port >= 1024 && t.port <= 65535 && typeof t.expires === 'number' ? t : null;
  } catch (_) { return null; }
}

class Refusal extends Error {}

// Reserve under one lock so two owners can never take the same name, one
// owner never gets two addresses, and the address limit is exact.
async function reserve(pool, { ownerId, ticket, limit }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(490048)');
    const existing = (await client.query('SELECT * FROM addresses WHERE id = $1 FOR UPDATE', [ticket.id])).rows[0];
    if (existing) {
      if (existing.owner_id !== ownerId || existing.secret_hash !== ticket.secret_hash || existing.hostname !== ticket.hostname ||
          existing.web_port !== ticket.port || existing.state === 'revoked') {
        throw new Refusal('This computer already has a personal URL, or it belongs to another account.');
      }
      await client.query('COMMIT');
      return existing;
    }
    if ((await client.query('SELECT 1 FROM addresses WHERE owner_id = $1', [ownerId])).rowCount) throw new Refusal('This account already has a personal URL.');
    if ((await client.query('SELECT 1 FROM addresses WHERE hostname = $1', [ticket.hostname])).rowCount) throw new Refusal('That personal URL is already taken. Choose another name.');
    // Working addresses and fresh reservations count; released ones do not.
    const live = await client.query("SELECT count(*)::int AS n FROM addresses WHERE state <> 'revoked' AND (activated_at IS NOT NULL OR created_at > now() - interval '24 hours')");
    if (live.rows[0].n >= limit) throw new Refusal('Personal URLs are full for now. Try again later.');
    const row = (await client.query(
      'INSERT INTO addresses (id, owner_id, secret_hash, hostname, web_port) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [ticket.id, ownerId, ticket.secret_hash, ticket.hostname, ticket.port])).rows[0];
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
    const row = (await db.query('SELECT * FROM addresses WHERE id = $1', [copy.id])).rows[0];
    return row && equal(row.secret_hash, copy.secret_hash) && row.state !== 'revoked' ? { row, copy } : null;
  }

  app.post('/api/phone-enrollment/register', wrap(async (req, res) => {
    const copy = installation(req), { name, port } = req.body || {};
    if (!copy) return res.status(401).json({ error: 'Invalid installation.' });
    const hostname = typeof name === 'string' ? name + '.closedhand.ai' : '';
    if (!validHostname(hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return res.status(400).json({ error: 'Use 3 to 32 lowercase letters, numbers or hyphens. Start with a letter and end with a letter or number.' });
    }
    res.json({ ticket: ticketFor({ id: copy.id, secret_hash: copy.secret_hash, hostname, port }, secret) });
  }));

  // What the confirmation page shows. Progress is revealed only to the owner
  // of this exact request; an expired ticket can still show its owner a
  // finished request, but can never approve anything.
  app.post('/api/phone-enrollment/details', wrap(async (req, res) => {
    const t = readTicket(req.body?.ticket, secret);
    if (!t) return res.status(400).json({ error: 'This confirmation link is not valid. Start again in ClosedHand.' });
    let state = 'unconfirmed';
    const owner = sessions.owner(req);
    if (owner) {
      const row = (await db.query('SELECT owner_id, secret_hash, hostname, state FROM addresses WHERE id = $1', [t.id])).rows[0];
      if (row && row.owner_id === owner && row.hostname === t.hostname && equal(row.secret_hash, t.secret_hash)) state = row.state;
    }
    if (t.expires <= Date.now() && state === 'unconfirmed') return res.status(400).json({ error: 'This confirmation expired. Start again in ClosedHand.' });
    res.json({ url: 'https://' + t.hostname, state });
  }));

  app.post('/api/phone-enrollment/approve', wrap(async (req, res) => {
    const owner = sessions.owner(req), t = readTicket(req.body?.ticket, secret);
    if (!owner) return res.status(401).json({ error: 'Sign in to confirm that this personal URL is yours.' });
    if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this confirmation on ClosedHand.' });
    if (!t || t.expires <= Date.now()) return res.status(400).json({ error: 'This confirmation expired. Start again in ClosedHand.' });
    const row = await reserve(db, { ownerId: owner, ticket: t, limit });
    res.json({ state: row.state, url: 'https://' + row.hostname });
  }));

  app.get('/api/phone-enrollment/connection', wrap(async (req, res) => {
    const found = await owned(req);
    if (!found) return res.json({ state: 'unconfirmed' });
    const { row } = found;
    if (!['connecting', 'active'].includes(row.state)) return res.json({ state: row.state });
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
      const done = await db.query(
        "UPDATE addresses SET revocation_complete = true, tunnel_token = NULL, updated_at = now() WHERE id = $1 AND attempt_id = $2 AND state = 'revoked' AND lease_until > now() RETURNING id",
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
