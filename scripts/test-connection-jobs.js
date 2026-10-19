// A connected service takes over a job Closedhand does itself, whatever the
// service and however it is connected: its tools are read once, it gets a
// switch on its tile, on from the start, and Closedhand uses it first without
// being asked, falling back to its own when it fails. Search here; the voice
// is the same mechanism (test-voice-connections.js). Every service, tool and
// address here is invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { findJobs, saved, checkTool, TOOL_JOBS } = require("../webapp/connection-jobs");
const jobs = require("../lib/connection-jobs");
const { webSearch } = require("../lib/web-search");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const MODEL = { model: "kestrel-1" };
const answer = (input) => async () => ({ content: [{ type: "tool_use", name: "report_jobs", input }] });

// An invented search service's tools, as services publish them.
const TOOLS = [
  { name: "kestrel_web_search", description: "Search the web and return ranked results with titles, links and snippets.",
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, num: { type: "integer", default: 5 }, safe: { type: "string", enum: ["on", "off"] } } } },
  { name: "kestrel_account", description: "Show how many searches are left this month.", inputSchema: { type: "object", properties: {} } },
];

test("one check finds every job a service can do, and keeps only what its tools bear out", async () => {
  const found = await findJobs(TOOLS, MODEL, { request: answer({
    speak: { found: false }, hear: { found: false },
    search: { found: true, tool: "kestrel_web_search", query_argument: "q", fixed_arguments: { safe: "on" } },
  }) });
  assert.equal(found.voice, null);
  assert.deepEqual(found.jobs.search, { tool: "kestrel_web_search", args: { query: "q" }, fixed: { safe: "on" } });
  assert.equal(checkTool(TOOLS, { found: true, tool: "kestrel_web_search", query_argument: "query" }, "search"), null, "an argument it doesn't take");
  assert.equal(checkTool(TOOLS, { found: true, tool: "kestrel_web_search", query_argument: "q", fixed_arguments: { safe: "maybe" } }, "search"), null, "a value its list doesn't allow");
  assert.equal(checkTool(TOOLS, { found: true, tool: "kestrel_search_v2", query_argument: "q" }, "search"), null, "a tool it doesn't have");
  assert.ok(Object.keys(TOOL_JOBS).includes("search"));
});

test("a job found is switched on the first time, left as the person set it after, and kept when the check can't run", () => {
  const plan = { tool: "kestrel_web_search", args: { query: "q" }, fixed: {} };
  const first = saved({ voice: null, jobs: { search: plan } }, null, null);
  assert.equal(first.jobs.search.on, true);
  const again = saved({ voice: null, jobs: { search: plan } }, null, { search: { ...plan, on: false } });
  assert.equal(again.jobs.search.on, false, "the person's switch stays");
  const unchecked = saved({ voice: undefined, jobs: undefined }, null, { search: { ...plan, on: false } });
  assert.deepEqual(unchecked.jobs, { search: { ...plan, on: false } });
  const gone = saved({ voice: null, jobs: { search: null } }, null, { search: { ...plan, on: true } });
  assert.deepEqual(gone.jobs, {}, "a tool that went away takes its switch with it");
});

// A stand-in for the database: one connection that searches.
function store(plan, transport = "http") {
  const row = { id: "kestrel-row", name: "Kestrel Search", updated_at: "1", transport, caps: { jobs: { search: plan } } };
  const writes = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: async () => ({ data: [row], error: null }), single: async () => ({ data: { caps: row.caps }, error: null }) }),
      }),
      update: (patch) => ({ eq: async () => { writes.push(patch.caps.jobs.search); row.caps = patch.caps; return { error: null }; } }),
    }),
  };
  return { db, writes, row };
}
const PLAN = { tool: "kestrel_web_search", args: { query: "q" }, fixed: { safe: "on" }, on: true };

