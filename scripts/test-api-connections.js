// A service connected with a key, end to end: finding its API from its name,
// checking the key, using it from the chat with the key locked to the
// service's own address, and a key pasted into a chat kept out of it with a
// note said once. Every key, service and address here is invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const conns = require("../lib/api-connections");
const finder = require("../webapp/api-finder");
const keyCatch = require("../lib/key-catch");

const KEY = "kv_live_" + "Q7rT2mX9".repeat(4);
const conn = { id: "c1", name: "Kestrel Voice", base: "https://api.kestrel-voice.example/v2", host: "api.kestrel-voice.example", auth: { in: "header", name: "X-Kestrel-Key" }, key: KEY, description: "https://api.kestrel-voice.example/openapi.json", docs: null, endpoints: 4 };

// The invented service's published description.
const DESCRIPTION = {
  openapi: "3.1.0",
  servers: [{ url: "https://api.kestrel-voice.example/v2" }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Kestrel-Key" } } },
  paths: {
    "/me": { get: { summary: "Who the key belongs to" } },
    "/voices": { get: { summary: "List voices" } },
    "/speech/{voice_id}": { post: { summary: "Text to speech", parameters: [{ name: "voice_id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } } } },
    "/projects/{id}": { delete: { summary: "Delete a project" } },
  },
};

// A stand-in for the network: records each request, answers from a list.
function net(answers) {
  const sent = [];
  const fetch = async (url, opts = {}) => {
    sent.push({ url, ...opts });
    const a = typeof answers === "function" ? answers(url, opts) : answers.shift();
    const body = Buffer.isBuffer(a.body) ? a.body : Buffer.from(typeof a.body === "string" ? a.body : JSON.stringify(a.body ?? {}));
    return { status: a.status || 200, ok: (a.status || 200) < 300, headers: new Map(Object.entries({ "content-type": a.type || "application/json" })), body: [body], text: async () => body.toString("utf8") };
  };
  return { fetch, sent };
}

test("the key goes only to the connection's own address, and nothing else is sent anywhere", async () => {
  for (const url of ["https://api.someone-else.example/v2/me", "http://api.kestrel-voice.example/v2/me", "https://user:pw@api.kestrel-voice.example/v2/me", "not an address"]) {
    const { fetch, sent } = net([{ body: {} }]);
    await assert.rejects(conns.request(conn, { url }, { fetch }), /only ever sent to api\.kestrel-voice\.example|full address/);
    assert.equal(sent.length, 0, url);
  }
});

test("the key is added the way the service takes it, and the model can't set it or move it", async () => {
  const { fetch, sent } = net([{ body: { ok: true } }, { body: {} }, { body: {} }]);
  assert.deepEqual(await conns.request(conn, { method: "POST", url: conn.base + "/speech/v1", body: { text: "Hi" }, headers: { "x-kestrel-key": "theirs", Authorization: "Bearer theirs", Host: "elsewhere.example", "X-Trace": "1" } }, { fetch }), { ok: true });
  assert.equal(sent[0].headers["X-Kestrel-Key"], KEY);
  assert.equal(sent[0].headers["x-kestrel-key"], undefined);
  assert.equal(sent[0].headers.Authorization, undefined);
  assert.equal(sent[0].headers.Host, undefined);
  assert.equal(sent[0].headers["X-Trace"], "1");
  assert.equal(sent[0].redirect, "manual", "a redirect is never followed with the key");
  assert.equal(sent[0].body, '{"text":"Hi"}');
  await conns.request({ ...conn, auth: { in: "header", name: "Authorization", prefix: "Bearer " } }, { url: conn.base + "/me" }, { fetch });
  assert.equal(sent[1].headers.Authorization, "Bearer " + KEY);
  await conns.request({ ...conn, auth: { in: "query", name: "api_key" } }, { url: conn.base + "/me?x=1" }, { fetch });
  assert.equal(new URL(sent[2].url).searchParams.get("api_key"), KEY);
});

test("what comes back never holds the key, a move elsewhere is refused, and a file goes to the chat", async () => {
  const echo = net([{ status: 400, body: `bad request for key ${KEY}` }]);
  await assert.rejects(conns.request(conn, { url: conn.base + "/me" }, { fetch: echo.fetch }), (e) => !e.message.includes(KEY) && /\[key\]/.test(e.message));
  const refused = net([{ status: 401, body: "invalid key" }]);
  await assert.rejects(conns.request(conn, { url: conn.base + "/me" }, { fetch: refused.fetch }), /refused the key \(401\).*paste a new one under Connections/);
  const moved = net([{ status: 302, body: "" }]);
  await assert.rejects(conns.request(conn, { url: conn.base + "/me" }, { fetch: moved.fetch }), /doesn't follow/);
  const files = [];
  const audio = net([{ type: "audio/mpeg", body: Buffer.from("ID3 kestrel speech") }]);
  const got = await conns.request(conn, { method: "POST", url: conn.base + "/speech/v1", body: { text: "Hi" } }, { fetch: audio.fetch, deliver: async (f) => files.push(f) });
  assert.equal(files[0].buffer.toString(), "ID3 kestrel speech");
  assert.equal(files[0].mimeType, "audio/mpeg");
  assert.match(got.note, /Sent to the person/);
});

test("the endpoint list comes from the service's own description; with none, its documentation", async () => {
  const { fetch } = net([{ body: DESCRIPTION }]);
  const found = await conns.endpoints(conn, "turn text into speech", { fetch });
  assert.equal(found.endpoints[0].call, "POST https://api.kestrel-voice.example/v2/speech/{voice_id}");
  assert.match(found.endpoints[0].body, /text \(required\): string/);
  assert.match(found.note, /service set to "Kestrel Voice"/);
  const docsOnly = await conns.endpoints({ ...conn, description: null, docs: "https://docs.kestrel-voice.example/api" }, "list voices");
  assert.equal(docsOnly.docs, "https://docs.kestrel-voice.example/api");
  assert.match(docsOnly.note, /web_fetch/);
});

test("connections load fresh when changed, and the prompt names them without the key", async () => {
  const rows = [
    { id: "c1", name: "Kestrel Voice", server_url: conn.base, updated_at: "1", status: "connected", transport: "api", auth_token: "sealed", caps: { api: { auth: conn.auth, endpoints: 4, openapi: conn.description } } },
    { id: "c2", name: "Heron Maps", server_url: "https://api.heron.example", updated_at: "1", status: "error", transport: "api", auth_token: "sealed", caps: { api: { auth: conn.auth } } },
  ];
  const db = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }) };
  const list = await conns.load("u-test", { db, openRow: (r) => ({ ...r, auth_token: KEY }) });
  assert.deepEqual(list.map((c) => c.name), ["Kestrel Voice"], "one that stopped working isn't offered");
  assert.equal(conns.forService("u-test", "kestrel voice").host, "api.kestrel-voice.example");
  assert.equal(conns.has("u-test"), true);
  const lines = conns.promptLines("u-test").join("\n");
  assert.match(lines, /Kestrel Voice: https:\/\/api\.kestrel-voice\.example\/v2, with its endpoint list/);
  assert.ok(!lines.includes(KEY));
});

// The person's model, answering the finder's question.
const reply = (input) => async () => ({ content: [{ type: "tool_use", name: "report_api", input }] });
const MODEL = { model: "kestrel-1" };

test("finding a service's API: its own description outranks the model on how the key goes", async () => {
  const { fetch, sent } = net((url) => url === "https://api.kestrel-voice.example/openapi.json" ? { body: DESCRIPTION } : { status: 404, body: "" });
  const plan = await finder.findApi("kestrel", MODEL, { fetch, request: reply({ found: true, name: "Kestrel Voice", api_base_url: "https://api.kestrel-voice.example", key_sent_as: "bearer", openapi_url: "https://api.kestrel-voice.example/openapi.json", docs_url: "https://docs.kestrel-voice.example", check_path: "/nowhere" }) });
  assert.equal(plan.found, true);
  assert.equal(plan.service, "Kestrel Voice");
  assert.equal(plan.base, "https://api.kestrel-voice.example/v2");
  assert.deepEqual(plan.auth, { in: "header", name: "X-Kestrel-Key" });
  assert.equal(plan.endpoints, 4);
  assert.equal(plan.check, "/me", "a path the description doesn't have is replaced by one it does");
  assert.ok(sent.every((s) => !JSON.stringify(s).includes("Bearer")), "no key was sent while finding");
});

test("a name typed a bit off is asked again by the name the model gives it", async () => {
  const asked = [];
  const request = async (selected, body) => {
    const name = body.messages[0].content.replace("The service: ", "");
    asked.push(name);
    return { content: [{ type: "tool_use", name: "report_api", input: name === "Kestrel Voice"
      ? { found: true, name: "Kestrel Voice", api_base_url: "https://api.kestrel-voice.example", key_sent_as: "header", key_name: "X-Kestrel-Key" }
      : { found: false, name: "Kestrel Voice" } }] };
  };
  const { fetch } = net(() => ({ status: 404, body: "" }));
  const plan = await finder.findApi("kestrl voice", MODEL, { fetch, request });
  assert.equal(plan.found, true);
  assert.equal(plan.service, "Kestrel Voice");
  assert.deepEqual(asked, ["kestrl voice", "Kestrel Voice"]);
  const never = await finder.findApi("Heron", MODEL, { fetch, request: async (s, b) => { asked.push(b.messages[0].content); return { content: [{ type: "tool_use", name: "report_api", input: { found: false, name: "Heron Maps" } }] }; } });
  assert.equal(never.found, false, "asked twice at most");
  assert.equal(asked.length, 4);
});

test("a service the model doesn't know, one needing more than a key, or an address that isn't public is not connected", async () => {
  const { fetch } = net(() => ({ status: 404, body: "" }));
  for (const [answer, why] of [
    [{ found: false }, /doesn't know an API/],
    [{ found: true, more_than_a_key: true, name: "Heron" }, /more than a key/],
    [{ found: true, api_base_url: "http://api.heron.example", key_sent_as: "bearer" }, /couldn't find where/],
    [{ found: true, api_base_url: "https://localhost/api", key_sent_as: "bearer" }, /couldn't find where/],
    [{ found: true, api_base_url: "https://api.heron.example", key_sent_as: "header", key_name: "Cookie" }, /couldn't tell how/],
  ]) {
    const plan = await finder.findApi("Heron", MODEL, { fetch, request: reply(answer) });
    assert.equal(plan.found, false);
    assert.match(plan.why, why);
  }
  assert.match((await finder.findApi("Heron", null)).why, /under Models/);
});

test("checking a key: a 401 or a message calling it invalid is a refusal, a bare 403 isn't, and nothing follows a redirect", async () => {
  const plan = { base: "https://api.kestrel-voice.example/v2", auth: { in: "header", name: "X-Kestrel-Key" }, check: "/me" };
  for (const [status, ok, body] of [[200, true], [401, false], [400, false, '{"detail":{"code":"invalid_api_key"}}'], [403, false, "API key is invalid"], [403, null, "missing the voices_read permission"], [400, null, "bad request"], [302, null], [500, null]]) {
    const { fetch, sent } = net([{ status, body: body || "" }]);
    assert.deepEqual(await finder.testKey(plan, KEY, { fetch }), { ok }, String(status));
    assert.equal(sent[0].url, "https://api.kestrel-voice.example/v2/me");
    assert.equal(sent[0].headers["X-Kestrel-Key"], KEY);
    assert.equal(sent[0].redirect, "manual");
  }
  assert.deepEqual(await finder.testKey({ ...plan, check: null }, KEY), { ok: null }, "nothing to check against: nothing sent");
});

const dashboardUrl = async (platform, section) => (platform === "web" ? `/dashboard#${section}` : `https://kestrel-home.example/dashboard#${section}`);
const ELEVEN = "sk_" + "3f9a".repeat(12);

test("a key pasted in a chat app is kept out, and the advice to make a new one is given once for that key", async () => {
  const first = keyCatch.check("u-chat", `here's my ElevenLabs key ${ELEVEN}`);
  assert.equal(first.text, "here's my ElevenLabs key [ElevenLabs key withheld]");
  const said = await keyCatch.reply("u-chat", first, "telegram", { dashboardUrl });
  assert.match(said, /^That looks like your ElevenLabs key, so I've left it out of what I read and keep\./);
  assert.match(said, /still in this chat's history in Telegram, so the safest thing is to make a new key with ElevenLabs/);
  assert.match(said, /To connect ElevenLabs, paste it under Connections on your dashboard: https:\/\/kestrel-home\.example\/dashboard#connect$/);
  assert.doesNotMatch(said, /rest of your message/);
  const again = await keyCatch.reply("u-chat", keyCatch.check("u-chat", ELEVEN), "telegram", { dashboardUrl });
  assert.doesNotMatch(again, /make a new key/, "said once for this key");
  assert.ok(!said.includes(ELEVEN) && !again.includes(ELEVEN));
});

test("in the web chat the note links to Connections, and a message with more in it asks for the rest again", async () => {
  const caught = keyCatch.check("u-web", `my key is Kq7Vb2Lm9Xc4Rt8Zp3Wn6Yd, also what's on my calendar tomorrow afternoon`);
  const said = await keyCatch.reply("u-web", caught, "web", { dashboardUrl });
  assert.match(said, /That looks like a key/);
  assert.doesNotMatch(said, /make a new key/, "the web chat stays on the computer");
  assert.match(said, /send it again without the key/);
  assert.match(said, /To connect the service it's for, paste it under \[Connections on your dashboard\]\(\/dashboard#connect\)\.$/);
});

test("a key the person announced in the message before is caught; an ordinary long string is not", async () => {
  assert.equal(keyCatch.check("u-next", "I'll send you my Heron token next"), null);
  assert.equal(keyCatch.check("u-next", "Kq7Vb2Lm9Xc4Rt8Zp3Wn6Yd").text, "[key withheld]");
  assert.equal(keyCatch.check("u-next", "Kq7Vb2Lm9Xc4Rt8Zp3Wn6Yd"), null, "only the message after");
  assert.equal(keyCatch.check("u-other", "Kq7Vb2Lm9Xc4Rt8Zp3Wn6Yd"), null);
});

test("an AI provider's key is pointed at Closedhand's AI", async () => {
  const caught = keyCatch.check("u-ai", "sk-ant-api03-" + "Zq7Lm2".repeat(6));
  assert.match(await keyCatch.reply("u-ai", caught, "web", { dashboardUrl }), /To use it for Closedhand's AI, paste it under/);
});

test("every way in is covered: the queue, the web chat's store, and the old send route", () => {
  const root = path.join(__dirname, "..");
  const engine = fs.readFileSync(path.join(root, "lib/engine.js"), "utf8");
  const queued = engine.slice(engine.indexOf("function queuedAsk("));
  assert.ok(queued.indexOf('require("./key-catch").check') > 0 && queued.indexOf('require("./key-catch").check') < queued.indexOf("markInflight(userId"), "caught before anything is recorded");
  const ws = fs.readFileSync(path.join(root, "lib/web-chat-ws.js"), "utf8");
  assert.ok(ws.indexOf('require("./key-catch").check') < ws.indexOf('from("web_messages").insert'), "the web chat stores the placeholder");
  const server = fs.readFileSync(path.join(root, "webapp/server.js"), "utf8");
  assert.match(server, /content: apiKeys\.withhold\(message\.trim\(\)\)\.text/);
  const mcps = fs.readFileSync(path.join(root, "lib/user-mcp.js"), "utf8");
  assert.match(mcps, /r\.transport !== "api"/, "a key connection is never opened as an MCP server");
});
