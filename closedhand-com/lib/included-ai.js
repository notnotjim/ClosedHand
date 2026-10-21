// The AI that comes with Closedhand. When an account claims its personal URL,
// closedhand.com makes it an OpenRouter key of its own (OpenRouter's
// provisioning API) and hands it, once, to the computer that claimed. That
// computer then talks to OpenRouter directly, so no message ever passes
// through here; what stays here is the key's hash and the credit it started
// with.
//
// Every key is attached to one guardrail: it can use only the models
// Closedhand chose, and only on providers that keep nothing. An account has
// one key: claiming again makes a new key with whatever credit was left and
// deletes the old one.
//
// The free use is given once per person, ever (starter_grants keeps a one-way
// fingerprint of the sign-in, also after the account is deleted), to at most
// a few people per internet connection a month, and within a daily and a
// monthly ceiling on new free use, so nobody can collect it by making account
// after account and no burst can spend a month's in a day.
//
// Closedhand picks the models (INCLUDED_AI_MODELS) and can change them without
// a release: each computer asks for the current pick a few times a day
// (current) and switches itself over. Models being switched away from stay
// allowed for that while (INCLUDED_AI_RETIRING_MODELS), so no computer is cut
// off between the change and its next look.
// Past a limit, without a provisioning key, or with OpenRouter unreachable,
// the claim goes on without a key and setup asks for an LLM provider instead.
//
// Closedhand+ (lib/plus.js) continues it: a subscriber's key has a fair-use
// ceiling that OpenRouter resets every month (limit_reset), doubled for the
// month the person paid to carry on past it. A subscriber is never held to
// the free use's limits; one whose account has no key gets one the next time
// their computer asks (collect), and an ended subscription stops the key.
const crypto = require('crypto');

const API = 'https://openrouter.ai/api/v1';
const GUARDRAIL = 'Closedhand included AI';

// The part of an address that is one connection: all of an IPv4 address, the
// first half of an IPv6 one (a home gets a whole /64).
function connection(ip) {
  const text = String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (!text) return null;
  if (!text.includes(':')) return text;
  const [head, tail = ''] = text.split('::');
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const full = text.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return full.slice(0, 4).map(part => parseInt(part || '0', 16).toString(16)).join(':');
}

