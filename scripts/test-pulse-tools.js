// Pulse's writer starts with a few tools and unlocks the rest on demand, as
// the chat does, instead of resending every tool on every step.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { INTERNAL_TOOLS } = require('../lib/tools/definitions');
const { PULSE_INITIAL, pulseToolScope } = require('../lib/pulse-tools');
const connectedApp = [
  { name: 'shopify_list_orders', description: 'List recent orders in the connected Shopify store.', input_schema: { type: 'object', properties: { status: { type: 'string' } } } },
  { name: 'linear_search_issues', description: 'Search issues in Linear.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
];
const all = [...INTERNAL_TOOLS.map(t => ({ name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object', properties: {} } })), ...connectedApp];
const names = defs => defs.map(t => t.name);

test('every starting tool exists, so a rename cannot silently drop one', () => {
  const known = new Set(INTERNAL_TOOLS.map(t => t.name));
  for (const name of PULSE_INITIAL) assert.ok(known.has(name), name);
});
test('the writer starts with its own tools in full and sees every other one, connected apps included, by name', () => {
  const scope = pulseToolScope(all);
  const first = names(scope.definitions([]));
  for (const name of PULSE_INITIAL) assert.ok(first.includes(name), name);
  assert.ok(!first.includes('shopify_list_orders'), 'a connected app waits to be unlocked');
  assert.deepEqual([...first].sort(), [...PULSE_INITIAL].sort(), 'exactly the starting set, the same every check');
  for (const t of all) assert.ok(scope.catalog.includes(t.name), 'listed: ' + t.name);
  assert.match(scope.catalog, /get_tool_details/);
});
test('asking for a tool unlocks it on the next step, connected apps included; unknown names are refused', () => {
  const scope = pulseToolScope(all);
  const described = scope.describe('shopify_list_orders');
  assert.equal(described.name, 'shopify_list_orders'); assert.ok(described.input_schema);
  assert.match(scope.describe('no_such_tool').error, /not available/);
  const messages = [{ role: 'assistant', content: [{ type: 'tool_use', name: 'get_tool_details', input: { tool_name: 'shopify_list_orders' } }] }];
  assert.ok(names(scope.definitions(messages)).includes('shopify_list_orders'));
  assert.equal(scope.has('shopify_list_orders'), true); assert.equal(scope.has('no_such_tool'), false);
});
test('each writer step carries a fraction of what it used to', () => {
  const scope = pulseToolScope(all);
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