test("Closedhand searches with the connected service first, unasked, and its own search stands in when it fails", async () => {
  const { db, writes } = store(PLAN);
  const calls = [];
  const callTool = async (userId, rowId, tool, args) => { calls.push([tool, args]); return { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Ferry times", url: "https://ferries.example/times" }] }) }] }; };
  const providerSearch = { forProvider: () => ({ label: "Provider", search: async () => { throw new Error("should not be asked"); } }) };
  const freeSearch = async () => { throw new Error("should not be asked"); };
  const got = await webSearch("ferry times", 5, { userId: "u1", connected: { run: (u, j, i) => jobs.run(u, j, i, { db, callTool }) }, providerSearch, freeSearch });
  assert.deepEqual(calls, [["kestrel_web_search", { safe: "on", q: "ferry times" }]]);
  assert.equal(got.source, "Kestrel Search");
  assert.deepEqual(got.results, [{ title: "Ferry times", url: "https://ferries.example/times" }]);

  const quiet = console.warn; console.warn = () => {};
  try {
    const failing = async () => { throw new Error("monthly limit reached"); };
    const fallback = await webSearch("ferry times", 5, { userId: "u1", connected: { run: (u, j, i) => jobs.run(u, j, i, { db, callTool: failing }) }, providerSearch: { forProvider: () => null }, freeSearch: async () => ({ results: [{ title: "free" }], source: "DuckDuckGo" }) });
    assert.equal(fallback.source, "DuckDuckGo");
    assert.match(writes.at(-1).fallback.why, /Kestrel Search couldn't search: monthly limit reached/, "the tile says why");
  } finally { console.warn = quiet; }
});

test("switched off, or for someone else, the connection isn't asked", async () => {
  const { db } = store({ ...PLAN, on: false });
  let asked = 0;
  assert.equal(await jobs.run("u1", "search", { query: "x" }, { db, callTool: async () => { asked++; } }), null);
  assert.equal(await jobs.run(null, "search", { query: "x" }, { db, callTool: async () => { asked++; } }), null);
  assert.equal(asked, 0);
});

test("a service connected with a key does it through its own endpoint", async () => {
  const finder = require("../webapp/api-finder");
  const keys = require("../lib/api-keys");
  const description = { openapi: "3.1.0", servers: [{ url: "https://api.kestrel-search.example/v1" }],
    components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Kestrel-Key" } } },
    paths: { "/search": { get: { summary: "Web search", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }] } },
      "/usage": { get: { summary: "Usage this month" } } } };
  const list = keys.readApiDescription(description, "https://api.kestrel-search.example").endpoints;
  const plan = { base: "https://api.kestrel-search.example/v1", auth: { in: "header", name: "X-Kestrel-Key" }, list };
  const { jobs: found } = await finder.jobsFor(plan, "kk_invented", MODEL, null, { request: answer({ speak: { found: false }, hear: { found: false }, search: { found: true, tool: "GET /search", query_argument: "q" } }) });
  assert.deepEqual({ tool: found.search.tool, args: found.search.args, on: found.search.on }, { tool: "GET /search", args: { query: "q" }, on: true });
  const req = keys.requestFor(list.find((e) => e.path === "/search"), plan.base, { q: "ferry times" });
  assert.equal(req.url, "https://api.kestrel-search.example/v1/search?q=ferry+times");
});

test("the server, tile and privacy pages carry every job, not only the voice", () => {
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/mcps\/:id\/job"/);
  assert.match(server, /async function mcpJobsFor\(userId, tools, previousCaps\)/);
  assert.doesNotMatch(server, /voice-tools/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /title: 'Closedhand\\u2019s search'/);
  assert.match(dash, /Object\.keys\(caps\.jobs \|\| \{\}\)\.forEach\(function\(job\) \{/);
  assert.match(read("lib/tools/handlers.js"), /webSearch\(toolInput\.query, toolInput\.count, \{ settings: [^}]+\}, userId: toolInput\._userId \|\| ctx\.activeUserId \}\)/);
  for (const page of ["webapp/views/privacy.html", "closedhand-com/views/privacy.html"]) {
    assert.match(read(page), /web searches go to a search service you connected, if you did, then to your AI provider's own search/);
  }
});