function create({ db, env = process.env, request = fetch }) {
  const managementKey = String(env.OPENROUTER_PROVISIONING_KEY || '');
  const starter = Number(env.INCLUDED_AI_STARTER_USD || 10);
  const monthlyCap = Number(env.INCLUDED_AI_MONTHLY_CAP_USD || 1000);
  const dailyCap = Number(env.INCLUDED_AI_DAILY_CAP_USD || 250);
  const perConnection = Number(env.INCLUDED_AI_PER_CONNECTION || 3);
  const pepper = String(env.TOKEN_ENCRYPTION_KEY || '');
  const fingerprint = (kind, text) => crypto.createHmac('sha256', pepper).update('included-ai-' + kind + ':' + text).digest('hex');
  const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  const models = list(env.INCLUDED_AI_MODELS || 'deepseek/deepseek-v4.1-flash');
  const allowed = [...new Set([...models, ...list(env.INCLUDED_AI_RETIRING_MODELS)])];
  const fairUse = Number(env.INCLUDED_AI_FAIR_USE_USD || 20);
  const enabled = () => managementKey.startsWith('sk-or-') && pepper.length >= 16 && starter > 0 && models.length > 0;
  const thisMonth = () => new Date().toISOString().slice(0, 7);

  async function api(path, method = 'GET', body) {
    const response = await request(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + managementKey, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://closedhand.com', 'X-Title': 'Closedhand' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!response.ok) throw Object.assign(new Error(`OpenRouter answered ${response.status} to ${method} ${path.split('?')[0]}`), { status: response.status });
    return json;
  }

  // The one guardrail every key made here is attached to, made the first time
  // and brought up to date with the chosen models after each start.
  let guardrailId = null;
  async function guardrail() {
    if (guardrailId) return guardrailId;
    const rules = {
      allowed_models: allowed,
      enforce_zdr_anthropic: true, enforce_zdr_openai: true, enforce_zdr_google: true, enforce_zdr_xai: true, enforce_zdr_other: true,
      allow_safety_retention_google: false, allow_safety_retention_other: false,
      enable_free_model_training: false, enable_paid_model_training: false, enable_free_model_publication: false,
    };
    const listed = await api('/guardrails?limit=100');
    const found = (listed?.data || []).find(g => g.name === GUARDRAIL);
    if (found) {
      await api('/guardrails/' + found.id, 'PATCH', rules);
      guardrailId = found.id;
    } else {
      const made = await api('/guardrails', 'POST', { name: GUARDRAIL, description: 'Keys made for Closedhand accounts: the models Closedhand chose, on providers that keep nothing.', ...rules });
      guardrailId = made?.data?.id || made?.id || null;
    }
    if (!guardrailId) throw new Error('OpenRouter did not return the guardrail');
    return guardrailId;
  }

  async function makeKey(ownerId, limit, { monthly = false } = {}) {
    const made = await api('/keys', 'POST', { name: 'Closedhand ' + ownerId, limit: Math.round(limit * 100) / 100, ...(monthly ? { limit_reset: 'monthly' } : {}) });
    const key = made?.key, hash = made?.data?.hash;
    if (typeof key !== 'string' || !key.startsWith('sk-or-') || typeof hash !== 'string') throw new Error('OpenRouter did not return a key');
    try {
      await api('/guardrails/' + await guardrail() + '/assignments/keys', 'POST', { key_hashes: [hash] });
    } catch (error) {
      // A key without its guardrail could use any model: it never leaves here.
      await api('/keys/' + hash, 'DELETE').catch(() => {});
      throw error;
    }
    return { key, hash };
  }

  // The key for an account that has just claimed its personal URL, from the
  // address the claim came from, or null when none can be given now. Never
  // throws: the claim must go on.
  async function forOwner(ownerId, { ip } = {}) {
    if (!enabled()) return null;
    try {
      const held = (await db.query('SELECT * FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
      const sub = await subscription(ownerId);
      if (held) {
        const oldHash = held.key_hash;
        let made;
        if (sub) made = await makeKey(ownerId, limitFor(sub), { monthly: true });
        else {
          const old = (await api('/keys/' + oldHash))?.data;
          const left = old ? Number(old.limit_remaining ?? (Number(old.limit) - Number(old.usage))) : 0;
          if (!(left > 0.01)) return null;
          made = await makeKey(ownerId, left);
        }
        await db.query('UPDATE included_ai_keys SET key_hash = $2, updated_at = now() WHERE owner_id = $1', [ownerId, made.hash]);
        await api('/keys/' + oldHash, 'DELETE').catch(e => console.error('[included ai] could not delete a replaced key:', e.message));
        return { key: made.key, models: roles() };
      }
      if (sub) return await keyForSubscriber(ownerId, sub);
      const who = (await db.query('SELECT provider, subject FROM owners WHERE id = $1', [ownerId])).rows[0];
      const person = fingerprint('person', who && who.subject ? who.provider + ':' + who.subject : 'owner:' + ownerId);
      const place = connection(ip) && fingerprint('connection', connection(ip));
      await db.query("UPDATE starter_grants SET network_hash = NULL WHERE network_hash IS NOT NULL AND granted_at < now() - interval '30 days'");
      const refused = (await db.query('SELECT 1 FROM starter_grants WHERE person_hash = $1', [person])).rowCount ? 'this sign-in has had it'
        : await full(place);
      if (refused) {
        console.log('[included ai] no free use given: ' + refused);
        return null;
      }
      // Held first, so two claims at once can't both have it.
      const given = await db.query(
        'INSERT INTO starter_grants (person_hash, network_hash, granted_usd) VALUES ($1, $2, $3) ON CONFLICT (person_hash) DO NOTHING RETURNING id',
        [person, place, starter]);
      if (!given.rowCount) return null;
      let made;
      try { made = await makeKey(ownerId, starter); }
      catch (error) { await db.query('DELETE FROM starter_grants WHERE id = $1', [given.rows[0].id]); throw error; }
      await db.query('INSERT INTO included_ai_keys (owner_id, key_hash, granted_usd) VALUES ($1, $2, $3)', [ownerId, made.hash, starter]);
      return { key: made.key, models: roles() };
    } catch (error) {
      console.error('[included ai] no key made:', error.message);
      return null;
    }
  }

  // Why no more free use can go to this connection now, or null when it can.
  async function full(place) {
    if (place && Number((await db.query(
      "SELECT count(*) AS n FROM starter_grants WHERE network_hash = $1 AND granted_at >= now() - interval '30 days'", [place])).rows[0].n) >= perConnection) {
      return 'this connection has had it ' + perConnection + ' times in 30 days';
    }
    const given = (await db.query(
      `SELECT COALESCE(SUM(granted_usd) FILTER (WHERE granted_at >= now() - interval '1 day'), 0) AS day,
              COALESCE(SUM(granted_usd) FILTER (WHERE granted_at >= date_trunc('month', now())), 0) AS month
         FROM starter_grants WHERE granted_at >= LEAST(now() - interval '1 day', date_trunc('month', now()))`)).rows[0];
    if (Number(given.day) + starter > dailyCap) return "today's ceiling is reached";
    if (Number(given.month) + starter > monthlyCap) return "this month's ceiling is reached";
    return null;
  }

  // Whether a claim made now, from this address, would come with a key, so
  // setup can say the LLM is included before the personal URL is claimed.
  async function offered({ ip } = {}) {
    if (!enabled()) return false;
    try { return !(await full(connection(ip) && fingerprint('connection', connection(ip)))); } catch (_) { return false; }
  }

  // Closedhand+: the account's subscription while it gives access (Polar keeps
  // access through a failed payment it is still retrying), or null.
  async function subscription(ownerId) {
    return (await db.query(
      "SELECT status, extended_month FROM plus_subscriptions WHERE owner_id = $1 AND status IN ('active', 'trialing', 'past_due')", [ownerId])).rows[0] || null;
  }
  const limitFor = sub => fairUse * (sub.extended_month === thisMonth() ? 2 : 1);

  // A subscriber's key, made now: no free-use limits apply. Saved first, so two
  // requests at once can't both hand one out; the loser's key is deleted.
  async function keyForSubscriber(ownerId, sub) {
    const made = await makeKey(ownerId, limitFor(sub), { monthly: true });
    const saved = await db.query(
      'INSERT INTO included_ai_keys (owner_id, key_hash, granted_usd) VALUES ($1, $2, 0) ON CONFLICT (owner_id) DO NOTHING RETURNING owner_id', [ownerId, made.hash]);
    if (!saved.rowCount) {
      await api('/keys/' + made.hash, 'DELETE').catch(() => {});
      return null;
    }
    return { key: made.key, models: roles() };
  }

  // A key for a subscriber whose account holds none (the free use was never
  // given, or the subscription came first), handed once to their computer
  // when it next asks. Null for anyone else. Never throws.
  async function collect(ownerId) {
    if (!enabled()) return null;
    try {
      const sub = await subscription(ownerId);
      if (!sub || (await db.query('SELECT 1 FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rowCount) return null;
      return await keyForSubscriber(ownerId, sub);
    } catch (error) {
      console.error('[included ai] no key collected:', error.message);
      return null;
    }
  }

  // The held key set to what the subscription gives: the fair-use ceiling,
  // reset every month, or twice it in the month the person paid to carry on.
  // False when the account holds no key yet (its computer collects one).
  async function subscribe(ownerId) {
    if (!enabled()) return false;
    const sub = await subscription(ownerId);
    const held = (await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!sub || !held) return false;
    await api('/keys/' + held.key_hash, 'PATCH', { limit: limitFor(sub), limit_reset: 'monthly' });
    return true;
  }

  // An ended subscription stops the key where it stands: its limit becomes
  // what it has used, never reset. False when there is no key.
  async function end(ownerId) {
    if (!enabled()) return false;
    const held = (await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held) return false;
    const used = Number((await api('/keys/' + held.key_hash))?.data?.usage || 0);
    await api('/keys/' + held.key_hash, 'PATCH', { limit: Math.floor(used * 100) / 100, limit_reset: null });
    return true;
  }

  // Run hourly: a month someone carried on past fair use is over once the
  // month changes, and their key goes back to the fair-use ceiling.
  async function sweep() {
    const over = (await db.query(
      'SELECT owner_id FROM plus_subscriptions WHERE extended_month IS NOT NULL AND extended_month <> $1', [thisMonth()])).rows;
    for (const { owner_id: ownerId } of over) {
      await db.query('UPDATE plus_subscriptions SET extended_month = NULL, key_synced = false, updated_at = now() WHERE owner_id = $1', [ownerId]);
    }
    return over.length;
  }

  // Which model does which job: the person's computer uses these as given.
  function roles() {
    return { chat: models[0], background: models[1] || models[0] };
  }

  // Deleting an account deletes its key. Its row goes with the account.
  async function forget(ownerId) {
    const held = (await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held || !enabled()) return;
    await api('/keys/' + held.key_hash, 'DELETE').catch(e => console.error('[included ai] could not delete a key:', e.message));
  }

  // The models in use now, for computers checking whether Closedhand has
  // switched them.
  function current() {
    return enabled() ? roles() : null;
  }

  return { forOwner, forget, offered, current, enabled, collect, subscribe, end, sweep, fairUse };
}

module.exports = { create };
