// The transport contract is independent of providers, models and tool access.
const crypto = require('node:crypto');
const DOMAIN = 'assist.closedhand.ai';
const LIMITS = { text: 40000, attachmentBytes: 5 * 1024 * 1024, messageBytes: 8 * 1024 * 1024, recipients: 8 };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function address(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s<>\x00-\x1f\x7f]/.test(value)) return null;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(value) ? value.toLowerCase() : null;
}
function addresses(values) {
  if (!Array.isArray(values) || values.length > LIMITS.recipients) throw new Error('Too many email recipients.');
  const clean = values.map(address);
  if (clean.some(x => !x)) throw new Error('Invalid email address.');
  return [...new Set(clean)];
}
function header(value, max = 200) { return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max); }
function messageId(value) { return typeof value === 'string' && /^<[^\s<>]{1,240}@[^\s<>]{1,240}>$/.test(value) ? value : null; }
function references(value) { return (Array.isArray(value) ? value : String(value || '').split(/\s+/)).filter(messageId).slice(-30); }
function isAutomated(headers) {
  const get = key => String(headers.get?.(key) || headers[key] || '').trim().toLowerCase();
  return (get('auto-submitted') && get('auto-submitted') !== 'no') ||
    /^(bulk|list|junk)$/.test(get('precedence')) || !!get('list-id');
}
// Only SES receipt verdicts are trusted. Authentication-Results inside MIME is
// attacker-controlled and must never determine owner/participant authority.
function authenticated(receipt) {
  // A DKIM pass alone may belong to a different domain than the From address.
  const aligned = receipt?.dmarcVerdict?.status === 'PASS';
  return aligned && receipt?.spamVerdict?.status === 'PASS' && receipt?.virusVerdict?.status === 'PASS';
}
function identity(req) {
  const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  return match && uuid(match[1]) ? { id: match[1], hash: digest(match[2]) } : null;
}
function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function signTicket(data, secret, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...data, expires: now + 1800000 })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret).update('assistant-email:' + body).digest('hex');
}
function readTicket(ticket, secret, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 4096) return null;
  const [body, signature, extra] = ticket.split('.');
  if (extra || !equal(signature, crypto.createHmac('sha256', secret).update('assistant-email:' + body).digest('hex'))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return uuid(data.id) && /^[a-f0-9]{64}$/.test(data.hash) && data.expires > now && validPublicKey(data.publicKey) ? data : null;
  } catch (_) { return null; }
}
function validPublicKey(pem) {
  try {
    if (typeof pem !== 'string' || pem.length > 1000 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) return false;
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength === 2048;
  } catch (_) { return false; }
}
function keyPair() { return crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }); }
function seal(payload, publicKey, mailboxId) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(mailboxId));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return { v: 1, key: crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(payload, privateKey, mailboxId) {
  if (payload?.v !== 1 || typeof payload.data !== 'string' || payload.data.length > LIMITS.messageBytes * 2) throw new Error('Invalid email envelope.');
  const key = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(payload.key, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from(mailboxId)); decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString());
}
function attachments(list = []) {
  if (!Array.isArray(list) || list.length > 10) throw new Error('Too many email attachments.');
  let size = 0;
  return list.map(file => {
    if (typeof file.content !== 'string' || !/^[a-z0-9+/]*={0,2}$/i.test(file.content)) throw new Error('Invalid attachment.');
    size += Buffer.byteLength(file.content, 'base64');
    if (size > LIMITS.attachmentBytes) throw new Error('Email attachments must total 5 MB or less.');
    return { filename: header(file.filename || 'attachment', 150).replace(/[\\/]/g, '_'), contentType: header(file.contentType || 'application/octet-stream', 100), content: file.content };
  });
}
function outgoing(input) {
  if (!uuid(input?.id) || !uuid(input?.replyToDelivery) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > LIMITS.text) throw new Error('Invalid outgoing email.');
  const to = addresses(input.to);
  if (!to.length) throw new Error('Choose an email recipient.');
  return { id: input.id, replyToDelivery: input.replyToDelivery, to, subject: header(input.subject), text: input.text, attachments: attachments(input.attachments), inReplyTo: messageId(input.inReplyTo), references: references(input.references), displayName: header(input.displayName || 'ClosedHand', 100) };
}
// Only provider-authenticated mailbox identities count, never arbitrary contact
// addresses, MCP metadata or aliases supplied in an incoming message.
function ownerAddresses(account, connections = []) {
  const result = new Set([address(account.owner_email)].filter(Boolean));
  for (const connection of connections) {
    if (!/^(google|microsoft)(?:_extra_.+)?$/.test(connection.service || '')) continue;
    if (connection.metadata?.reconnect_required || !(connection.tokens?.access_token || connection.tokens?.refresh_token)) continue;
    const email = address(connection.metadata?.email);
    if (email) result.add(email);
  }
  return [...result];
}
module.exports = { ownerAddresses, DOMAIN, LIMITS, uuid, digest, address, addresses, header, messageId, references, isAutomated, authenticated, identity, equal, signTicket, readTicket, validPublicKey, keyPair, seal, open, attachments, outgoing };
