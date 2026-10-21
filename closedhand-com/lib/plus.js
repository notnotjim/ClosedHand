// Closedhand+: Closedhand Managed Models carried on after the free use, for a
// monthly payment. Polar sells it (it is the merchant of record: it takes the
// card, charges tax and handles refunds), so nothing about a payment is kept
// here, only what the subscription allows. The person subscribes from their
// account on closedhand.com; Polar tells closedhand.com what happened through
// signed webhooks; the account's OpenRouter key (included-ai.js) is then set
// to the fair-use ceiling, or stopped when the subscription ends. Managing or
// cancelling happens in Polar's customer portal. Past fair use, a one-time
// purchase carries the person on to the end of the month.
const crypto = require('crypto');
const { equal } = require('./session');

const LIVE = ['active', 'trialing', 'past_due'];
// Polar's clock and ours may differ a little; anything older is a replay.
const TOLERANCE_S = 5 * 60;

// The keys a webhook may be signed with. A secret made since 8 September 2026
// is a Standard Webhooks secret: "whsec_" then the key in base64. An older one
// signs with the UTF-8 bytes of the whole string. Both are tried, as Polar's
// own libraries do.
function signingKeys(secret) {
  const keys = [Buffer.from(secret, 'utf8')];
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    const key = Buffer.from(encoded, 'base64');
    if (key.length >= 16) keys.unshift(key);
  }
  return keys;
}

// Standard Webhooks: webhook-signature carries one or more "v1,<base64>",
// each an HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<body>".
function verify(headers, raw, secret, now = Date.now()) {
  const id = headers['webhook-id'], at = headers['webhook-timestamp'], signature = headers['webhook-signature'];
  if (!secret || !id || !at || !signature || !Buffer.isBuffer(raw)) return false;
  const seconds = Number(at);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > TOLERANCE_S) return false;
  const signed = Buffer.concat([Buffer.from(`${id}.${at}.`, 'utf8'), raw]);
  const given = String(signature).split(' ').map(part => part.split(',')).filter(([v, sig]) => v === 'v1' && sig).map(([, sig]) => sig);
  return signingKeys(secret).some(key => {
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    return given.some(sig => equal(sig, expected));
  });
}

