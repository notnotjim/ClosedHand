// The two Cloudflare Workers behind personal URLs, with Cloudflare and
// closedhand.com as stand-ins: renamed names redirect, then stop; routes are
// built and removed only when they are ClosedHand's own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const workers = path.join(__dirname, '..', 'closedhand-com', 'workers');
// The edge Worker imports its pages; the build step inlines them.
async function edge() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-edge-')), 'worker.mjs');
  execFileSync(process.execPath, [path.join(workers, 'edge', 'build.mjs'), out], { stdio: 'ignore' });
  return import(out);
}
const kv = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return { map, get: async k => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); }, delete: async k => { map.delete(k); } };
};
const day = 86400000;

test('an old name redirects for thirty days, then says it has moved until it is released; unknown names show nothing here', async () => {
  const { handleRequest } = await edge();
  const release = new Date(Date.now() + 150 * day).toISOString();
  const env = { ADDRESS_HOSTS: kv({ 'moved:old-name.closedhand.ai': JSON.stringify({ to: 'new-name.closedhand.ai', until: new Date(Date.now() + day).toISOString(), release }) }) };
  const never = () => { throw new Error('the old name never reaches a computer'); };
  const hop = await handleRequest(new Request('https://old-name.closedhand.ai/dashboard?tab=settings#x'), env, never);
  assert.equal(hop.status, 307, 'temporary, so renaming back works straight away');
  assert.equal(hop.headers.get('location'), 'https://new-name.closedhand.ai/dashboard?tab=settings');
  assert.equal(hop.headers.get('cache-control'), 'no-store');
  env.ADDRESS_HOSTS.map.set('moved:old-name.closedhand.ai', JSON.stringify({ to: 'new-name.closedhand.ai', until: new Date(Date.now() - day).toISOString(), release }));
  const ended = await handleRequest(new Request('https://old-name.closedhand.ai/'), env, never);
  assert.equal(ended.status, 410);
  const movedText = await ended.text();
  assert.match(movedText, /This address has moved\./);
  assert.doesNotMatch(movedText, /new-name/, 'the moved page does not say where');
  assert.match(ended.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(await (await handleRequest(new Request('https://old-name.closedhand.ai/', { method: 'HEAD' }), env, never)).text(), '');
  // Released (the entry is gone, or its release time has passed): nothing here.
  env.ADDRESS_HOSTS.map.set('moved:old-name.closedhand.ai', JSON.stringify({ to: 'new-name.closedhand.ai', until: new Date(Date.now() - 200 * day).toISOString(), release: new Date(Date.now() - day).toISOString() }));
  for (const host of ['old-name', 'never-used']) {
    const none = await handleRequest(new Request(`https://${host}.closedhand.ai/`), env, never);
    assert.equal(none.status, 404, host);
    const text = await none.text();
    assert.match(text, /Nothing here\./);
    assert.doesNotMatch(text, /moved|new-name/, 'nothing links it to its old owner');
  }
  // A bad or self-pointing entry is ignored, and the name is treated as unknown.
  env.ADDRESS_HOSTS.map.set('moved:loop-name.closedhand.ai', JSON.stringify({ to: 'loop-name.closedhand.ai', until: new Date(Date.now() + day).toISOString(), release }));
  env.ADDRESS_HOSTS.map.set('moved:evil-name.closedhand.ai', JSON.stringify({ to: 'evil.example', until: new Date(Date.now() + day).toISOString(), release }));
  for (const host of ['loop-name', 'evil-name']) assert.equal((await handleRequest(new Request(`https://${host}.closedhand.ai/`), env, never)).status, 404, host);
  // A registered address still passes straight through.
  env.ADDRESS_HOSTS.map.set('live-name.closedhand.ai', 'id');
  const live = await handleRequest(new Request('https://live-name.closedhand.ai/'), env, async () => new Response('dashboard'));
  assert.equal(await live.text(), 'dashboard');
});

// closedhand.com's job endpoints and Cloudflare's API, as the Worker sees them.
function stand({ moves = [], dns = [], job = null, tunnels = [] } = {}) {
  const calls = [], deleted = [], done = [], tunnelsDeleted = [];
  const reply = (data, ok = true) => new Response(JSON.stringify(data), { status: ok ? 200 : 500 });
  const request = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push([opts.method || 'GET', url]);
    if (url.endsWith('/jobs/moves')) return reply({ moves });
    if (url.endsWith('/jobs/moves/done')) { done.push(body); return reply({ ok: true }); }
    if (url.endsWith('/jobs/lease')) return reply({ job });
    if (url.endsWith('/jobs/checkpoint')) { done.push({ checkpoint: body }); return reply({ ok: true }); }
    const u = new URL(url);
    if (u.pathname.includes('/dns_records')) {
      if (opts.method === 'DELETE') { deleted.push(u.pathname.split('/').pop()); return reply({ success: true, result: {} }); }
      if (opts.method === 'POST') return reply({ success: true, result: { id: 'e'.repeat(32), ...body } });
      const name = u.searchParams.get('name');
      return reply({ success: true, result: name ? dns.filter(r => r.name === name) : [], result_info: { total_count: dns.length } });
    }
    if (u.pathname.endsWith('/token')) return reply({ success: true, result: 'token' });
    if (u.pathname.includes('/cfd_tunnel')) {
      const rest = u.pathname.split('/cfd_tunnel')[1];
      if (opts.method === 'DELETE' && /^\/[a-f0-9-]{36}$/.test(rest)) { tunnelsDeleted.push(rest.slice(1)); return reply({ success: true, result: {} }); }
      if (rest) return reply({ success: true, result: {} });
      if (opts.method === 'POST') return reply({ success: true, result: { id: '11111111-2222-4333-8444-555555555555', name: body.name } });
      const name = u.searchParams.get('name');
      return reply({ success: true, result: tunnels.filter(t => !name || t.name === name), result_info: { total_count: tunnels.length } });
    }
    throw new Error('unexpected ' + url);
  };
  return { request, calls, deleted, done, tunnelsDeleted };
}
const envWith = entries => ({ CF_PHONE_API_TOKEN: 't', PHONE_PROVISIONER_SECRET: 's', CF_ACCOUNT_ID: 'a', CF_ZONE_ID: 'z', ADDRESS_HOSTS: kv(entries) });
const tunnelCname = (name, id) => ({ id, name, type: 'CNAME', content: '11111111-2222-4333-8444-555555555555.cfargotunnel.com', proxied: true, comment: 'ClosedHand address x' });

