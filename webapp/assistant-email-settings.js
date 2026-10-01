const crypto = require('node:crypto');
const p = require('./assistant-email-protocol');
const { encryptString, decryptString } = require('./crypto-tokens');
const ORIGIN = 'https://closedhand.com';
// Availability is controlled by the private service, never by a client flag.
async function available() {
  const response = await fetch(ORIGIN + '/api/assistant-mail-relay/availability', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Email service status is unavailable. Please try again.');
  return (await response.json()).available === true;
}
function mustWrite(result) { if (result.error) throw new Error('Could not save email settings. Please try again.'); return result.data; }
function encrypted(value) { const out = encryptString(value); if (!out?.startsWith('enc:v1:')) throw new Error('Encrypted storage is unavailable.'); return out; }
async function call(account, path, method = 'GET', body) {
  const response = await fetch(ORIGIN + '/api/assistant-mail-relay/' + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: 'Bearer ' + account.install_id + '.' + decryptString(account.secret), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Email delivery is unavailable. Please try again.'); error.status = response.status; throw error; }
  return result;
}
function register(app, db, userId) {
  const wrap = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const owner = userId(req); if (!owner) return res.status(401).json({ error: 'Sign in to manage your email address.' });
    try { await fn(req, res, owner); } catch (e) { res.status(e.status === 400 ? 400 : 503).json({ error: e.message }); }
  };
  const record = async owner => mustWrite(await db.from('assistant_email_accounts').select('*').eq('user_id', owner).maybeSingle());
  app.get('/api/assistant-email', wrap(async (req, res, owner) => {
    if (!await available()) return res.json({ available: false });
    const account = await record(owner);
    const profile = mustWrite(await db.from('profiles').select('settings,display_name').eq('id', owner).single());
    const threads = mustWrite(await db.from('assistant_email_threads').select('id,subject,purpose,shared_brief,participants,expires_at,stopped').eq('user_id', owner).order('updated_at', { ascending: false }).limit(15));
    const attention = mustWrite(await db.from('assistant_email_messages').select('id,thread_id,direction,state,error,created_at').eq('user_id', owner).in('state', ['needs_review','awaiting_scope','failed','uncertain','bounced','complained','suppressed']).order('created_at', { ascending: false }).limit(15));
    const remote = account?.address ? await call(account, 'status') : null;
    const connections = account ? mustWrite(await db.from('connections').select('service,tokens,metadata').eq('user_id', owner)) : [];
    const ownerAddresses = account ? p.ownerAddresses(account, connections) : [];
    res.json({ available: true, ownerAddresses, usage: remote?.usage || null, servicePaused: !!remote?.paused, name: profile.settings?.bot_name || 'ClosedHand', address: account?.address || null, ownerEmail: account?.owner_email || null, enabled: !!account?.enabled, pending: !!account && !account.address, lastSyncAt: account?.last_sync_at, error: account?.last_error, threads, attention });
  }));
  app.post('/api/assistant-email/enable', wrap(async (req, res, owner) => {
    if (!await available()) return res.status(503).json({ error: 'Assistant email is coming soon.' });
    let account = await record(owner);
    if (!account) {
      const keys = p.keyPair();
      const result = await db.from('assistant_email_accounts').insert({ user_id: owner, install_id: crypto.randomUUID(), secret: encrypted(crypto.randomBytes(32).toString('hex')), private_key: encrypted(keys.privateKey), public_key: keys.publicKey });
      if (result.error?.code !== '23505') mustWrite(result);
      account = await record(owner);
    }
    const profile = mustWrite(await db.from('profiles').select('settings').eq('id', owner).single());
    const result = await call(account, 'register', 'POST', { publicKey: account.public_key, name: profile.settings?.bot_name || 'ClosedHand' });
    if (!result.url?.startsWith(ORIGIN + '/assistant-email/confirm#')) throw new Error('Could not verify the confirmation page.');
    res.json(result);
  }));
  app.post('/api/assistant-email/refresh', wrap(async (req, res, owner) => {
    const account = await record(owner); if (!account) return res.json({ pending: false });
    let status;
    try { status = await call(account, 'status'); } catch (e) { if (e.status === 401) return res.json({ pending: true }); throw e; }
    if (!p.address(status.address)?.endsWith('@' + p.DOMAIN) || !p.address(status.ownerEmail)) throw new Error('Could not verify this address.');
    mustWrite(await db.from('assistant_email_accounts').update({ address: status.address, owner_email: status.ownerEmail, enabled: status.enabled, last_error: null }).eq('user_id', owner));
    res.json({ pending: false, address: status.address, sandbox: status.sandbox });
  }));
  app.post('/api/assistant-email/state', wrap(async (req, res, owner) => {
    const account = await record(owner); if (!account?.address) return res.status(400).json({ error: 'Enable an email address first.' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Choose whether email is enabled.' });
    await call(account, 'state', 'POST', { enabled: req.body.enabled });
    mustWrite(await db.from('assistant_email_accounts').update({ enabled: req.body.enabled }).eq('user_id', owner));
    res.json({ ok: true });
  }));
  app.get('/api/assistant-email/threads/:id', wrap(async (req, res, owner) => {
    if (!p.uuid(req.params.id)) return res.status(400).json({ error: 'Invalid conversation.' });
    const messages = mustWrite(await db.from('assistant_email_messages').select('direction,envelope,state,error,created_at').eq('user_id', owner).eq('thread_id', req.params.id).order('created_at', { ascending: false }).limit(10));
    res.json({ messages: messages.reverse().map(m => ({ direction: m.direction, from: m.envelope.from, text: m.envelope.text, state: m.state, error: m.error })) });
  }));
  app.post('/api/assistant-email/threads/:id', wrap(async (req, res, owner) => {
    if (!p.uuid(req.params.id)) return res.status(400).json({ error: 'Invalid conversation.' });
    const thread = mustWrite(await db.from('assistant_email_threads').select('id,participants').eq('user_id', owner).eq('id', req.params.id).maybeSingle());
    if (!thread) return res.status(404).json({ error: 'Conversation not found.' });
    const { stopped, purpose, sharedBrief, participants } = req.body || {};
    let update;
    if (stopped === true) {
      const account = await record(owner);
      const jobs = mustWrite(await db.from('assistant_email_messages').select('id').eq('user_id', owner).eq('thread_id', thread.id).eq('direction', 'out').in('state', ['outbox','submitting','pending']));
      if (account?.address && jobs.length) await call(account, 'cancel', 'POST', { ids: jobs.map(j => j.id) });
      mustWrite(await db.from('assistant_email_messages').update({ state: 'cancelled' }).eq('user_id', owner).eq('thread_id', thread.id).eq('direction', 'out').in('state', ['outbox','submitting','pending']));
      update = { stopped: true };
    }
    else {
      if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 500 || typeof sharedBrief !== 'string' || !sharedBrief.trim() || sharedBrief.length > 10000) return res.status(400).json({ error: 'Add the task and the details this conversation may use.' });
      let people; try { people = p.addresses(participants); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!people.length || people.some(email => !thread.participants.includes(email))) return res.status(400).json({ error: 'Choose people already in this conversation.' });
      update = { scope_id: crypto.randomUUID(), purpose, shared_brief: sharedBrief, participants: people, expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), stopped: false };
    }
    mustWrite(await db.from('assistant_email_threads').update({ ...update, updated_at: new Date().toISOString() }).eq('user_id', owner).eq('id', thread.id));
    if (!update.stopped) mustWrite(await db.from('assistant_email_messages').update({ state: 'pending', error: null }).eq('user_id', owner).eq('thread_id', thread.id).eq('state', 'awaiting_scope'));
    res.json({ ok: true });
  }));
}
async function clear(db, owner, remove = false, keepEnabled = false) {
  const account = mustWrite(await db.from('assistant_email_accounts').select('*').eq('user_id', owner).maybeSingle());
  if (account?.address) await call(account, 'clear', 'POST', { remove, resume: keepEnabled });
  if (account) mustWrite(await db.from('assistant_email_accounts').update({ enabled: keepEnabled && account.enabled }).eq('user_id', owner));
  mustWrite(await db.from('assistant_email_threads').delete().eq('user_id', owner));
}
module.exports = { register, call, mustWrite, clear };
