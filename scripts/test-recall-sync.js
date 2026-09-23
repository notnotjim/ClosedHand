const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createConnector } = require("../lib/services/usi-connector");
const { oauthItems } = require("../lib/services/recall-adapters");

// A behavioural DB double, with user/source filters enforced on every query.
function memoryDb(seed = {}) {
  const tables = { connections: [], user_mcps: [], index_progress: [], data_cache: [], data_vectors: [], ...structuredClone(seed) };
  const writes = [];
  let seq = 0;
  return { tables, writes, from(table) {
    let action = "select", payload, keys = [], filters = [], from = 0, to = Infinity;
    const q = {
      select() { return q; }, order() { return q; },
      eq(k, v) { filters.push(row => row[k] && typeof row[k] === "object" ? JSON.stringify(row[k]) === (typeof v === "string" ? v : JSON.stringify(v)) : row[k] === v); return q; },
      is(k, v) { filters.push(row => v === null ? row[k] == null : row[k] === v); return q; },
      in(k, vs) { filters.push(row => vs.includes(row[k])); return q; },
      range(a, b) { from = a; to = b; return q; },
      upsert(value, opts) { action = "upsert"; payload = value; keys = opts.onConflict.split(","); return q; },
      update(value) { action = "update"; payload = value; return q; },
      delete() { action = "delete"; return q; },
      then(resolve, reject) {
        try {
          const matching = row => filters.every(fn => fn(row));
          const matched = tables[table].filter(matching);
          if (action !== "select") writes.push({ table, action, payload });
          if (action === "delete") tables[table] = tables[table].filter(row => !matching(row));
          if (action === "update") for (const row of tables[table].filter(matching)) Object.assign(row, structuredClone(payload));
          if (action === "upsert") {
            const row = tables[table].find(row => keys.every(k => row[k] === payload[k]));
            if (row) Object.assign(row, structuredClone(payload));
            else tables[table].push({ id: `row-${++seq}`, ...structuredClone(payload) });
          }
          return Promise.resolve({ data: structuredClone((action === "update" ? matched : tables[table].filter(matching)).slice(from, to + 1)), error: null }).then(resolve, reject);
        } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
    return q;
  } };
}
const conn = { id: "conn-a", user_id: "user-a", service: "github", tokens: { access_token: "fixture" }, updated_at: "v1" };
const server = { id: "mcp-a", user_id: "user-a", name: "Travel", server_url: "https://fixture.invalid/mcp", status: "connected", updated_at: "v1" };
function harness(seed = {}, overrides = {}) {
  let clock = 2000000000000, closed = 0;
  const db = memoryDb(seed), indexed = [];
  const client = {
    getServerCapabilities: () => ({ resources: {} }),
    listResources: async () => ({ resources: [{ uri: "travel://trip", name: "Trip" }] }),
    readResource: async () => ({ contents: [{ text: "Train leaves at 8 tomorrow morning." }] }),
    callTool() { throw new Error("A background reader must never call a tool"); },
  };
  const api = createConnector({ db, now: () => clock, decryptTokens: x => x, encryptTokens: x => x,
    request: async () => [{ id: 1, title: "Flight", body: "Flight changed to 10pm", state: "open" }],
    indexItems: async (...args) => { indexed.push(args); },
    mcp: { openClient: async () => ({ client }), closeQuietly: async () => { closed++; } },
    ...overrides,
  });
  return { db, client, indexed, api, closed: () => closed, advance: () => { clock += 16 * 60000; } };
}

test("a saved GitHub connection is enrolled without the webapp hook or an LLM call", async () => {
  const h = harness({ connections: [conn] });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  assert.match(h.db.tables.data_cache[0].data.body, /10pm/);
  assert.equal(h.indexed[0][1], "connected:github");
  assert.equal(h.indexed[0][3][0]._skipEnrich, true);
  assert.equal(h.indexed[0][4].scoped, true);
  assert.equal(h.db.tables.index_progress[0].status, "synced");
  const writes = h.db.writes.length;
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.writes.length, writes, "respects persisted sync interval");
});

test("unchanged content avoids cache rewrites but still retries missing vectors", async () => {
  const h = harness({ connections: [conn] });
  await h.api.syncConnectedServices("user-a");
  const count = h.db.writes.filter(w => w.table === "data_cache").length;
  h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.writes.filter(w => w.table === "data_cache").length, count);
  assert.equal(h.indexed.length, 2, "scoped indexer can repair a previous embedding failure");
});

