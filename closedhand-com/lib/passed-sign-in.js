// A Google or Microsoft sign-in that Closedhand on someone's computer passes
// on, after connecting their mail through Closedhand's own Google or Microsoft
// app. A sign-in on closedhand.com itself comes straight from the provider's
// token endpoint, so its claims can be read as they are (see signin.js); this
// one arrives from elsewhere, so it counts only when the provider's published
// keys show the provider signed it, for one of Closedhand's apps, and it has
// not expired. The issuer is checked with the rest of the identity (signin.js).
const crypto = require('node:crypto');

const KEYS = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  microsoft: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
};
const KEEP_KEYS = 6 * 60 * 60 * 1000;
const cached = {};

async function signingKeys(provider, request, fresh) {
  const held = cached[provider];
  if (!fresh && held && held.keys.length && Date.now() - held.at < KEEP_KEYS) return held.keys;
  const response = await request(KEYS[provider], { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(provider + ' keys ' + response.status);
  const keys = (await response.json()).keys;
  cached[provider] = { at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
  return cached[provider].keys;
}

function part(text) {
  try { return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')); } catch (_) { return null; }
}

// The token's claims when it checks out, otherwise null. appIds are the
// Closedhand apps for that provider a computer signs in through.
async function verifyPassedSignIn(provider, idToken, { appIds, request = fetch, now = Date.now() }) {
  if (!KEYS[provider]) return null;
  const pieces = typeof idToken === 'string' ? idToken.split('.') : [];
  if (pieces.length !== 3 || idToken.length > 16384) return null;
  const header = part(pieces[0]), claims = part(pieces[1]);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  // Providers roll their keys over now and then: an unknown key fetches them again once.
  let jwk = (await signingKeys(provider, request, false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(provider, request, true)).find(k => k.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA') return null;
  let key;
  try { key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }); } catch (_) { return null; }
  const signed = crypto.verify('RSA-SHA256', Buffer.from(pieces[0] + '.' + pieces[1]), key, Buffer.from(pieces[2], 'base64url'));
  if (!signed) return null;
  const seconds = now / 1000;
  if (typeof claims.exp !== 'number' || claims.exp < seconds - 60) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > seconds + 300) return null;
  if (!appIds.includes(claims.aud)) return null;
  return claims;
}

module.exports = { verifyPassedSignIn };
