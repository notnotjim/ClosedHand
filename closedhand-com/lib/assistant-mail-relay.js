// The assistant email relay. A copy of ClosedHand that turns on its own email
// address collects mail here and hands over replies; assistant-mail-worker.js
// moves mail between here and Amazon SES. It never runs a model, never sees a
// copy's mail or calendar credentials, and holds incoming mail only sealed to
// the copy's own key.
const crypto = require('node:crypto');
const usage = require('./assistant-mail-usage');
const p = require('./assistant-email-protocol');
const { encryptString } = require('./crypto-tokens');
function mustWrite(result) { if (result.error) throw new Error('Email storage is unavailable. Please try again.'); return result.data; }
// db: the query client over this service's Postgres (lib/db-driver-pg.js).
// owner(req): the signed-in closedhand.com owner, or null. ready(): whether
// the worker that moves mail is running; without it nothing would arrive.
function createRelay({ db, owner: signedIn, secret, env = process.env, baseUrl = 'https://closedhand.com', ready = () => true }) {
  // AWS approval and product release are separate decisions. Default closed.
  const enabled = () => env.ASSISTANT_EMAIL_ENABLED === '1' && env.ASSISTANT_EMAIL_RELEASED === '1';
  const buckets = new Map();
  let all = { until: 0, count: 0 };
  function gate(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!enabled()) { res.status(503).json({ error: 'Assistant email is not available yet.' }); return false; }
    const now = Date.now();
    if (all.until < now) all = { until: now + 60000, count: 0 };
    for (const [key, value] of buckets) if (value.until < now) buckets.delete(key);
    const key = req.ip || 'unknown', hit = buckets.get(key) || { until: now + 60000, count: 0 };
    hit.count++; buckets.set(key, hit);
    if (++all.count > 1800 || hit.count > 120) { res.status(429).json({ error: 'Please try again shortly.' }); return false; }
    return true;
  }
  const wrap = fn => async (req, res) => {
    if (!gate(req, res)) return;
    try { await fn(req, res); } catch (_) { res.status(503).json({ error: 'Could not finish that email request. Please try again.' }); }
  };
  async function account(req, res) {
    const proof = p.identity(req);
    if (!proof) { res.status(401).json({ error: 'Invalid installation.' }); return null; }
    const row = mustWrite(await db.from('mail_relay_accounts').select('*').eq('id', proof.id).maybeSingle());
    if (!row || !p.equal(row.secret_hash, proof.hash)) { res.status(401).json({ error: 'Confirm this email address from Settings first.' }); return null; }
    return row;
  }
  function register(app) {
    app.get('/api/assistant-mail-relay/availability', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ available: enabled() && env.ASSISTANT_EMAIL_PRODUCTION === '1' && ready() }); });
    app.post('/api/assistant-mail-relay/register', wrap(async (req, res) => {
      if (env.ASSISTANT_EMAIL_PRODUCTION !== '1') return res.status(503).json({ error: 'Email addresses are waiting for delivery approval. Please try again later.' });
      const proof = p.identity(req);
      if (!proof || !p.validPublicKey(req.body?.publicKey)) return res.status(400).json({ error: 'Invalid installation.' });
      const ticket = p.signTicket({ ...proof, publicKey: req.body.publicKey, name: p.header(req.body.name || 'ClosedHand', 60) }, secret);
      res.json({ url: baseUrl + '/assistant-email/confirm#' + ticket });
    }));
    app.post('/api/assistant-mail-relay/approve', wrap(async (req, res) => {
      const owner = signedIn(req);
      if (!owner) return res.status(401).json({ error: 'Sign in to confirm your email address.' });
      if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this page on ClosedHand to continue.' });
      const proof = p.readTicket(req.body?.ticket, secret);
      if (!proof) return res.status(400).json({ error: 'This link expired. Return to Settings and try again.' });
      // Replies go to this address, so it must be one the sign-in vouches for.
      const person = mustWrite(await db.from('owners').select('email,email_verified').eq('id', owner).maybeSingle());
      const email = person?.email_verified ? p.address(person.email) : null;
      if (!email) return res.status(400).json({ error: 'Sign in again with Google, or a personal Microsoft account, so replies go to an address they have confirmed.' });
      const launchOwners = (env.ASSISTANT_EMAIL_TEST_OWNERS || '').split(',').map(p.address).filter(Boolean);
      if (launchOwners.length && !launchOwners.includes(email)) return res.status(503).json({ error: 'Email beta is completing its final checks. Please try again later.' });
      let row = mustWrite(await db.from('mail_relay_accounts').select('*').eq('id', proof.id).maybeSingle());
      if (row && (row.owner_id !== owner || !p.equal(row.secret_hash, proof.hash) || row.public_key !== proof.publicKey)) return res.status(403).json({ error: 'This address belongs to another installation.' });
      if (!row) {
        const prefix = proof.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'closedhand';
        row = mustWrite(await db.rpc('provision_mail_relay_account', { installation: proof.id, owner, proof_hash: proof.hash, public_key_text: proof.publicKey, sender_address: prefix + '-' + crypto.randomBytes(4).toString('hex') + '@' + p.DOMAIN, verified_email: email }))[0];
        if (!row) return res.status(409).json({ error: 'This account already has three email installations. Pause an unused installation before adding another.' });
      }
      res.json({ address: row.address, email: row.owner_email });
    }));
    app.get('/api/assistant-mail-relay/status', wrap(async (req, res) => {
      const row = await account(req, res); if (!row) return;
      const control = mustWrite(await db.from('mail_relay_controls').select('paused').eq('id', true).single());
      res.json({ paused: control.paused, address: row.address, ownerEmail: row.owner_email, enabled: row.enabled, usage: await usage.usage(db, row), sandbox: env.ASSISTANT_EMAIL_PRODUCTION !== '1' });
    }));
    app.post('/api/assistant-mail-relay/state', wrap(async (req, res) => {
      const row = await account(req, res); if (!row) return;
      if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Choose whether email is enabled.' });
      mustWrite(await db.from('mail_relay_accounts').update({ enabled: req.body.enabled }).eq('id', row.id));
      res.json({ enabled: req.body.enabled });
    }));
    app.post('/api/assistant-mail-relay/cancel', wrap(async (req, res) => {
      const row = await account(req, res); if (!row) return;
      if (!Array.isArray(req.body?.ids) || req.body.ids.length > 100 || req.body.ids.some(id => !p.uuid(id))) return res.status(400).json({ error: 'Invalid deliveries.' });
      if (req.body.ids.length) mustWrite(await db.from('mail_relay_outbox').update({ state: 'cancelled', payload: null }).eq('account_id', row.id).in('id', req.body.ids).eq('state', 'pending'));
      res.json({ ok: true });
    }));
    app.post('/api/assistant-mail-relay/clear', wrap(async (req, res) => {
      const row = await account(req, res); if (!row) return;
      mustWrite(await db.from('mail_relay_accounts').update({ enabled: false }).eq('id', row.id));
      for (const table of ['mail_relay_inbound', 'mail_relay_consent']) mustWrite(await db.from(table).delete().eq('account_id', row.id));
      // Keep recipient counts for today's cap, but erase queued content.
      mustWrite(await db.from('mail_relay_outbox').update({ state: 'cancelled', payload: null }).eq('account_id', row.id).eq('state', 'pending'));
      mustWrite(await db.from('mail_relay_outbox').update({ payload: null }).eq('account_id', row.id));
      if (req.body?.remove === true) mustWrite(await db.from('mail_relay_accounts').delete().eq('id', row.id));
      else if (req.body?.resume === true && row.enabled) mustWrite(await db.from('mail_relay_accounts').update({ enabled: true }).eq('id', row.id));
      res.json({ ok: true });
    }));
    app.get('/api/assistant-mail-relay/inbox', wrap(async (req, res) => {
      const row = await account(req, res); if (!row) return;
      if (!row.enabled) return res.json({ messages: [] });
      const messages = mustWrite(await db.from('mail_relay_inbound').select('id,sealed,expires_at').eq('account_id', row.id).is('acknowledged_at', null).gt('expires_at', new Date().toISOString()).not('sealed', 'is', null).order('received_at').limit(1));
      mustWrite(await db.from('mail_relay_accounts').update({ last_seen_at: new Date().toISOString() }).eq('id', row.id));
      const expired = mustWrite(await db.from('mail_relay_inbound').select('id').eq('account_id', row.id).is('acknowledged_at', null).lt('expires_at', new Date().toISOString()).limit(1));
      res.json({ messages, expired: expired.length > 0 });
    }));
    app.post('/api/assistant-mail-relay/ack', wrap(async (req, res) => {
      const row = await account(req, res); if (!row) return;
      if (!p.uuid(req.body?.id)) return res.status(400).json({ error: 'Invalid delivery.' });
      mustWrite(await db.from('mail_relay_inbound').update({ acknowledged_at: new Date().toISOString(), sealed: null }).eq('account_id', row.id).eq('id', req.body.id));
      res.json({ ok: true });
    }));
    app.post('/api/assistant-mail-relay/outbox', wrap(async (req, res) => {
      const row = await account(req, res); if (!row) return;
      if (!row.enabled) return res.status(409).json({ error: 'This email address is paused.' });
      let mail;
      try { mail = p.outgoing(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!mail.replyToDelivery) {
        // A new email, such as a saved agent's results, goes to the owner only.
        // Nobody else can be reached this way, so a stolen copy credential
        // cannot turn the service into a way of mailing strangers.
        if (mail.to.some(recipient => recipient !== row.owner_email)) return res.status(403).json({ error: 'A new email from this address can only go to you.' });
        mail.inReplyTo = null; mail.references = [];
      } else {
        const source = mustWrite(await db.from('mail_relay_inbound').select('sender,authenticated,message_id').eq('account_id', row.id).eq('id', mail.replyToDelivery).maybeSingle());
        if (!source?.authenticated) return res.status(403).json({ error: 'This sender has not been verified.' });
        // A stolen client credential cannot turn this service into a broadcast relay.
        // A guest must have directly requested a reply, and must be this turn's sender.
        for (const recipient of mail.to) {
          if (recipient === row.owner_email) continue;
          const consent = mustWrite(await db.from('mail_relay_consent').select('expires_at').eq('account_id', row.id).eq('address', recipient).gt('expires_at', new Date().toISOString()).maybeSingle());
          if (recipient !== source.sender || !consent) return res.status(403).json({ error: 'This person needs to email this address directly before it can reply to them.' });
        }
        mail.inReplyTo = source.message_id;
      }
      const hash = p.digest(JSON.stringify(mail));
      const existing = mustWrite(await db.from('mail_relay_outbox').select('id,account_id,request_hash,state').eq('id', mail.id).maybeSingle());
      if (existing) {
        if (existing.account_id !== row.id || existing.request_hash !== hash) return res.status(409).json({ error: 'This delivery ID is already in use.' });
        return res.json({ id: existing.id, state: existing.state });
      }
      const reserved = await usage.reserve(db, 'out:' + mail.id, row.id, 'out', mail.to.length, Buffer.byteLength(JSON.stringify(mail)) + 8192);
      if (!reserved.allowed) return res.status(429).json({ error: reserved.reason });
      const payload = encryptString(JSON.stringify(mail));
      if (!payload.startsWith('enc:v1:')) throw new Error('Encryption unavailable');
      const saved = await db.from('mail_relay_outbox').insert({ id: mail.id, account_id: row.id, request_hash: hash, payload, recipients: mail.to });
      if (saved.error?.code === '23505') {
        const duplicate = mustWrite(await db.from('mail_relay_outbox').select('id,account_id,request_hash,state').eq('id', mail.id).single());
        if (duplicate.account_id === row.id && duplicate.request_hash === hash) return res.json({ id: duplicate.id, state: duplicate.state });
        return res.status(409).json({ error: 'This delivery ID is already in use.' });
      }
      mustWrite(saved); res.json({ id: mail.id, state: 'pending' });
    }));
    app.get('/api/assistant-mail-relay/outbox/:id', wrap(async (req, res) => {
      const row = await account(req, res); if (!row) return;
      if (!p.uuid(req.params.id)) return res.status(400).json({ error: 'Invalid delivery.' });
      const job = mustWrite(await db.from('mail_relay_outbox').select('id,state,error,provider_id').eq('account_id', row.id).eq('id', req.params.id).maybeSingle());
      if (!job) return res.status(404).json({ error: 'Delivery not found.' });
      res.json(job);
    }));
  }
  return { register };
}
module.exports = { createRelay, mustWrite };
