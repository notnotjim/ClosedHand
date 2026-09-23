const { test } = require("node:test");
const assert = require("node:assert/strict");
const p = require("../lib/services/recall-protocol");
const d = require("../lib/services/recall-discovery");
const settings = require("../lib/services/recall-settings");
const str = { type: "string" }, integer = { type: "integer" };
const note = { type: "object", properties: { id: str, title: str, body: str, updated_at: str, deleted: { type: "boolean" } } };
const input = { type: "object", properties: { cursor: str, limit: { ...integer, maximum: 2 } } };
const output = { type: "object", properties: { records: { type: "array", items: note }, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } } };
const tool = { name: "list_notes", annotations: { readOnlyHint: true }, inputSchema: input, outputSchema: output };
const op = () => p.mcpOperations([structuredClone(tool)])[0];
async function collect(recipe, operation, invoke, limits) {
  const result = [];
  for await (const batch of p.run(recipe, operation, invoke, "Notebook", limits)) result.push(...batch);
  return result;
}

test("an unfamiliar MCP collection compiles, follows cursors and normalises records", async () => {
  const operation = op(), plan = p.compile([operation]), calls = [];
  assert.equal(plan.recipes.length, 1);
  const records = await collect(plan.recipes[0], operation, async (_, args) => {
    calls.push(args);
    return args.cursor ? { records: [{ id: "c", title: "Hotel", body: "Check in after ten", updated_at: "2026-09-01" }], next_cursor: null, has_more: false }
      : { records: [{ id: "a", title: "Trip", body: "Meet Maya at dinner" }, { id: "b", title: "Train", body: "Depart at nine" }], next_cursor: "next", has_more: true };
  });
  assert.equal(records.length, 3);
  assert.deepEqual(calls, [{ limit: 2 }, { limit: 2, cursor: "next" }]);
  assert.match(records[2].text, /Check in after ten/);
  assert.equal(records[2].updated_at, "2026-09-01");
  assert.equal(plan.recipes[0].complete, true);
});

test("durable and transient readers on the same connection are assessed separately", () => {
  const names = ["list_notes", "get_weather", "list_stock_prices", "get_exchange_rate", "list_telemetry", "get_now_playing", "send_message", "delete_notes"];
  const ops = p.mcpOperations(names.map(name => ({ ...tool, name })));
  const plan = p.compile(ops);
  assert.deepEqual(plan.recipes.map(r => r.operation), ["list_notes"]);
  assert.equal(plan.skipped.length, 7);
  assert.equal(p.compile(p.mcpOperations([{ ...tool, name: "list_weather_research_notes" }])).recipes.length, 1, "a lasting note about weather is different from a live forecast");
});

test("numeric telemetry and secret fields are not turned into recall", () => {
  const metric = op(); metric.outputSchema = { type: "array", items: { type: "object", properties: { id: str, temperature: { type: "number" }, timestamp: str, access_token: str } } };
  assert.equal(p.compile([metric]).recipes.length, 0);
  assert.equal(p.usefulResource('{"temperature":22,"humidity":70}'), false);
  assert.equal(p.usefulResource('{"title":"Trip plan","body":"Meet at the station"}'), true);
  assert.equal(p.usefulResource("OK"), false);
  assert.equal(p.usefulResource("Meet Maya at the station."), true);
});

test("action annotations and missing read guarantees cannot become background calls", async () => {
  const calls = [];
  const ops = p.mcpOperations([{ ...tool, annotations: {} }, { ...tool, name: "create_note", annotations: { readOnlyHint: true } }, { ...tool, name: "list_and_delete_notes", annotations: { readOnlyHint: true } }]);
  const prepared = await d.prepare(ops, {}, null, async o => { calls.push(o.id); });
  assert.equal(prepared.plan.recipes.length, 0);
  assert.deepEqual(calls, []);
});

test("missing scope arguments remain explicit, without searching the entire service", async () => {
  const operation = op(); operation.inputSchema.properties.workspace = str; operation.inputSchema.required = ["workspace"];
  const plan = p.compile([operation]);
  assert.equal(plan.recipes.length, 0);
  assert.match(plan.skipped[0].reason, /workspace scope/);
  const scoped = p.compile([operation], [{ operation: operation.id, args: { workspace: "chosen-workspace" } }]);
  assert.equal(scoped.recipes[0].args.workspace, "chosen-workspace");
});