test('the route Worker sets up redirects and, after thirty days, removes only the old route', async () => {
  const { moveNames } = await import(path.join(workers, 'provisioner', 'worker.mjs'));
  const until = new Date(Date.now() + 30 * day).toISOString(), release = new Date(Date.now() + 182 * day).toISOString();
  const s = stand({
    moves: [
      { hostname: 'old-one.closedhand.ai', to: 'new-one.closedhand.ai', until, release },
      { hostname: 'gone-one.closedhand.ai', dnsId: 'a'.repeat(32), remove: true },
      { hostname: 'taken-back.closedhand.ai', dnsId: 'b'.repeat(32), remove: true },
      { hostname: 'bad', to: 'new-one.closedhand.ai', until, release },
    ],
    dns: [tunnelCname('gone-one.closedhand.ai', 'a'.repeat(32)), { ...tunnelCname('gone-one.closedhand.ai', 'c'.repeat(32)), type: 'TXT' }, tunnelCname('taken-back.closedhand.ai', 'b'.repeat(32))],
  });
  const env = envWith({ 'old-one.closedhand.ai': 'id', 'taken-back.closedhand.ai': 'id2' });
  assert.deepEqual(await moveNames(env, s.request), { moved: 3 });
  assert.deepEqual(JSON.parse(env.ADDRESS_HOSTS.map.get('moved:old-one.closedhand.ai')), { to: 'new-one.closedhand.ai', until, release });
  assert.equal(env.ADDRESS_HOSTS.map.get('old-one.closedhand.ai'), undefined, 'the old name no longer counts as a live address');
  assert.deepEqual(s.deleted, ['a'.repeat(32)], 'only the old route, and never a name taken back');
  assert.deepEqual(s.done, [
    { hostname: 'old-one.closedhand.ai', to: 'new-one.closedhand.ai' },
    { hostname: 'gone-one.closedhand.ai', removed: true },
    { hostname: 'taken-back.closedhand.ai', removed: true },
  ]);
});