test("MCP resources paginate, update, delete and never invoke tools", async () => {
  const h = harness({ user_mcps: [server] });
  h.client.listResources = async params => params.cursor ? { resources: [{ uri: "travel://ticket", name: "Ticket" }] } : { resources: [{ uri: "travel://trip", name: "Trip" }], nextCursor: "two" };
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 2);
  h.advance();
  h.client.listResources = async () => ({ resources: [{ uri: "travel://trip", name: "Trip" }] });
  h.client.readResource = async () => ({ contents: [{ text: "Train now leaves at 9." }] });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1, "missing ticket removed only after complete listing");
  assert.match(h.db.tables.data_cache[0].data.body, /9/);
  assert.equal(h.closed(), 2);
});

test("a failed or repeated MCP page cannot delete the unread part of a collection", async () => {
  const h = harness({ user_mcps: [server] });
  await h.api.syncConnectedServices("user-a");
  h.advance();
  h.client.listResources = async () => ({ resources: [], nextCursor: "again" });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  assert.equal(h.db.tables.index_progress[0].status, "error");
});

test("tools-only MCPs remain on demand and do not call listResources or tools", async () => {
  const h = harness({ user_mcps: [server] });
  h.client.getServerCapabilities = () => ({ tools: {} });
  h.client.listResources = async () => { throw new Error("No resources capability"); };
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.index_progress[0].status, "on_demand");
  assert.equal(h.indexed.length, 0);
});

test("resource passages cover the end of a long document with stable IDs", async () => {
  const h = harness({ user_mcps: [server] });
  h.client.readResource = async () => ({ contents: [{ text: "x".repeat(5000) + "The boarding pass code is EXAMPLE." }] });
  await h.api.syncConnectedServices("user-a");
  assert.ok(h.db.tables.data_cache.length > 1);
  assert.ok(h.db.tables.data_cache.some(r => r.data.body.includes("boarding pass code")));
  const ids = h.db.tables.data_cache.map(r => r.external_id);
  h.advance(); await h.api.syncConnectedServices("user-a");
  assert.deepEqual(h.db.tables.data_cache.map(r => r.external_id), ids);
});

test("disconnect during indexing removes in-flight writes and hides the source", async () => {
  let h;
  h = harness({ user_mcps: [server] }, { indexItems: async () => { h.db.tables.user_mcps = []; } });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 0);
  assert.equal((await h.api.activeSources("user-a")).size, 0);
});

test("one user's sync and cleanup cannot read or remove another user's content", async () => {
  const foreign = { id: "foreign", user_id: "user-b", source: "mcp:mcp-a", external_id: "secret", data: { body: "private" } };
  const h = harness({ user_mcps: [server], data_cache: [foreign] });
  await h.api.syncConnectedServices("user-a");
  assert.ok(h.db.tables.data_cache.some(r => r.id === "foreign"));
  assert.equal((await h.api.activeSources("user-b")).size, 0);
});

test("revoked access purges content; an ordinary source failure preserves it for retry", async () => {
  for (const status of [401, 500]) {
    let fail = false;
    const h = harness({ connections: [conn] }, { request: async () => {
      if (fail) throw Object.assign(new Error("failure"), { status });
      return [{ id: 1, title: "Trip", body: "Keep the train booking" }];
    } });
    await h.api.syncConnectedServices("user-a"); h.advance(); fail = true;
    await h.api.syncConnectedServices("user-a");
    assert.equal(h.db.tables.data_cache.length, status === 401 ? 0 : 1);
  }
});

test("unsupported OAuth services are recorded as on demand instead of guessing an API", async () => {
  const h = harness({ connections: [{ ...conn, service: "unknown-service" }] }, { request: async () => { throw new Error("Should not request"); } });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.index_progress[0].status, "on_demand");
});

