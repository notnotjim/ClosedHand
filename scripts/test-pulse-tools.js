// Pulse's writer starts with a few tools and unlocks the rest on demand, as
// the chat does, instead of resending every tool on every step.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { INTERNAL_TOOLS } = require('../lib/tools/definitions');
const { PULSE_INITIAL, pulseToolScope, pulseMayUse } = require('../lib/pulse-tools');
const connectedApp = [
  { name: 'shopify_list_orders', description: 'List recent orders in the connected Shopify store.', input_schema: { type: 'object', properties: { status: { type: 'string' } } } },
  { name: 'linear_search_issues', description: 'Search issues in Linear.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'shopify_create_refund', description: 'Refund an order in the connected Shopify store.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } } } },
];
// What the connected app says about its own tools (MCP's readOnlyHint).
const appReadOnly = (name) => name === 'shopify_list_orders' || name === 'linear_search_issues';
const all = [...INTERNAL_TOOLS.map(t => ({ name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object', properties: {} } })), ...connectedApp];
const names = defs => defs.map(t => t.name);

test('every starting tool exists, so a rename cannot silently drop one', () => {
  const known = new Set(INTERNAL_TOOLS.map(t => t.name));
  for (const name of PULSE_INITIAL) assert.ok(known.has(name), name);
});
test('the writer starts with its own tools in full and sees every other one, connected apps included, by name', () => {
  const scope = pulseToolScope(all, appReadOnly);
  const first = names(scope.definitions([]));
  for (const name of PULSE_INITIAL) assert.ok(first.includes(name), name);
  assert.ok(!first.includes('shopify_list_orders'), 'a connected app waits to be unlocked');
  assert.deepEqual([...first].sort(), [...PULSE_INITIAL].sort(), 'exactly the starting set, the same every check');
  for (const t of all.filter(t => pulseMayUse(t.name, appReadOnly))) assert.ok(scope.catalog.includes(t.name), 'listed: ' + t.name);
  assert.match(scope.catalog, /get_tool_details/);
});
test('asking for a tool unlocks it on the next step, connected apps included; unknown names are refused', () => {
  const scope = pulseToolScope(all, appReadOnly);
  const described = scope.describe('shopify_list_orders');
  assert.equal(described.name, 'shopify_list_orders'); assert.ok(described.input_schema);
  assert.match(scope.describe('no_such_tool').error, /not available/);
  const messages = [{ role: 'assistant', content: [{ type: 'tool_use', name: 'get_tool_details', input: { tool_name: 'shopify_list_orders' } }] }];
  assert.ok(names(scope.definitions(messages)).includes('shopify_list_orders'));
  assert.equal(scope.has('shopify_list_orders'), true); assert.equal(scope.has('no_such_tool'), false);
});
test('each writer step carries a fraction of what it used to', () => {
  const scope = pulseToolScope(all, appReadOnly);
  const now = JSON.stringify(scope.definitions([])).length + scope.catalog.length;
  const before = JSON.stringify(all).length;
  assert.ok(now < before * 0.25, `${now} vs ${before} characters`);
});
test('the writer uses the scope for its tools, its catalogue and get_tool_details', () => {
  const src = fs.readFileSync(require.resolve('../lib/pulse.js'), 'utf8');
  assert.match(src, /tools: \[\.\.\.toolScope\.definitions\(messages\), SEND_TOOL\]/);
  assert.match(src, /toolScope\.catalog/);
  assert.match(src, /toolScope\.describe\(block\.input\?\.tool_name\)/);
  assert.doesNotMatch(src, /tools: \[\.\.\.tools, SEND_TOOL\]/);
});
test('the time comes last, so each check starts with the same prompt and providers can reuse it', () => {
  const src = fs.readFileSync(require.resolve('../lib/pulse.js'), 'utf8');
  const prompt = src.slice(src.indexOf('const fullPrompt'), src.indexOf(';', src.indexOf('const fullPrompt')));
  assert.ok(prompt.indexOf('toolScope.catalog') < prompt.indexOf('nowStamp'), prompt);
  const system = src.slice(src.indexOf('const systemPrompt = `'), src.indexOf('`;', src.indexOf('const systemPrompt = `')));
  assert.doesNotMatch(system, /nowStamp/);
});

// An email anyone can send is part of what Pulse reads, so one could be
// written to steer it. Pulse looks things up and messages the person; every
// change goes back to them, to ask for in chat.
test('Pulse can only look things up: nothing that sends, changes, deletes or fetches an address', () => {
  const scope = pulseToolScope(all, appReadOnly);
  const changes = ['gmail_send', 'gmail_reply', 'send_mail', 'gmail_create_draft', 'gmail_draft_update', 'gcal_create_event', 'gcal_update_event',
    'gcal_delete_event', 'calendar_delete_event', 'outlook_send', 'drive_send_file', 'update_settings', 'delete_fact', 'api_request',
    'sandbox_exec', 'sandbox_browse', 'bridge_shell_run', 'bridge_files_write', 'automation_create', 'booking_update', 'web_fetch', 'shopify_create_refund'];
  for (const name of changes) {
    assert.equal(scope.has(name), false, name + ' must not be usable');
    assert.ok(!scope.catalog.includes(name + ','), name + ' must not be listed');
    assert.ok(scope.describe(name).error, name + ' must not unlock');
  }
  for (const name of PULSE_INITIAL) assert.equal(pulseMayUse(name), true, name);
  assert.equal(scope.has('shopify_list_orders'), true, "a connected app's read stays");
  assert.equal(pulseMayUse('shopify_list_orders'), false, 'a connected app tool that says nothing counts as a change');
});
test('a tool Pulse asks for and cannot use is turned down with what to do instead', () => {
  const src = fs.readFileSync(require.resolve('../lib/pulse.js'), 'utf8');
  assert.match(src, /pulseToolScope\(getPulseTools\(store\), \(name\) => mcpToolReadOnly\(userId, name\)\)/);
  assert.match(src, /say so in your message and they can ask for it in chat/);
});
