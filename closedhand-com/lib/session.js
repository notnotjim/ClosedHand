// Signed cookies: who is signed in, and a sign-in that is under way.
// Both are signed with SESSION_SECRET and expire on their own, so nothing
// about a session is held in memory and any number of replicas can serve it.
const crypto = require('node:crypto');

const SESSION = 'ch_owner';
const SIGNIN = 'ch_signin';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const SIGNIN_MS = 10 * 60 * 1000;

// Compares hashes, so any two strings compare in the same time and odd
// input (unequal byte lengths, non-ASCII) can never throw.
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digest = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function seal(secret, purpose, data) {
  const text = Buffer.from(JSON.stringify(data)).toString('base64url');
  return text + '.' + crypto.createHmac('sha256', secret).update(purpose + ':' + text).digest('base64url');
}

function open(secret, purpose, value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const [text, signature, extra] = value.split('.');
  if (!text || !signature || extra !== undefined) return null;
  if (!equal(signature, crypto.createHmac('sha256', secret).update(purpose + ':' + text).digest('base64url'))) return null;
  try {
    const data = JSON.parse(Buffer.from(text, 'base64url').toString());
    return data && typeof data.exp === 'number' && data.exp > now ? data : null;
  } catch (_) { return null; }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return null; }
    }
  }
  return null;
}

function createSessions({ secret, secure }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const attributes = maxAge => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const set = (res, name, value, ms) => res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${attributes(Math.floor(ms / 1000))}`);
  const clear = (res, name) => res.append('Set-Cookie', `${name}=; ${attributes(0)}`);
  return {
    owner(req) {
      const data = open(secret, 'session', readCookie(req, SESSION));
      return data && /^[a-f0-9-]{36}$/.test(data.owner) ? data.owner : null;
    },
    signIn(res, ownerId) { set(res, SESSION, seal(secret, 'session', { owner: ownerId, exp: Date.now() + SESSION_MS }), SESSION_MS); },
    signOut(res) { clear(res, SESSION); },
    // The provider, the state and PKCE verifier sent to it, and where to
    // return afterwards. Lives only for the ten minutes a sign-in may take.
    startSignIn(res, pending) { set(res, SIGNIN, seal(secret, 'signin', { ...pending, exp: Date.now() + SIGNIN_MS }), SIGNIN_MS); },
    pendingSignIn(req) { return open(secret, 'signin', readCookie(req, SIGNIN)); },
    finishSignIn(res) { clear(res, SIGNIN); },
  };
}

module.exports = { createSessions, seal, open, equal, readCookie };
