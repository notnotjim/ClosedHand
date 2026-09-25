// Run after wrangler deploy. Receives `wrangler auth token --json` on stdin.
// Never prints or stores credentials. Exclusions bypass the daily Worker quota.
import { readFileSync } from 'node:fs';
const { token } = JSON.parse(readFileSync(0, 'utf8'));
if (!token) throw new Error('Missing operator authentication');
const zone = process.env.CF_ZONE_ID;
if (!/^[a-f0-9]{32}$/.test(zone || '')) throw new Error('Set CF_ZONE_ID to the closedhand.ai zone');
const base = 'https://api.cloudflare.com/client/v4/zones/' + zone + '/workers/routes';
async function api(path = '', method = 'GET', body) {
  const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok || !d.success) throw new Error('Could not configure offline routes');
  return d.result;
}
const current = await api();
const paths = JSON.parse(readFileSync(new URL('direct-routes.json', import.meta.url), 'utf8'));
const desired = paths.map(path => ({ pattern: '*.closedhand.ai' + path, script: null, request_limit_fail_open: true }));
desired.push({ pattern: '*.closedhand.ai/*', script: 'closedhand-phone-offline', request_limit_fail_open: true });
for (const route of desired) {
  const found = current.find(r => r.pattern === route.pattern);
  if (found?.script && found.script !== 'closedhand-phone-offline') throw new Error('Conflicting route owner');
  await api(found ? '/' + found.id : '', found ? 'PUT' : 'POST', route);
}
const verified = await api();
for (const wanted of desired) {
  const found = verified.find(r => r.pattern === wanted.pattern);
  if (!found || (found.script || null) !== wanted.script || found.request_limit_fail_open !== true) throw new Error('Route verification failed');
}
console.log('Verified offline fallback, direct application routes and fail-open behavior.');
