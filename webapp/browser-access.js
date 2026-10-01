// Public dashboard sessions belong to one HTTPS hostname. A sibling dashboard
// cannot set a __Host- cookie for this hostname, even with a parent Domain value.
function publicHttps(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return req.secure || req.headers['x-forwarded-proto'] === 'https' ||
    host.endsWith('.closedhand.ai') || host.endsWith('.trycloudflare.com');
}
function sessionName(req) { return publicHttps(req) ? '__Host-ch_admin' : 'ch_admin'; }
function sessionAttributes(req) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${publicHttps(req) ? '; Secure' : ''}`;
}
function allowBrowserWrite(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (origin) {
    const expected = `${publicHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
    return origin === expected;
  }
  // Provider webhooks and authenticated command-line clients carry no browser
  // fetch metadata. Normal browsers must not write from a sibling or other site.
  return !['same-site', 'cross-site'].includes(req.headers['sec-fetch-site']);
}
module.exports = { sessionName, sessionAttributes, allowBrowserWrite };