test("OAuth collection pagination reads beyond the first 100 results and stays on the provider host", async () => {
  const urls = [], all = [];
  for await (const batch of oauthItems("github", "fixture", async url => {
    urls.push(new URL(url));
    const page = Number(new URL(url).searchParams.get("page"));
    return Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({ id: (page - 1) * 100 + i, title: "Issue", body: "Details" }));
  })) all.push(...batch);
  assert.equal(all.length, 101);
  assert.ok(urls.every(url => url.origin === "https://api.github.com"));
});

module.exports = { memoryDb };

test("the scheduler includes MCP-only and non-mail users past the first database page", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/data-sync.js"), "utf8");
  const start = source.indexOf("async function syncAllUsers(mode)");
  const end = source.indexOf("\n}\n", start) + 2;
  const people = Array.from({ length: 501 }, (_, i) => ({ id: String(i), user_id: `service-user-${i}` }));
  const db = memoryDb({ connections: people, user_mcps: [{ id: "mcp-only", user_id: "mcp-user" }], profiles: [] });
  const originalFrom = db.from;
  db.from = table => { const q = originalFrom(table); q.not = () => q; return q; };
  const called = [];
  const box = { supabase: db, process: { env: {} }, console: { log() {}, error() {} },
    pLimit: () => fn => fn(), syncUserData: async id => called.push(id), setTimeout() {},
  };
  vm.runInNewContext(source.slice(start, end) + "\nthis.run = syncAllUsers;", box);
  await box.run("cloud");
  assert.equal(called.length, 502);
  assert.ok(called.includes("mcp-user"));
  assert.ok(called.includes("service-user-500"));
});

test("PostgreSQL Date timestamps do not invalidate an unchanged connection", async () => {
  const h = harness({ connections: [{ ...conn, updated_at: new Date("2026-01-01") }] });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  assert.equal(h.db.tables.index_progress[0].status, "synced");
});

test("choosing to retain data on disconnect is honoured without resuming sync", async () => {
  const h = harness({ connections: [conn] });
  await h.api.syncConnectedServices("user-a");
  h.db.tables.connections = [];
  h.db.tables.index_progress.push({ id: "keep", user_id: "user-a", service: "retained:connected:github", status: "retained" });
  h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  assert.ok((await h.api.activeSources("user-a")).has("connected:github"));
  assert.equal(h.indexed.length, 1);
});

const stringSchema = { type: "string" };
function readableTool(name = "list_notes", pagination = true) {
  return { name, annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: pagination ? { cursor: stringSchema, limit: { type: "integer", maximum: 2 } } : {} },
    outputSchema: { type: "object", properties: { records: { type: "array", items: { type: "object", properties: { id: stringSchema, title: stringSchema, body: stringSchema, deleted: { type: "boolean" } } } }, ...(pagination ? { next_cursor: { type: ["string", "null"] } } : {}) } },
  };
}

test("tools-only connections sync durable lists, skip weather and preserve a validated recipe", async () => {
  const h = harness({ user_mcps: [server] });
  const calls = [];
  h.client.getServerCapabilities = () => ({ tools: {} });
  h.client.listTools = async () => ({ tools: [readableTool(), readableTool("get_weather")] });
  h.client.callTool = async ({ name }) => { calls.push(name); return { structuredContent: { records: [{ id: "a", body: "Meet Maya tomorrow" }], next_cursor: null } }; };
  await h.api.syncConnectedServices("user-a");
  assert.deepEqual(calls, ["list_notes"]);
  assert.equal(h.db.tables.data_cache.length, 1);
  const state = h.db.tables.user_mcps[0].caps.recall_state;
  assert.equal(state.status, "synced");
  assert.equal(state.plan.recipes.length, 1);
  assert.match(state.plan.skipped[0].reason, /Live or short-lived/);
  h.advance(); await h.api.syncConnectedServices("user-a");
  assert.deepEqual(calls, ["list_notes", "list_notes"]);
});

