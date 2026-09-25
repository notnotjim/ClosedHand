// Route exclusions send API polling, uploads and static downloads directly to
// the local application. Only document failures get an offline page.
// The binding contains registered hostnames, never provider credentials.
import offlineHtml from './offline.html';
const documents = new Set(['/', '/dashboard', '/keep', '/login', '/setup']);
const unreachable = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
export async function handleRequest(request, env, upstream = fetch) {
  const url = new URL(request.url);
  let registered = url.hostname === env.DASHBOARD_HOST;
  if (!registered && env.ADDRESS_HOSTS && /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(url.hostname)) {
    try { registered = !!(await env.ADDRESS_HOSTS.get(url.hostname)); } catch (_) {}
  }
  if (!registered || url.protocol !== 'https:') {
    return new Response('Unknown dashboard address.', { status: 421 });
  }
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
