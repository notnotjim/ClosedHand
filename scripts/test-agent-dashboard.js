const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'webapp/views/dashboard.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'webapp/server.js'), 'utf8');
function dashboard({ autos = [], agents = [], fail = '' } = {}) {
  const elements = new Map(), requests = [], timers = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {}, hidden: true });
    return elements.get(id);
  };
  const context = vm.createContext({ console, Date, window: {},
    document: { hidden: false, getElementById: get, addEventListener() {} },
    fetch: async url => { requests.push(url); return { ok: url !== fail, json: async () => url === '/api/agents' ? agents : autos }; },
    renderAgentCard: a => a.id + ':' + a.status,
    renderAutomationCard: a => a.id,
    setInterval: fn => { timers.push(fn); return timers.length; },
  });
  vm.runInContext(html.slice(html.indexOf('    async function loadAutomations()'), html.indexOf('    // Permission drift')), context);
  vm.runInContext(html.slice(html.indexOf('    async function loadRunningAgents()'), html.indexOf('    async function stopAgentRun(')), context);
  return { context, get, requests, timers };
}
const recent = (id, status) => ({ id, status, created_at: new Date().toISOString() });
test('chat tasks load and keep polling with no saved agents', async () => {
  const h = dashboard({ agents: [recent('chat-task', 'running')] });
  await h.context.loadAutomations();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.requests.includes('/api/agents'));
  assert.match(h.get('auto-active-list').innerHTML, /chat-task:running/);
  assert.equal(h.get('auto-empty').style.display, 'block');
  assert.equal(h.timers.length, 1);
  await h.context.loadAutomations();
  assert.equal(h.timers.length, 1, 'refresh does not add duplicate polling');
  h.timers[0]();
  assert.equal(h.requests.filter(u => u === '/api/agents').length, 3);
});
test('an incomplete chat task stays visible without saved agents', async () => {
  const h = dashboard({ agents: [recent('chat-task', 'partial')] });
  await h.context.loadAutomations();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.get('auto-active-list').innerHTML, /chat-task:partial/);
});
test('saved-agent failure does not hide chat work or look like an empty account', async () => {
  const h = dashboard({ fail: '/api/automations', agents: [recent('chat-task', 'running')] });
  await h.context.loadAutomations();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.get('auto-active-list').innerHTML, /chat-task:running/);
  assert.notEqual(h.get('auto-empty').style.display, 'block');
  assert.equal(h.get('auto-saved-error').hidden, false);
});
test('a failed task refresh preserves the previous cards and shows an error', async () => {
  const h = dashboard({ fail: '/api/agents' });
  h.get('auto-active-list').innerHTML = 'previous-card';
  await h.context.loadRunningAgents();
  assert.equal(h.get('auto-active-list').innerHTML, 'previous-card');
  assert.equal(h.get('auto-active-error').hidden, false);
});
test('a task waiting for confirmation stays visible after six hours', async () => {
  const h = dashboard({ agents: [{ id: 'waiting', status: 'awaiting_confirmation', created_at: '2020-01-01T00:00:00Z' }] });
  await h.context.loadRunningAgents();
  assert.match(h.get('auto-active-list').innerHTML, /waiting:awaiting_confirmation/);
});
function route(url, records, fail = '') {
  let handler;
  const db = { from(table) { let owner; const q = { select() { return q; }, eq(k, value) { assert.equal(k, 'user_id'); owner = value; return q; }, then(resolve) { return Promise.resolve(table === fail ? { error: new Error('offline') } : { data: (records[table] || []).filter(r => r.user_id === owner) }).then(resolve); } }; return q; } };
  const start = server.indexOf('app.get("' + url + '",');
  const end = server.indexOf('\napp.', start + 1);
  vm.runInNewContext(server.slice(start, end), { app: { get(name, fn) { handler = fn; } }, supabase: db, getUserIdFromRequest: () => 'owner', Date, console: { error() {} } });
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
  return handler({}, res).then(() => res);
}
for (const dates of ['postgres', 'supabase']) test('agent stats count ' + dates + ' timestamps and isolate owners', async () => {
  const stamp = ms => dates === 'postgres' ? new Date(ms) : new Date(ms).toISOString();
  const now = Date.now();
  const at = stamp(now);
  const records = {
    agent_tasks: [{ user_id: 'owner', status: 'running', created_at: at }, { user_id: 'owner', status: 'completed', created_at: at, completed_at: at }, { user_id: 'other', status: 'running', created_at: at }],
    automation_runs: [{ user_id: 'owner', status: 'running', started_at: at }],
    automations: [],
  };
  const automationStats = await route('/api/automations/stats', records);
  assert.equal(automationStats.body.running, 2);
  assert.equal(automationStats.body.runsToday, 3);
  assert.equal(new Date(automationStats.body.lastActivity).getTime(), now);
  const agentStats = await route('/api/agents/stats', records);
  assert.equal(agentStats.body.active, 1);
  assert.equal(agentStats.body.completedToday, 1);
});
test('stats report unavailable data instead of zero when a query fails', async () => {
  const res = await route('/api/automations/stats', {}, 'agent_tasks');
  assert.equal(res.code, 500);
});
