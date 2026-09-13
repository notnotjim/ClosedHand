// Optional hosted address registration. Only routing credentials leave the install.
const crypto = require('node:crypto');
const { getConf, setConf } = require('./config');
const { encryptString, decryptString } = require('./crypto-tokens');
const PROVIDER = 'https://closedhand.com';
function encrypted(value) {
  const result = encryptString(value);
  if (!result?.startsWith('enc:v1:')) throw new Error('Phone access needs encrypted storage. Check your installation settings.');
  return result;
}
let identityPromise;
async function credentials() {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    let id = await getConf('PHONE_INSTALL_ID');
    let secret = decryptString(await getConf('PHONE_INSTALL_SECRET'));
    if (!id && !secret) {
      id = crypto.randomUUID(); secret = crypto.randomBytes(32).toString('hex');
      await setConf({ PHONE_INSTALL_ID: id, PHONE_INSTALL_SECRET: encrypted(secret) });
    }
    if (!/^[a-f0-9-]{36}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Could not open this computer’s phone access settings.');
    return id + '.' + secret;
  })().catch(error => { identityPromise = null; throw error; });
  return identityPromise;
}
async function call(path, method = 'GET') {
  const response = await fetch(PROVIDER + '/api/phone-links/' + path, {
    method, headers: { Authorization: 'Bearer ' + await credentials() },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not set up a lasting phone address. Please try again.');
  return body;
}
async function begin() {
  const data = await call('register', 'POST');
  if (typeof data.ticket !== 'string') throw new Error('Could not start phone access.');
  return PROVIDER + '/phone-access/pair#' + encodeURIComponent(data.ticket);
}
function validAddress(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && /^ch-[a-f0-9]{32}\.closedhand\.com$/.test(u.hostname) && !u.port && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; } catch (_) { return false; }
}
async function connection() {
  const savedUrl = await getConf('PHONE_PERMANENT_URL');
  const savedToken = decryptString(await getConf('PHONE_TUNNEL_TOKEN'));
  if (validAddress(savedUrl) && savedToken) return { url: savedUrl, token: savedToken };
  const data = await call('connection');
  if (data.state !== 'active') return null;
  if (!validAddress(data.url) || typeof data.token !== 'string' || data.token.length < 30) throw new Error('The phone address could not be verified.');
  await setConf({ PHONE_PERMANENT_URL: data.url, PHONE_TUNNEL_TOKEN: encrypted(data.token) });
  return { url: data.url, token: data.token };
}
module.exports = { begin, connection, validAddress };