test('building a route for a name taken back stops it redirecting', async () => {
  const { provision } = await import(path.join(workers, 'provisioner', 'worker.mjs'));
  const job = { id: '99999999-2222-4333-8444-555555555555', attempt: '88888888-2222-4333-8444-555555555555', hostname: 'back-again.closedhand.ai', port: 3000, tunnelId: null, dnsId: null, revoked: false };
  const s = stand({ job });
  const env = envWith({ 'moved:back-again.closedhand.ai': JSON.stringify({ to: 'x-y.closedhand.ai', until: new Date(Date.now() + day).toISOString() }) });
  assert.deepEqual(await provision(env, s.request), { ready: true });
  assert.equal(env.ADDRESS_HOSTS.map.get('moved:back-again.closedhand.ai'), undefined);
  assert.equal(env.ADDRESS_HOSTS.map.get('back-again.closedhand.ai'), job.id);
});

test('six months on, the route Worker forgets a released name entirely', async () => {
  const { moveNames } = await import(path.join(workers, 'provisioner', 'worker.mjs'));
  const s = stand({
    moves: [{ hostname: 'let-go.closedhand.ai', dnsId: null, release: true }, { hostname: 'still-routed.closedhand.ai', dnsId: 'f'.repeat(32), release: true }],
    dns: [tunnelCname('still-routed.closedhand.ai', 'f'.repeat(32))],
  });
  const env = envWith({ 'moved:let-go.closedhand.ai': '{}', 'moved:still-routed.closedhand.ai': '{}' });
  assert.deepEqual(await moveNames(env, s.request), { moved: 2 });
  assert.equal(env.ADDRESS_HOSTS.map.size, 0, 'no moved entry left');
  assert.deepEqual(s.deleted, ['f'.repeat(32)], 'a route still there goes too');
  assert.deepEqual(s.done, [{ hostname: 'let-go.closedhand.ai', released: true }, { hostname: 'still-routed.closedhand.ai', released: true }]);
});

test('the route Worker counts only personal URL records and reports them', async () => {
  const { countRecords } = await import(path.join(workers, 'provisioner', 'worker.mjs'));
  const records = [
    ...Array.from({ length: 3 }, (_, i) => tunnelCname(`a${i}-b.closedhand.ai`, String(i).repeat(32))),
    { ...tunnelCname('not-ours.closedhand.ai', 'x'.repeat(32)), comment: 'something else' },
    { id: 'y'.repeat(32), name: 'www.closedhand.ai', type: 'CNAME', content: 'closedhand.com', comment: '' },
  ];
  const reported = [];
  const request = async (url, opts = {}) => {
    if (url.endsWith('/jobs/usage')) { reported.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ over: false })); }
    const u = new URL(url);
    assert.equal(u.searchParams.get('type'), 'CNAME');
    return new Response(JSON.stringify({ success: true, result: records, result_info: { total_pages: 1 } }));
  };
  assert.deepEqual(await countRecords(envWith({}), request), { records: 3 });
  assert.deepEqual(reported, [{ dnsRecords: 3 }]);
});