test("mixed collections reconcile separately when another reader fails", async () => {
  const h = harness({ user_mcps: [server] }); let phase = 0;
  h.client.getServerCapabilities = () => ({ tools: {} });
  h.client.listTools = async () => ({ tools: [readableTool("list_notes"), readableTool("list_tickets")] });
  h.client.callTool = async ({ name }) => {
    if (phase && name === "list_tickets") throw new Error("Temporary failure");
    return { structuredContent: { records: phase ? [] : [{ id: "same-id", body: name === "list_notes" ? "Meeting notes" : "Repair the bike" }], next_cursor: null } };
  };
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 2, "record IDs cannot collide between collections");
  phase = 1; h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  assert.match(h.db.tables.data_cache[0].data.body, /bike/);
  assert.equal(h.db.tables.index_progress[0].status, "error");
});

test("partial readers never delete unseen records, but explicit tombstones do", async () => {
  const h = harness({ user_mcps: [server] }); let rows = [{ id: "one", body: "Keep the booking" }];
  h.client.getServerCapabilities = () => ({ tools: {} });
  h.client.listTools = async () => ({ tools: [readableTool("list_notes", false)] });
  h.client.callTool = async () => ({ structuredContent: { records: rows } });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.index_progress[0].status, "partial");
  rows = []; h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  rows = [{ id: "one", deleted: true }]; h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 0);
});

test("a collection reclassified as transient no longer contributes old vectors", async () => {
  const h = harness({ user_mcps: [server] }); let transient = false;
  h.client.getServerCapabilities = () => ({ tools: {} });
  h.client.listTools = async () => ({ tools: [{ ...readableTool(), _meta: { "closedhand/recall": { value: transient ? "transient" : "durable" } } }] });
  h.client.callTool = async () => ({ structuredContent: { records: [{ id: "a", body: "Changing report" }], next_cursor: null } });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  transient = true; h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 0);
  assert.equal(h.db.tables.index_progress[0].status, "on_demand");
});

test("empty collections without schemas are retried when content later appears", async () => {
  const h = harness({ user_mcps: [server] }); let records = [];
  h.client.getServerCapabilities = () => ({ tools: {} });
  h.client.listTools = async () => ({ tools: [{ ...readableTool("list_notes", false), outputSchema: undefined }] });
  h.client.callTool = async () => ({ structuredContent: { records } });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 0);
  records = [{ id: "new", body: "A newly written note" }];
  h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
});

test("an unknown API service follows its OpenAPI document without a bespoke adapter", async () => {
  const template = readableTool(), spec = { openapi: "3.1.0", servers: [{ url: "https://diary.example/api" }], paths: { "/notes": { get: { operationId: "list_notes", parameters: [{ name: "cursor", in: "query", schema: stringSchema }, { name: "limit", in: "query", schema: { type: "integer", maximum: 2 } }], responses: { "200": { content: { "application/json": { schema: template.outputSchema } } } } } } } };
  const connection = { ...conn, service: "never-seen-before", config: { recall_api: { origins: ["https://diary.example"] }, recall: { openapi: spec } } };
  const calls = [], h = harness({ connections: [connection] }, { request: async (url, options) => {
    calls.push({ url, headers: options.headers });
    return { records: [{ id: "entry-1", body: "My bike repair is on Monday" }], next_cursor: null };
  } });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.index_progress[0].status, "synced");
  assert.equal(h.db.tables.data_cache[0].source, "connected:never-seen-before");
  assert.equal(calls[0].url, "https://diary.example/api/notes?limit=2");
  assert.ok((await h.api.activeSources("user-a")).has("connected:never-seen-before"));
});

test("the standard API schema is discovered anonymously before credentials are used", async () => {
  const template = readableTool();
  const spec = { openapi: "3.1.0", servers: [{ url: "https://diary.example" }], paths: { "/notes": { get: { operationId: "list_notes", responses: { "200": { content: { "application/json": { schema: template.outputSchema } } } } } } } };
  const h = harness({ connections: [{ ...conn, service: "diary", config: { recall_api: { origins: ["https://diary.example"] } } }] }, { request: async (url, options) => {
    if (url.endsWith("openapi.json")) { assert.equal(options?.headers?.Authorization, undefined); return spec; }
    assert.equal(options.headers.Authorization, "Bearer fixture");
    return { records: [{ id: "one", body: "Saved note" }], next_cursor: null };
  } });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
});

