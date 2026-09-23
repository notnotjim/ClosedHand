// Network boundary for requests initiated by Workspace code.
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && [0, 2].includes(c)) ||
      (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const [a, b] = address.toLowerCase().split(':').map(part => parseInt(part || '0', 16));
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && [0, 2, 0x10, 0x20, 0xdb8].includes(b));
  }
  return false;
}
function parsePublicURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443', '8080', '8443'].includes(url.port))) throw new Error('That address is not available through the Workspace gateway.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || (net.isIP(host) && !publicAddress(host))) throw new Error('The Workspace gateway cannot reach private addresses.');
  return url;
}
function serviceURLAllowed(service, value) {
  let url; try { url = parsePublicURL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  if (['google', 'slack', 'whatsapp', 'meta', 'shopify'].includes(service) && (url.protocol !== 'https:' || url.port)) return false;
  switch (service) {
    case 'google': return host === 'googleapis.com' || host.endsWith('.googleapis.com');
    case 'slack': return ['slack.com', 'files.slack.com'].includes(host);
    case 'whatsapp': case 'meta': return host === 'graph.facebook.com';
    case 'shopify': return host.endsWith('.myshopify.com');
    default: return true;
  }
}
async function publicLookup(host, lookup = dns.lookup.bind(dns)) {
  const values = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!values.length || values.some(item => !publicAddress(item.address))) throw new Error('The Workspace gateway cannot reach private addresses.');
  return values;
}
async function publicRequest(method, value, body = null, suppliedHeaders = {}) {
  const url = parsePublicURL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await publicLookup(host);
  // Pin the validated DNS answers to the actual connection, preventing rebinding.
  const lookup = (_hostname, options, callback) => {
    const candidates = addresses.filter(item => !options.family || item.family === options.family);
    if (!candidates.length) return callback(new Error('No public address for this connection.'));
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
  const headers = { Accept: 'application/json' };
  for (const [name, value] of Object.entries(suppliedHeaders || {})) {
    if (!/^(host|connection|content-length|transfer-encoding|proxy-authorization|proxy-connection)$/i.test(name)) headers[name] = value;
  }
  const data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  if (data) { headers['Content-Type'] ||= 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request({
      hostname: host, port: url.port || undefined, path: url.pathname + url.search,
      method, headers, lookup, agent: false, timeout: 20000,
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume(); return reject(new Error('Redirects are not followed by the Workspace gateway.'));
      }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 5 * 1024 * 1024) request.destroy(new Error('Workspace response exceeded 5 MB.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (response.statusCode >= 400) return reject(new Error('HTTP ' + response.statusCode + ': ' + text.slice(0, 500)));
        try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Workspace request timed out.')));
    request.end(data);
  });
}
module.exports = { publicAddress, parsePublicURL, serviceURLAllowed, publicLookup, publicRequest };
