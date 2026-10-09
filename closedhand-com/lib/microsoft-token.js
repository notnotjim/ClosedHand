// A Microsoft sign-in that Closedhand on someone's computer passes on, after
// connecting their mail through Closedhand's own Microsoft app. A sign-in on
// closedhand.com itself comes straight from Microsoft's token endpoint, so
// its claims can be read as they are (see signin.js); this one arrives from
// elsewhere, so it counts only when Microsoft's published keys show
// Microsoft signed it, for one of Closedhand's apps, and it has not expired.
const crypto = require('node:crypto');

const KEYS = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
const KEEP_KEYS = 6 * 60 * 60 * 1000;
let cached = { at: 0, keys: [] };

async function signingKeys(request, fresh) {
  if (!fresh && cached.keys.length && Date.now() - cached.at < KEEP_KEYS) return cached.keys;
  const response = await request(KEYS, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Microsoft keys ' + response.status);
  const keys = (await response.json()).keys;
  cached = { at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
  return cached.keys;
}

function part(text) {
  try { return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')); } catch (_) { return null; }
}

// The token's claims when it checks out, otherwise null. appIds are the
// Closedhand Microsoft apps a computer signs in through.
async function verifyMicrosoftToken(idToken, { appIds, request = fetch, now = Date.now() }) {
  const pieces = typeof idToken === 'string' ? idToken.split('.') : [];
  if (pieces.length !== 3 || idToken.length > 16384) return null;
  const header = part(pieces[0]), claims = part(pieces[1]);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  // Microsoft rolls its keys over now and then: an unknown key fetches them again once.
  let jwk = (await signingKeys(request, false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(request, true)).find(k => k.kid === header.kid);
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

// For the tests: start again with no keys held.
function forgetKeys() { cached = { at: 0, keys: [] }; }

module.exports = { verifyMicrosoftToken, forgetKeys, KEYS };