test("recipes handle nonstandard field names without new application code", async () => {
  const operation = op();
  operation.outputSchema = { type: "object", properties: { entries: { type: "array", items: { type: "object", properties: { ticket_number: str, narrative: str } } } } };
  const plan = p.compile([operation], [{ operation: operation.id, items: "entries", fields: { id: "ticket_number", text: ["narrative"] } }]);
  const rows = await collect(plan.recipes[0], operation, async () => ({ entries: [{ ticket_number: "ch-1", narrative: "Get the roof repaired" }] }));
  assert.equal(rows[0].id, "ch-1");
  assert.match(rows[0].text, /roof/);
  assert.equal(plan.recipes[0].complete, false, "no deletion claims without a pagination contract");
});

test("a reader without outputSchema learns structured fields from one bounded sample", async () => {
  const operation = op(); operation.outputSchema = {};
  operation.inputSchema = { properties: {} };
  let calls = 0;
  const data = { records: [{ id: "a", title: "A note", body: "Something worth keeping" }] };
  const prepared = await d.prepare([operation], {}, null, async () => { calls++; return data; });
  assert.equal(prepared.plan.recipes.length, 1);
  const rows = await collect(prepared.plan.recipes[0], operation, prepared.invoke);
  assert.equal(rows.length, 1); assert.equal(calls, 1, "sample reused for initial sync");
  const fresh = op(); fresh.outputSchema = {}; fresh.inputSchema = { properties: {} };
  const again = await d.prepare([fresh], {}, { signature: prepared.signature, plan: prepared.plan }, async () => { throw new Error("No discovery read expected"); });
  assert.equal(again.plan.recipes.length, 1);
});

test("a primary LLM is never needed to discover, save or execute a recipe", async () => {
  for (const primary of ["anthropic", "openai", "gemini", "ollama", "an-unreleased-provider"]) {
    const operation = op();
    const prepared = await d.prepare([operation], {}, { primary }, async () => { throw new Error("Schema needs no probe"); });
    const rows = await collect(prepared.plan.recipes[0], operation, async () => ({ records: [{ id: "one", title: "Same note", body: "Stable content" }], next_cursor: null }));
    assert.equal(rows[0].text, "title: Same note\nbody: Stable content");
  }
});

test("repeated cursors, repeated records and hidden continuation cannot declare completion", async () => {
  const operation = op(), recipe = p.compile([operation]).recipes[0];
  let count = 0;
  await assert.rejects(collect(recipe, operation, async () => ({ records: [{ id: String(count++), body: "Content" }], next_cursor: "same" })), /repeated/);
  await assert.rejects(collect(recipe, operation, async () => ({ records: [{ id: "same", body: "Content" }], next_cursor: "next" })), /repeated records/);
  await assert.rejects(collect(recipe, operation, async () => ({ records: [], has_more: true })), /omitted the cursor/);
});

test("numbered pagination respects the advertised page cap and has-more flag", async () => {
  const operation = op(); operation.inputSchema = { properties: { page: { ...integer, default: 0 }, page_size: { ...integer, maximum: 2 } } };
  const recipe = p.compile([operation]).recipes[0], pages = [];
  const rows = await collect(recipe, operation, async (_, args) => { pages.push(args); return { records: [{ id: String(args.page), body: "One per page" }], has_more: args.page === 0 }; });
  assert.equal(rows.length, 2);
  assert.deepEqual(pages, [{ page: 0, page_size: 2 }, { page: 1, page_size: 2 }]);
});

test("a separate documented detail reader supplies full content", async () => {
  const listing = op(), detail = { ...op(), id: "read_note", name: "read_note", inputSchema: { properties: { note_id: str }, required: ["note_id"] } };
  const recipe = p.compile([listing], [{ operation: listing.id, detail: { operation: detail.id, param: "note_id", idField: "id" } }]).recipes[0];
  const calls = [];
  const rows = await collect(recipe, listing, async (o, args) => { calls.push([o.id, args]); return o.id === listing.id ? { records: [{ id: "one" }], next_cursor: null } : { id: args.note_id, title: "Full note", body: "The boarding pass is saved with the itinerary" }; }, { operations: [listing, detail] });
  assert.match(rows[0].text, /boarding pass/);
  assert.equal(calls[1][0], "read_note");
});

