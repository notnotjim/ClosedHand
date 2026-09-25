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
let registrationState = null;
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
async function call(path, method = 'GET', body) {
  const response = await fetch(PROVIDER + '/api/phone-enrollment/' + path, {
    method, headers: { Authorization: 'Bearer ' + await credentials(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not set up a lasting phone address. Please try again.');
  return result;
}
async function begin(name) {
  name = name || await getConf('PHONE_ADDRESS_NAME');
  if (!name) throw new Error('Choose a name for your personal URL first.');
  if (!validAddress('https://' + name + '.closedhand.ai')) throw new Error('Choose a valid address name.');
  const data = await call('register', 'POST', { name, port: Number(process.env.PORT || 3000) });
  if (typeof data.ticket !== 'string') throw new Error('Could not start phone access.');
  await setConf({ PHONE_ADDRESS_NAME: name, PHONE_ENROLLMENT: '2' });
  return PROVIDER + '/phone-access/pair#' + encodeURIComponent(data.ticket);
}
function validAddress(value) {
  try {
    const u = new URL(value);
    const name = u.hostname.slice(0, -'.closedhand.ai'.length);
    // The same names closedhand.com refuses (closedhand-com/lib/addresses.js).
    const reserved = new Set(['www', 'app', 'api', 'admin', 'account', 'accounts', 'auth', 'login', 'mail', 'smtp', 'support', 'status', 'cloud', 'dashboard', 'closedhand',
      'autodiscover', 'autoconfig', 'mta-sts', 'webmail', 'imap', 'pop', 'mx', 'ns1', 'ns2', 'sso', 'id', 'help', 'security', 'docs', 'relay', 'assist',
      'billing', 'pay', 'secure', 'static', 'cdn', 'blog', 'open', 'keep', 'setup']);
    return u.protocol === 'https:' && /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(u.hostname) &&
      !reserved.has(name) && !/^..--/.test(name) && !u.port && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
  } catch (_) { return false; }
}
async function connection() {
  const savedUrl = await getConf('PHONE_PERMANENT_URL');
  const savedToken = decryptString(await getConf('PHONE_TUNNEL_TOKEN'));
  if (validAddress(savedUrl) && savedToken) {
    registrationState = 'active';
    return { url: savedUrl, token: savedToken };
  }
  const data = await call('connection');
  registrationState = ['unconfirmed', 'pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state) ? data.state : null;
  if (!['active','connecting'].includes(data.state)) return null;
  if (!validAddress(data.url) || typeof data.token !== 'string' || data.token.length < 30) throw new Error('The phone address could not be verified.');
  // A connecting credential may start the tunnel, but is not a verified link yet.
  if (data.state === 'active') await setConf({ PHONE_PERMANENT_URL: data.url, PHONE_TUNNEL_TOKEN: encrypted(data.token) });
  return { url: data.url, token: data.token, verify: data.state === 'connecting' };
}
async function confirm(permanent) {
  if (!permanent.verify) return;
  await call('connected','POST',{});
  await setConf({ PHONE_PERMANENT_URL: permanent.url, PHONE_TUNNEL_TOKEN: encrypted(permanent.token) });
}
async function challenge(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error('Invalid challenge');
  const secret = (await credentials()).split('.').pop();
  return crypto.createHmac('sha256',secret).update('closedhand-address:'+nonce).digest('hex');
}
function status() {
  return { registrationState, ownershipConfirmed: ['pending', 'provisioning', 'connecting', 'active', 'error'].includes(registrationState) };
}
module.exports = { begin, connection, validAddress, confirm, challenge, status };