test("source configuration and status are user scoped and never reveal credentials", async () => {
  const { configure, list } = require("../lib/services/recall-settings");
  const h = harness({ user_mcps: [server] });
  await assert.rejects(configure(h.db, "user-b", "mcp", server.id, { enabled: false }), /not found/);
  await configure(h.db, "user-a", "mcp", server.id, { enabled: false });
  assert.equal((await list(h.db, "user-a"))[0].status, "disabled");
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.indexed.length, 0);
});

test("source descriptions cannot overwrite a concurrent edit even without a timestamp change", async () => {
  const { configure } = require("../lib/services/recall-settings");
  const h = harness({ user_mcps: [{ ...server, caps: { tools: true } }] });
  const original = h.db.from;
  h.db.from = table => {
    const q = original(table), update = q.update;
    q.update = value => {
      h.db.tables.user_mcps[0].caps = { tools: true, recall: { enabled: false } };
      return update(value);
    };
    return q;
  };
  await assert.rejects(configure(h.db, "user-a", "mcp", server.id, { enabled: true }), /changed/);
  assert.equal(h.db.tables.user_mcps[0].caps.recall.enabled, false);
});

test("shortening a record removes old trailing passages even in a partial collection", async () => {
  const h = harness({ user_mcps: [server] }); let body = "Remember this detail. ".repeat(250);
  h.client.getServerCapabilities = () => ({ tools: {} });
  h.client.listTools = async () => ({ tools: [readableTool("list_notes", false)] });
  h.client.callTool = async () => ({ structuredContent: { records: [{ id: "a", body }] } });
  await h.api.syncConnectedServices("user-a");
  assert.ok(h.db.tables.data_cache.length > 2);
  body = "The detail has changed.";
  h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  assert.match(h.db.tables.data_cache[0].data.body, /has changed/);
});

test("structured resources keep useful content without embedding credential fields", async () => {
  const h = harness({ user_mcps: [server] });
  h.client.readResource = async () => ({ contents: [{ text: JSON.stringify({ body: "Useful document content", token: "not-for-recall", nested: { password: "also-private", description: "Keep this detail" } }) }] });
  await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 1);
  assert.match(h.db.tables.data_cache[0].data.body, /Keep this detail/);
  assert.doesNotMatch(h.db.tables.data_cache[0].data.body, /not-for-recall|also-private/);
});

test("an explicit partial collection stays partial even when it supports pagination", async () => {
  const h = harness({ user_mcps: [server] }); let records = [{ id: "a", body: "First note" }, { id: "b", body: "Second note" }];
  h.client.getServerCapabilities = () => ({ tools: {} });
  h.client.listTools = async () => ({ tools: [{ ...readableTool(), _meta: { "closedhand/recall": { complete: false } } }] });
  h.client.callTool = async () => ({ structuredContent: { records, next_cursor: null } });
  await h.api.syncConnectedServices("user-a");
  records = [{ id: "a", body: "Updated note" }];
  h.advance(); await h.api.syncConnectedServices("user-a");
  assert.equal(h.db.tables.data_cache.length, 2);
  assert.equal(h.db.tables.index_progress[0].status, "partial");
});

test("built-in source readers are not falsely reported as waiting for discovery", async () => {
  const { list } = require("../lib/services/recall-settings");
  const h = harness({ connections: [{ ...conn, service: "google" }, { ...conn, id: "other", service: "diary" }] });
  const sources = await list(h.db, "user-a");
  assert.equal(sources.find(s => s.name === "google").status, "existing_reader");
  assert.equal(sources.find(s => s.name === "diary").status, "pending");
});

test("hosted source updates preserve precise revisions without putting schemas in URLs", async () => {
  const { unchanged, configure } = require("../lib/services/recall-settings");
  const timestamp = "2026-01-01T00:00:00.123456Z", filters = [];
  const query = { eq: (key, value) => { filters.push([key, value]); return query; } };
  unchanged(query, "config", { schema: "x".repeat(100000) }, timestamp);
  assert.deepEqual(filters, [["updated_at", timestamp]]);
  const h = harness({ user_mcps: [{ ...server, updated_at: timestamp }] });
  await configure(h.db, "user-a", "mcp", server.id, { enabled: true });
  assert.notEqual(h.db.tables.user_mcps[0].updated_at, timestamp);
});