test("API schemas use the same compiler and runner, including references and nested fields", async () => {
  const spec = { openapi: "3.1.0", servers: [{ url: "https://notebook.example/v1" }], paths: { "/notes": { get: { operationId: "list_notes", parameters: [{ name: "cursor", in: "query", schema: str }, { name: "limit", in: "query", schema: { ...integer, maximum: 2 } }], responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Page" } } } } } } } }, components: { schemas: { Page: output } } };
  const ops = p.openApiOperations(spec, ["https://notebook.example"]), plan = p.compile(ops), calls = [];
  const invoke = d.httpInvoke(async (url, options) => { calls.push([url, options]); return { records: [{ id: "a", body: "Remember my appointment" }], next_cursor: null }; }, ["https://notebook.example"], "fixture-secret");
  assert.equal(plan.recipes.length, 1);
  const rows = await collect(plan.recipes[0], ops[0], invoke);
  assert.equal(rows.length, 1);
  assert.equal(calls[0][0], "https://notebook.example/v1/notes?limit=2");
  assert.equal(calls[0][1].headers.Authorization, "Bearer fixture-secret");
  assert.ok(!JSON.stringify(plan).includes("fixture-secret"));
});

test("an arbitrary API description cannot move credentials to another origin", () => {
  assert.throws(() => d.checkUrl("https://attacker.example/records", ["https://notebook.example"]), /approved/);
  assert.throws(() => d.checkUrl("https://user:pass@notebook.example/records", ["https://notebook.example"]), /approved/);
  assert.throws(() => d.checkUrl("https://127.0.0.1/records", ["https://127.0.0.1"]), /approved/);
  const row = { config: { recall_api: { origins: ["https://notebook.example"] } } };
  assert.throws(() => settings.validateDescription({ openapiUrl: "https://attacker.example/spec" }, row, "connection"), /approved/);
});

test("explicit tombstones are separate from readable passages", async () => {
  const operation = op(), recipe = p.compile([operation]).recipes[0];
  const rows = await collect(recipe, operation, async () => ({ records: [{ id: "removed", deleted: true }], next_cursor: null }));
  assert.deepEqual(rows, [{ id: "removed", deleted: true }]);
});

test("prototype paths, secret fields and invalid argument types are rejected", async () => {
  const operation = op(), recipe = p.compile([operation]).recipes[0];
  assert.throws(() => p.validateRecipe({ ...recipe, fields: { id: "__proto__.id", text: ["body"] } }, operation), /stable/);
  assert.throws(() => p.validateRecipe({ ...recipe, fields: { id: "id", text: ["access_token"] } }, operation), /readable fields/);
  operation.inputSchema.properties.workspace = { type: "string", enum: ["chosen"] };
  await assert.rejects(collect({ ...recipe, args: { workspace: "other" } }, operation, async () => {}), /allowed values/);
});

test("a generic parent collection supplies project IDs and scopes child record identities", async () => {
  const child = op(); child.inputSchema.properties.project_id = str; child.inputSchema.required = ["project_id"];
  const parent = { ...op(), id: "list_projects", name: "list_projects" };
  const operations = [child, parent], plan = p.compile(operations);
  assert.equal(plan.recipes.length, 2);
  const recipe = plan.recipes.find(r => r.operation === child.id);
  assert.deepEqual(recipe.scope, { operation: "list_projects", param: "project_id" });
  const ids = [];
  const rows = await collect(recipe, child, async (o, args) => {
    if (o.id === parent.id) return { records: [{ id: "p1", title: "Home" }, { id: "p2", title: "Work" }], next_cursor: null };
    ids.push(args.project_id);
    return { records: [{ id: "one", body: "A scoped note" }], next_cursor: null };
  }, { operations, recipes: plan.recipes });
  assert.deepEqual(ids, ["p1", "p2"]);
  assert.deepEqual(rows.map(r => r.id), ["p1\0one", "p2\0one"]);
});

test("partial parents keep children partial and ambiguous parents are not guessed", () => {
  const child = op(); child.inputSchema.properties.project_id = str; child.inputSchema.required = ["project_id"];
  const parent = { ...op(), id: "list_projects", name: "list_projects", inputSchema: { properties: {} } };
  const plan = p.compile([child, parent]);
  assert.equal(plan.recipes.find(r => r.operation === child.id).complete, false);
  const ambiguous = p.compile([child, parent, { ...parent, id: "list_archived_projects", name: "list_archived_projects" }]);
  assert.equal(ambiguous.recipes.some(r => r.operation === child.id), false);
});

test("HTTP path parameters use the same scoped recipe without changing origin", async () => {
  const spec = { openapi: "3.1.0", servers: [{ url: "https://diary.example/api" }], paths: { "/projects/{project_id}/notes": { get: { operationId: "list_notes", parameters: [{ in: "path", name: "project_id", required: true, schema: str }], responses: { "200": { content: { "application/json": { schema: output } } } } } } } };
  const operations = p.openApiOperations(spec, ["https://diary.example"]);
  const recipe = p.compile(operations, [{ operation: "list_notes", args: { project_id: "selected/project" } }]).recipes[0];
  const urls = [];
  await collect(recipe, operations[0], d.httpInvoke(async url => { urls.push(url); return { records: [{ id: "a", body: "Record" }] }; }, ["https://diary.example"], "fixture"));
  assert.deepEqual(urls, ["https://diary.example/api/projects/selected%2Fproject/notes"]);
});