test('an address let go is taken down completely; one moving to another computer keeps its tunnel and route', async () => {
  const { provision } = await import(path.join(workers, 'provisioner', 'worker.mjs'));
  const id = '77777777-2222-4333-8444-555555555555', tunnelId = '11111111-2222-4333-8444-555555555555';
  const job = teardown => ({ id, attempt: '66666666-2222-4333-8444-555555555555', hostname: 'gone-away.closedhand.ai', port: 3000, tunnelId, dnsId: 'd'.repeat(32), revoked: true, teardown });
  const dns = [{ ...tunnelCname('gone-away.closedhand.ai', 'd'.repeat(32)), comment: 'ClosedHand address ' + id }, { id: 'e'.repeat(32), name: 'gone-away.closedhand.ai', type: 'TXT', content: 'someone else', comment: '' }];
  const tunnels = [{ id: tunnelId, name: 'closedhand-v2-' + id, config_src: 'cloudflare' }];
  const gone = stand({ job: job(true), dns, tunnels });
  const env = envWith({ 'gone-away.closedhand.ai': id });
  assert.deepEqual(await provision(env, gone.request), { revoked: true });
  assert.deepEqual(gone.deleted, ['d'.repeat(32)], 'only its own tunnel record');
  assert.deepEqual(gone.tunnelsDeleted, [tunnelId]);
  assert.equal(env.ADDRESS_HOSTS.map.size, 0);
  assert.deepEqual(gone.done.at(-1), { checkpoint: { id, attempt: job(true).attempt, revoked: true } });
  // Moving: the old computer is cut off, the tunnel and record stay.
  const moving = stand({ job: job(false), dns, tunnels });
  assert.deepEqual(await provision(envWith({ 'gone-away.closedhand.ai': id }), moving.request), { revoked: true });
  assert.deepEqual(moving.deleted, []); assert.deepEqual(moving.tunnelsDeleted, []);
  assert.ok(moving.calls.some(([m, u]) => m === 'PATCH' && u.includes(tunnelId)), 'its secret is changed');
  // Tried again after the tunnel went: the record is still found by its comment.
  const retry = stand({ job: { ...job(true), dnsId: null }, dns, tunnels: [] });
  assert.deepEqual(await provision(envWith({}), retry.request), { revoked: true });
  assert.deepEqual(retry.deleted, ['d'.repeat(32)]); assert.deepEqual(retry.tunnelsDeleted, []);
});

test('the route Worker reports when each computer was last connected, from its tunnel', async () => {
  const { reportSeen } = await import(path.join(workers, 'provisioner', 'worker.mjs'));
  const a = '12345678-2222-4333-8444-555555555555', b = '22345678-2222-4333-8444-555555555555';
  const list = [
    { id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'closedhand-v2-' + a, status: 'healthy', conns_inactive_at: null },
    { id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'closedhand-v2-' + b, status: 'down', conns_inactive_at: '2026-06-01T00:00:00Z' },
    { id: 'cccccccc-2222-4333-8444-555555555555', name: 'something-else', status: 'healthy' },
    { id: 'dddddddd-2222-4333-8444-555555555555', name: 'closedhand-v2-' + a.replace('1', '3'), status: 'inactive', conns_inactive_at: null },
  ];
  const sent = [];
  const request = async (url, opts = {}) => {
    if (url.endsWith('/jobs/seen')) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ matched: 2, working: 2 })); }
    assert.match(url, /include_prefix=closedhand-v2-/);
    return new Response(JSON.stringify({ success: true, result: list }));
  };
  const before = Date.now();
  assert.deepEqual(await reportSeen(envWith({}), request), { reported: 2, matched: 2 });
  const [{ tunnels }] = sent;
  assert.equal(tunnels.length, 2, 'never connected, or not ours: left out');
  assert.equal(tunnels[0].address, a); assert.ok(Date.parse(tunnels[0].seen) >= before, 'connected now');
  assert.deepEqual(tunnels[1], { address: b, tunnel: list[1].id, seen: '2026-06-01T00:00:00Z' });
});