function create({ db, env = process.env, request = fetch, includedAi, baseUrl = 'https://closedhand.com' }) {
  const API = env.POLAR_SERVER === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
  const token = String(env.POLAR_ACCESS_TOKEN || '');
  const webhookSecret = String(env.POLAR_WEBHOOK_SECRET || '');
  const plusProduct = String(env.POLAR_PLUS_PRODUCT_ID || '');
  const extendProduct = String(env.POLAR_EXTEND_PRODUCT_ID || '');
  const enabled = () => !!(token && webhookSecret && plusProduct && includedAi?.enabled());
  const thisMonth = () => new Date().toISOString().slice(0, 7);

  async function api(path, method = 'GET', body) {
    const response = await request(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!response.ok) throw Object.assign(new Error(`Polar answered ${response.status} to ${method} ${path}`), { status: response.status, reason: String(json?.error || '') });
    return json;
  }

  async function row(ownerId) {
    return (await db.query('SELECT * FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0] || null;
  }

  // What the account page and the person's computer are told: whether it is
  // on, and when it renews or ends. Never anything about the payment.
  async function state(ownerId) {
    const sub = ownerId ? await row(ownerId) : null;
    const active = !!sub && LIVE.includes(sub.status);
    const until = sub?.current_period_end ? new Date(sub.current_period_end).toISOString() : null;
    return {
      available: enabled(),
      active,
      ...(active && until ? (sub.cancel_at_period_end ? { ends_at: until } : { renews_at: until }) : {}),
      extended: active && sub.extended_month === thisMonth(),
    };
  }

  // Polar's checkout for one product, tied to this account by its own ID, so
  // the webhooks that follow can name it.
  async function checkoutFor(owner, product, back) {
    const made = await api('/v1/checkouts/', 'POST', {
      products: [product],
      external_customer_id: owner.id,
      ...(owner.email ? { customer_email: owner.email } : {}),
      success_url: baseUrl + '/account?plus=' + back,
      metadata: { owner_id: owner.id },
    });
    if (typeof made?.url !== 'string' || !made.url.startsWith('https://')) throw new Error('Polar did not return a checkout');
    return made.url;
  }
  const checkout = owner => checkoutFor(owner, plusProduct, 'welcome');
  const extend = owner => checkoutFor(owner, extendProduct, 'extended');

  // Polar's customer portal, where the person changes their card, sees their
  // invoices or cancels.
  async function portal(owner) {
    const made = await api('/v1/customer-sessions/', 'POST', { external_customer_id: owner.id, return_url: baseUrl + '/account' });
    if (typeof made?.customer_portal_url !== 'string') throw new Error('Polar did not return a portal');
    return made.customer_portal_url;
  }

  // The key made to match the subscription, now or by the hourly sweep. A
  // subscription that never went through leaves the free use alone; only one
  // that was active and has ended stops the key.
  async function sync(ownerId) {
    const sub = (await db.query('SELECT status, started_at, updated_at::text AS stamp FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0];
    if (!sub) return;
    if (LIVE.includes(sub.status)) await includedAi.subscribe(ownerId);
    else if (sub.started_at) await includedAi.end(ownerId);
    // Only if nothing changed meanwhile; a newer event syncs again.
    await db.query('UPDATE plus_subscriptions SET key_synced = true WHERE owner_id = $1 AND updated_at::text = $2', [ownerId, sub.stamp]);
  }
  const syncLater = ownerId => { sync(ownerId).catch(e => console.error('[plus] key not set yet:', e.message)); };

  // Which account an event is about: the ID it was sold under, or the
  // checkout's metadata. Only accounts that still exist.
  async function ownerOf(data) {
    const id = data?.customer?.external_id || data?.metadata?.owner_id;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
    return (await db.query('SELECT id FROM owners WHERE id = $1', [id])).rows[0]?.id || null;
  }

  // One webhook event. Returns what was done, for the log.
  async function handle(event) {
    const type = String(event?.type || ''), data = event?.data || {};
    if (type.startsWith('subscription.')) {
      if (data.product_id !== plusProduct) return 'another product';
      const ownerId = await ownerOf(data);
      if (!ownerId || typeof data.id !== 'string') return 'no account';
      const status = String(data.status || '');
      const at = data.modified_at || data.created_at || event.timestamp || null;
      // A newer event wins; an older one for the same subscription, or an
      // ended old subscription after a new one began, changes nothing.
      const saved = await db.query(
        `INSERT INTO plus_subscriptions (owner_id, polar_customer_id, polar_subscription_id, status, current_period_end, cancel_at_period_end, started_at, key_synced, event_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = ANY($8::text[]) THEN now() END, false, $7, now())
         ON CONFLICT (owner_id) DO UPDATE SET polar_customer_id = EXCLUDED.polar_customer_id, polar_subscription_id = EXCLUDED.polar_subscription_id,
           status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           started_at = COALESCE(plus_subscriptions.started_at, EXCLUDED.started_at), key_synced = false, event_at = EXCLUDED.event_at, updated_at = now()
         WHERE (plus_subscriptions.polar_subscription_id = EXCLUDED.polar_subscription_id
                AND (plus_subscriptions.event_at IS NULL OR EXCLUDED.event_at IS NULL OR EXCLUDED.event_at >= plus_subscriptions.event_at))
            OR (plus_subscriptions.polar_subscription_id <> EXCLUDED.polar_subscription_id
                AND (EXCLUDED.status = ANY($8::text[]) OR NOT plus_subscriptions.status = ANY($8::text[])))
         RETURNING owner_id`,
        [ownerId, data.customer_id || data.customer?.id || null, data.id, status, data.current_period_end || null, data.cancel_at_period_end === true, at, LIVE]);
      if (!saved.rowCount) return 'older than what is known';
      syncLater(ownerId);
      return 'subscription ' + status;
    }
    if (type === 'order.paid') {
      if ((data.product_id || data.product?.id) !== extendProduct || !extendProduct) return 'not carrying on';
      const ownerId = await ownerOf(data);
      if (!ownerId) return 'no account';
      const updated = await db.query(
        'UPDATE plus_subscriptions SET extended_month = $2, key_synced = false, updated_at = now() WHERE owner_id = $1 AND status = ANY($3::text[]) RETURNING owner_id',
        [ownerId, thisMonth(), LIVE]);
      if (!updated.rowCount) return 'not subscribed';
      syncLater(ownerId);
      return 'carried on to the end of the month';
    }
    return 'not used';
  }

  // Run hourly, after included-ai.js's own sweep has ended months carried on
  // past fair use: any key not yet set to match its subscription (OpenRouter
  // was unreachable, or that month just ended) is tried again.
  async function sweep() {
    if (!enabled()) return 0;
    const unsynced = (await db.query('SELECT owner_id FROM plus_subscriptions WHERE NOT key_synced LIMIT 50')).rows;
    for (const { owner_id: ownerId } of unsynced) await sync(ownerId).catch(e => console.error('[plus] sweep:', e.message));
    return unsynced.length;
  }

  // Deleting an account first stops its subscription at Polar, so nobody is
  // charged for an account that no longer exists. Throws when Polar could not
  // be reached, so the deletion waits for a retry.
  async function forget(ownerId) {
    const sub = await row(ownerId);
    if (!sub || !LIVE.includes(sub.status)) return false;
    // Gone already, or already cancelled, is done. Any other refusal (a token
    // without the right to cancel answers 403 too) keeps the account, so
    // nobody is billed for one that no longer exists.
    try { await api('/v1/subscriptions/' + encodeURIComponent(sub.polar_subscription_id), 'DELETE'); }
    catch (e) { if (e.status !== 404 && !(e.status === 403 && /AlreadyCanceled/i.test(e.reason))) throw e; }
    return true;
  }

  // The account page's buttons, for the signed-in person on closedhand.com.
  function register(app, { sessions }) {
    const signedIn = async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const ownerId = sessions.owner(req);
      if (!ownerId) { res.status(401).json({ error: 'Sign in to your Closedhand account first.' }); return null; }
      if (req.headers.origin !== baseUrl) { res.status(403).json({ error: 'Open this on closedhand.com.' }); return null; }
      if (!enabled()) { res.status(503).json({ error: 'Closedhand+ is not available yet.' }); return null; }
      const owner = (await db.query('SELECT id, email FROM owners WHERE id = $1', [ownerId])).rows[0];
      if (!owner) { res.status(401).json({ error: 'Sign in to your Closedhand account first.' }); return null; }
      return owner;
    };
    const route = (path, fn) => app.post(path, async (req, res) => {
      try {
        const owner = await signedIn(req, res);
        if (owner) await fn(owner, req, res);
      } catch (e) {
        console.error('[plus]', path, e.message);
        res.status(503).json({ error: 'Could not reach the payment service just now. Please try again.' });
      }
    });
    route('/api/plus/checkout', async (owner, req, res) => {
      if ((await state(owner.id)).active) return res.status(409).json({ error: 'You already have Closedhand+.' });
      const address = (await db.query("SELECT 1 FROM addresses WHERE owner_id = $1 AND state <> 'revoked'", [owner.id])).rowCount;
      if (!address) return res.status(409).json({ error: 'Claim your personal URL from Closedhand on your computer first.' });
      res.json({ url: await checkout(owner) });
    });
    route('/api/plus/extend', async (owner, req, res) => {
      const now = await state(owner.id);
      if (!now.active) return res.status(409).json({ error: 'Carrying on past fair use is part of Closedhand+.' });
      if (now.extended || !extendProduct) return res.status(409).json({ error: 'You can already carry on to the end of this month.' });
      res.json({ url: await extend(owner) });
    });
    route('/api/plus/manage', async (owner, req, res) => {
      if (!(await row(owner.id))) return res.status(409).json({ error: 'You have not subscribed to Closedhand+.' });
      res.json({ url: await portal(owner) });
    });
    // Polar's webhooks: the raw body is kept (server.js) for the signature.
    // Answered at once; the key follows in the background, as Polar asks.
    app.post('/api/plus/webhook', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!verify(req.headers, req.body, webhookSecret)) return res.status(403).json({ error: 'Invalid signature' });
      let event;
      try { event = JSON.parse(req.body.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'Invalid body' }); }
      try {
        const done = await handle(event);
        console.log(`[plus] ${String(event?.type).slice(0, 40)}: ${done}`);
        res.status(202).json({ ok: true });
      } catch (e) {
        // Polar tries again later.
        console.error('[plus] webhook:', e.message);
        res.status(500).json({ error: 'Could not record the event' });
      }
    });
  }

  return { enabled, state, checkout, extend, portal, handle, sweep, sync, forget, register };
}

module.exports = { create, verify, signingKeys };
