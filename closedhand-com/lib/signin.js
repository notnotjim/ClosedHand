// Sign in with Google or Microsoft, asking only for name and email.
// The provider's permanent account ID decides who someone is (owners.js).
const crypto = require('node:crypto');
const navigation = require('../public/entry-navigation');
const { ownerFor } = require('./owners');

const PERSONAL_ACCOUNTS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    extra: { prompt: 'select_account', access_type: 'online', include_granted_scopes: 'false' },
    // Google's ID never changes; its verified address may claim an owner
    // carried over from the old service (owners.js).
    identity(claims, clientId) {
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== clientId) return null;
      if (typeof claims.sub !== 'string' || !claims.sub) return null;
      return { provider: 'google', subject: claims.sub, email: claims.email || null, emailVerified: claims.email_verified === true, name: claims.name || null };
    },
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid profile email',
    extra: { prompt: 'select_account' },
    // The directory plus the account's ID within it, which no organisation
    // can reassign. The email shown is whatever the account reports.
    identity(claims, clientId) {
      if (claims.aud !== clientId || !uuid.test(claims.tid || '')) return null;
      if (claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) return null;
      const id = uuid.test(claims.oid || '') ? claims.oid : (typeof claims.sub === 'string' && claims.sub ? 'sub:' + claims.sub : null);
      if (!id) return null;
      return { provider: 'microsoft', subject: claims.tid + ':' + id, email: claims.email || claims.preferred_username || null, emailVerified: false, name: claims.name || null,
        personal: claims.tid === PERSONAL_ACCOUNTS_TENANT };
    },
  },
};

// The ID token comes straight from the provider's token endpoint over TLS, in
// answer to a code only this service could redeem, so its claims are read
// without fetching signing keys (OpenID Connect Core 3.1.3.7).
function claimsOf(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); }
  catch (_) { return null; }
}

function register(app, { db, sessions, baseUrl, clients, request = fetch }) {
  const available = key => !!(clients[key]?.id && clients[key]?.secret);

  app.get('/auth/:provider', (req, res) => {
    const key = req.params.provider, provider = PROVIDERS[key];
    const back = navigation.signInReturn(req.query.return_to);
    if (!provider || !available(key)) return res.redirect(navigation.signInError(back));
    const verifier = crypto.randomBytes(32).toString('base64url');
    const pending = { provider: key, state: crypto.randomBytes(24).toString('base64url'), nonce: crypto.randomBytes(24).toString('base64url'), verifier, back };
    sessions.startSignIn(res, pending);
    const params = new URLSearchParams({
      client_id: clients[key].id,
      redirect_uri: `${baseUrl}/auth/${key}/callback`,
      response_type: 'code',
      scope: provider.scope,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...provider.extra,
    });
    res.redirect(provider.authorize + '?' + params);
  });

  app.get('/auth/:provider/callback', async (req, res) => {
    const key = PROVIDERS[req.params.provider] ? req.params.provider : 'unknown', provider = PROVIDERS[key];
    let back = '/open';
    const fail = why => {
      console.error(`[signin] ${key} sign-in did not finish: ${String(why).replace(/[^\x20-\x7e]/g, '?').slice(0, 120)}`);
      if (!res.headersSent) res.redirect(navigation.signInError(back));
    };
    try {
      const pending = sessions.pendingSignIn(req);
      sessions.finishSignIn(res);
      back = navigation.signInReturn(pending?.back);
      if (!provider || !available(key) || !pending || pending.provider !== key) return fail('no sign-in under way');
      if (typeof req.query.state !== 'string' || req.query.state !== pending.state) return fail('state mismatch');
      if (req.query.error || typeof req.query.code !== 'string') return fail(req.query.error || 'no code');
      const response = await request(provider.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${baseUrl}/auth/${key}/callback`,
          client_id: clients[key].id, client_secret: clients[key].secret, code_verifier: pending.verifier,
        }),
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      const tokens = await response.json();
      if (!response.ok || !tokens.id_token) return fail('token exchange ' + response.status);
      const claims = claimsOf(tokens.id_token);
      if (!claims || claims.nonce !== pending.nonce || !(claims.exp * 1000 > Date.now())) return fail('ID token rejected');
      const identity = provider.identity(claims, clients[key].id);
      if (!identity) return fail('identity rejected');
      sessions.signIn(res, await ownerFor(db, identity));
      res.redirect(back);
    } catch (e) {
      fail(e.message);
    }
  });

  app.post('/logout', (req, res) => { sessions.signOut(res); res.redirect(req.query.return_to ? navigation.signInReturn(req.query.return_to) : '/'); });

  return { available };
}

module.exports = { register, PROVIDERS, claimsOf };
