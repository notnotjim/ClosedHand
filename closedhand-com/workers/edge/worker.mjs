// Route exclusions send API polling, uploads and static downloads directly to
// the local application. Only document failures get an offline page.
// The binding contains registered hostnames, never provider credentials.
import offlineHtml from './offline.html';
import movedHtml from './moved.html';
import nothingHtml from './nothing.html';
const documents = new Set(['/', '/dashboard', '/keep', '/login', '/setup']);
const unreachable = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
const addressName = /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/;
const plain = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
// A page with no script: the moved and nothing-here pages.
function page(request, html, status) {
  return new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: { ...plain, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" },
  });
}
// A renamed personal URL: for thirty days the old name sends visitors on to
// the new one, keeping the page they asked for. The redirect is temporary so
// no browser keeps it: renaming back must work straight away. Then the old
// name says it has moved, until it is released six months after the rename;
// after that it is like any unknown name.
async function movedFrom(request, url, env) {
  if (!env.ADDRESS_HOSTS || !addressName.test(url.hostname)) return null;
  let moved = null;
  try { moved = JSON.parse(await env.ADDRESS_HOSTS.get('moved:' + url.hostname) || 'null'); } catch (_) { return null; }
  if (!moved || !addressName.test(moved.to || '') || moved.to === url.hostname) return null;
  const now = Date.now();
  if (now < Date.parse(moved.until)) {
    return new Response(null, { status: 307, headers: { ...plain, Location: 'https://' + moved.to + url.pathname + url.search } });
  }
  if (now < Date.parse(moved.release)) return page(request, movedHtml, 410);
  return null;
}
export async function handleRequest(request, env, upstream = fetch) {
  const url = new URL(request.url);
  const moved = await movedFrom(request, url, env);
  if (moved) return moved;
  let registered = url.hostname === env.DASHBOARD_HOST;
  if (!registered && env.ADDRESS_HOSTS && addressName.test(url.hostname)) {
    try { registered = !!(await env.ADDRESS_HOSTS.get(url.hostname)); } catch (_) {}
  }
  // Unknown and released names: nothing here. The catch-all DNS record
  // brings every name without its own record to this Worker.
  if (!registered || url.protocol !== 'https:') return page(request, nothingHtml, 404);
  const document = ['GET', 'HEAD'].includes(request.method) && documents.has(url.pathname) &&
    (request.headers.get('accept') || '').includes('text/html');
  let response;
  try {
    // Do not follow redirects with the visitor's cookies, log request data or
    // cache private responses. The browser follows the normal login redirect.
    response = await upstream(new Request(request, { redirect: 'manual' }));
    if (!document || !unreachable.has(response.status)) return response;
  } catch (_) {
    if (!document) return new Response('ClosedHand is temporarily unreachable.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(request.method === 'HEAD' ? null : offlineHtml, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '30',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'sha256-YCZ_REPLACE_AT_BUILD'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    },
  });
}
export default { fetch(request, env) { return handleRequest(request, env); } };
