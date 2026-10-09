// Personal URL registration with closedhand.com. Only routing credentials leave the install.
const crypto = require('node:crypto');
const { getConf, setConf } = require('./config');
const { encryptString, decryptString } = require('./crypto-tokens');
const PROVIDER = 'https://closedhand.com';
function encrypted(value) {
  const result = encryptString(value);
  if (!result?.startsWith('enc:v1:')) throw new Error('Your personal URL needs encrypted storage. Check Closedhand’s settings.');
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
    if (!/^[a-f0-9-]{36}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Could not open the personal URL settings.');
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
  if (!response.ok) throw new Error(result.error || 'Could not set up your personal URL. Please try again.');
  return result;
}
// Ask for a personal URL. closedhand.com picks the name (two ordinary words
// and a number); the owner can rename it later. closedhand.com gives its
// owner a code after they confirm, and handing it in here (claim) is what
// finishes, so only this copy can. The link carries a one-time state: when
// closedhand.com hands the code straight back to setup on this computer, the
// state comes with it, so a code arriving any other way is never sent on.
async function begin() {
  const data = await call('register', 'POST', { port: Number(process.env.PORT || 3000), confirm: 'code' });
  if (typeof data.ticket !== 'string') throw new Error('Could not start claiming your personal URL.');
  const state = crypto.randomBytes(16).toString('hex');
  // A ticket lasts thirty minutes; a few recent links stay good together.
  const recent = (await claimStates()).filter(s => Date.now() - s.at < 30 * 60000).slice(-4);
  await setConf({ PHONE_ENROLLMENT: '2', PHONE_CLAIM_STATES: JSON.stringify([...recent, { state, at: Date.now() }]) });
  return PROVIDER + '/phone-access/pair#' + new URLSearchParams({ t: data.ticket, state });
}
async function claimStates() {
  try { const list = JSON.parse(await getConf('PHONE_CLAIM_STATES') || '[]'); return Array.isArray(list) ? list.filter(s => s && typeof s.state === 'string' && typeof s.at === 'number') : []; }
  catch (_) { return []; }
}
// A typed name tidied the way closedhand.com tidies it (closedhand-com/lib/
// names.js): lower case, no accents, spaces and dots as hyphens, nothing else.
function cleanName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[\s._]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');
}
// Rename the personal URL. The old name sends visitors on to the new one for
// thirty days. This copy then reconnects at the new name and proves it
// answers there, as it did the first time.
async function rename(name) {
  const clean = cleanName(name);
  if (!validAddress('https://' + clean + '.closedhand.ai')) {
    throw new Error('Use 3 to 32 letters, numbers or hyphens, starting with a letter. A few names, like admin and mail, are kept back.');
  }
  const data = await call('rename', 'POST', { name: clean });
  if (!validAddress(data.url)) throw new Error('The new personal URL could not be verified.');
  await setConf({ PHONE_PERMANENT_URL: null, PHONE_TUNNEL_TOKEN: null, PHONE_ADDRESS_NAME: new URL(data.url).hostname.split('.')[0] });
  registrationState = ['pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state) ? data.state : 'pending';
  return data;
}
// Can closedhand.com give out personal URLs right now? Reached, and not
// switched off. Checked at most every thirty seconds.
let serviceCheck = { at: 0, available: null };
async function serviceAvailable() {
  if (Date.now() - serviceCheck.at < 30000 && serviceCheck.available !== null) return serviceCheck.available;
  let available = false;
  try {
    const response = await fetch(PROVIDER + '/api/account', { redirect: 'error', signal: AbortSignal.timeout(6000) });
    available = response.ok && (await response.json()).available === true;
  } catch (_) { available = false; }
  serviceCheck = { at: Date.now(), available };
  return available;
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
// The personal URL's connection. A saved one is used as it is, unless it
// has stopped working (recheck): then closedhand.com is asked again, and an
// address it no longer knows for this computer (its account was deleted,
// it went unused, or it moved to another computer) is forgotten here too.
// If closedhand.com can't be reached, the saved one is kept.
async function connection({ recheck = false } = {}) {
  const savedUrl = await getConf('PHONE_PERMANENT_URL');
  const savedToken = decryptString(await getConf('PHONE_TUNNEL_TOKEN'));
  const saved = validAddress(savedUrl) && savedToken ? { url: savedUrl, token: savedToken } : null;
  if (saved && !recheck) {
    registrationState = 'active';
    return saved;
  }
  let data;
  try { data = await call('connection'); }
  catch (error) {
    if (!saved) throw error;
    registrationState = 'active';
    return saved;
  }
  registrationState = ['unconfirmed', 'pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state) ? data.state : null;
  if (data.state === 'unconfirmed' && saved) await forget();
  if (!['active','connecting'].includes(data.state)) return null;
  if (!validAddress(data.url) || typeof data.token !== 'string' || data.token.length < 30) throw new Error('Your personal URL could not be verified.');
  // A connecting credential may start the tunnel, but is not a verified link yet.
  if (data.state === 'active') await setConf({ PHONE_PERMANENT_URL: data.url, PHONE_TUNNEL_TOKEN: encrypted(data.token) });
  return { url: data.url, token: data.token, verify: data.state === 'connecting' };
}
async function confirm(permanent) {
  if (!permanent.verify) return;
  await call('connected','POST',{});
  await setConf({ PHONE_PERMANENT_URL: permanent.url, PHONE_TUNNEL_TOKEN: encrypted(permanent.token) });
}
// state: set when closedhand.com handed the code back by itself (not typed).
async function claim(code, state) {
  code = String(code || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('The code is 6 letters and numbers, as shown on closedhand.com.');
  if (state !== undefined) {
    const states = await claimStates();
    const match = typeof state === 'string' && /^[a-f0-9]{32}$/.test(state) &&
      states.find(s => Date.now() - s.at < 30 * 60000 && s.state.length === 32 && crypto.timingSafeEqual(Buffer.from(s.state), Buffer.from(state)));
    if (!match) throw new Error('That link didn’t come from this Closedhand. Get your personal URL here instead.');
    await setConf({ PHONE_CLAIM_STATES: JSON.stringify(states.filter(s => s !== match)) });
  }
  const data = await call('claim', 'POST', { code });
  if (['pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state)) registrationState = data.state;
  // The name closedhand.com picked, so setup can say where Closedhand is.
  if (validAddress(data.url)) await setConf({ PHONE_ADDRESS_NAME: new URL(data.url).hostname.split('.')[0] });
  return data;
}
// Claim in one step with the Microsoft sign-in this computer has just done
// through Closedhand's own Microsoft app, checked by closedhand.com against
// Microsoft's keys. Null when closedhand.com wants it claimed on its
// confirmation page instead (an address already used on another computer).
async function claimWithMicrosoft(idToken) {
  const data = await call('claim-microsoft', 'POST', { idToken, port: Number(process.env.PORT || 3000) });
  if (data.claimHere || !validAddress(data.url)) return null;
  if (['pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state)) registrationState = data.state;
  await setConf({ PHONE_ENROLLMENT: '2', PHONE_ADDRESS_NAME: new URL(data.url).hostname.split('.')[0] });
  return data;
}
async function challenge(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error('Invalid challenge');
  const secret = (await credentials()).split('.').pop();
  return crypto.createHmac('sha256',secret).update('closedhand-address:'+nonce).digest('hex');
}
// This computer's Closedhand account: the Google or Microsoft sign-in that
// owns its personal URL, which is all the account holds. Null without one.
async function account() {
  if (!(await getConf('PHONE_INSTALL_ID'))) return null;
  const found = (await call('account')).account;
  if (!found || !validAddress(found.url)) return null;
  return { provider: found.provider === 'microsoft' ? 'microsoft' : 'google', email: typeof found.email === 'string' ? found.email : null, url: new URL(found.url).origin };
}
// Delete this computer's Closedhand account on closedhand.com, then forget
// the personal URL here. Throws when closedhand.com can't do it, so the
// person can be told before anything else is deleted.
async function deleteAccount() {
  if (!(await getConf('PHONE_INSTALL_ID'))) return { deleted: false };
  const data = await call('account/delete', 'POST', {});
  await forget();
  return { deleted: data.deleted === true };
}
async function forget() {
  registrationState = null;
  await setConf({ PHONE_PERMANENT_URL: null, PHONE_TUNNEL_TOKEN: null, PHONE_ADDRESS_NAME: null, PHONE_ENROLLMENT: null });
}
function status() {
  return { registrationState, ownershipConfirmed: ['pending', 'provisioning', 'connecting', 'active', 'error'].includes(registrationState) };
}
module.exports = { begin, claim, claimWithMicrosoft, rename, cleanName, connection, validAddress, confirm, challenge, status, serviceAvailable, account, deleteAccount };
