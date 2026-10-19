// Keys people paste: which ones Closedhand recognises, which it keeps out of
// a chat, and which long strings it leaves alone. Then reading a service's
// published API description, so a key connects to a service with no code of
// its own. Every key, service and address here is invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const keys = require("../lib/api-keys");

const ELEVEN = "sk_" + "3f9a".repeat(12);
const ANTHROPIC = "sk-ant-api03-" + "Zq7Lm2".repeat(6);
const GITHUB = "ghp_" + "Rk4Tn8Wq2Z".repeat(4);
const PLAIN = "Kq7Vb2Lm9Xc4Rt8Zp3Wn6Yd";

test("a key that says whose it is is recognised by how it starts", () => {
  assert.deepEqual(keys.recognise(ELEVEN), { service: "ElevenLabs", provider: null, signed: false });
  assert.deepEqual(keys.recognise(ANTHROPIC), { service: "Anthropic", provider: "anthropic", signed: false });
  assert.equal(keys.recognise(GITHUB).service, "GitHub");
  assert.equal(keys.recognise("AKIA" + "Q7RT2LMX9WZ4KD8P").signed, true, "needs more than a key");
  assert.deepEqual(keys.recognise("sk-" + "a1b2".repeat(8)), { service: null, provider: null, signed: false }, "a key, whose is a question");
  for (const not of [PLAIN, "sk-learn", "ghp_", "sk_live", "hello"]) assert.equal(keys.recognise(not), null, not);
});

test("a chat keeps out a key that says whose it is, wherever it sits in the message", () => {
  assert.equal(keys.withhold(`use ${ELEVEN}. thanks`).text, "use [ElevenLabs key withheld]. thanks");
  assert.equal(keys.withhold(`(${ANTHROPIC})`).text, "([Anthropic key withheld])");
  assert.equal(keys.withhold(`token=${GITHUB}`).text, "token=[GitHub key withheld]");
  const caught = keys.withhold(`here ${ELEVEN} and again ${ELEVEN}`);
  assert.equal(caught.keys.length, 2);
  assert.equal(caught.keys[0].digest, caught.keys[1].digest, "the same key is known again");
  assert.ok(!JSON.stringify(caught).includes(ELEVEN), "nothing returned holds the key");
});

test("a long string counts only when the person said it's a key", () => {
  assert.equal(keys.withhold(`my key is ${PLAIN}`).text, "my key is [key withheld]");
  assert.equal(keys.withhold(`Here's the Kestrel token: ${PLAIN}`).text, "Here's the Kestrel token: [key withheld]");
  assert.equal(keys.withhold(`API key: ${PLAIN}`).text, "API key: [key withheld]");
  assert.equal(keys.withhold(PLAIN, { saidBefore: true }).text, "[key withheld]", "said in the message before");
  for (const left of [
    PLAIN,
    `the key point is ${PLAIN}`,
    "commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 broke the build",
    "tracking 1Z999AA10123456784 and order 4417-2290-7731-0042",
    `read https://files.example.net/${PLAIN}/report`,
    "booking ref 7f3e2a10-9b4c-4d5e-8f6a-1b2c3d4e5f60",
    `monkey: ${PLAIN}`,
  ]) assert.equal(keys.withhold(left).text, left, left);
});

test("a placeholder left by an earlier catch is answered the same way", () => {
  const got = keys.withhold("[ElevenLabs key withheld]");
  assert.deepEqual(got.keys.map((k) => k.service), ["ElevenLabs"]);
  assert.equal(keys.saysKey("[ElevenLabs key withheld]"), false, "a placeholder is not the person saying a key is coming");
});

test("one long word in the Connections box is a key; an address, a command or JSON is not", () => {
  assert.equal(keys.bareKey(ELEVEN), true);
  assert.equal(keys.bareKey(PLAIN), true);
  for (const not of ["https://mcp.example.com/mcp", "mcp.example2.com", "npx -y kestrel-mcp", '{"url":"https://x.example"}', "short1", "github.com/kestrel/mcp"]) assert.equal(keys.bareKey(not), false, not);
});

// An invented service's description, in the shapes services publish.
const KESTREL = {
  openapi: "3.1.0",
  servers: [{ url: "https://api.kestrel-voice.example/v2" }],
  components: {
    securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Kestrel-Key" } },
    schemas: { Speak: { type: "object", required: ["text"], properties: { text: { type: "string", description: "The words to say." }, format: { type: "string", enum: ["mp3", "wav"] } } } },
  },
  security: [{ key: [] }],
  paths: {
    "/me": { get: { summary: "Who the key belongs to", operationId: "getMe", responses: { 200: { content: { "application/json": {} } } } } },
    "/voices": { get: { summary: "List voices", tags: ["voices"] } },
    "/speech/{voice_id}": {
      parameters: [{ name: "voice_id", in: "path", required: true, schema: { type: "string" } }],
      post: { summary: "Text to speech", description: "Turn text into spoken audio.", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Speak" } } } }, responses: { 200: { content: { "audio/mpeg": {} } } } },
    },
    "/projects/{id}": { delete: { summary: "Delete a project" } },
  },
};

test("an API description gives the address, how the key goes, and every endpoint", () => {
  const read = keys.readApiDescription(KESTREL, "https://api.kestrel-voice.example");
  assert.equal(read.base, "https://api.kestrel-voice.example/v2");
  assert.deepEqual(read.auth, { in: "header", name: "X-Kestrel-Key" });
  assert.equal(read.endpoints.length, 4);
  const speak = read.endpoints.find((e) => e.path === "/speech/{voice_id}");
  assert.deepEqual(speak.params.map((p) => [p.name, p.in, p.required]), [["voice_id", "path", true]]);
  assert.deepEqual(speak.body.fields.map((f) => [f.name, f.required, f.type]), [["text", true, "string"], ["format", false, 'one of "mp3", "wav"']]);
  assert.equal(speak.returns, "audio/mpeg");
  assert.equal(keys.searchEndpoints(read.endpoints, "turn text into speech")[0].path, "/speech/{voice_id}");
  assert.equal(keys.readApiDescription(KESTREL, "https://api.someone-else.example"), null, "a description of an API somewhere else");
  assert.equal(keys.readApiDescription({ paths: {} }, "https://api.kestrel-voice.example"), null, "not a description");
  assert.equal(keys.readApiDescription({ ...KESTREL, servers: [{ url: "/v3" }] }, "https://api.kestrel-voice.example/v2").base, "https://api.kestrel-voice.example/v3", "a server given as a path");
});

test("with no security section, a key header on most endpoints is how the key goes, and isn't listed as a parameter", () => {
  const keyParam = { name: "x-kestrel-key", in: "header", required: false, schema: { type: "string" } };
  const spec = { openapi: "3.0.0", paths: {
    "/v1/user": { get: { summary: "Get user", parameters: [keyParam] } },
    "/v1/tts": { post: { summary: "Text to speech", parameters: [keyParam, { name: "voice", in: "query", schema: { type: "string" } }] } },
  } };
  const read = keys.readApiDescription(spec, "https://api.kestrel-voice.example/v1");
  assert.equal(read.base, "https://api.kestrel-voice.example", "its paths start at the root, so the base does too");
  assert.deepEqual(read.auth, { in: "header", name: "x-kestrel-key" });
  assert.deepEqual(read.endpoints.find((e) => e.path === "/v1/tts").params.map((p) => p.name), ["voice"]);
});

test("an endpoint reads as a tool, and its arguments make the request", () => {
  const read = keys.readApiDescription({
    ...KESTREL,
    paths: {
      ...KESTREL.paths,
      "/listen": { post: { summary: "Speech to text", requestBody: { content: { "multipart/form-data": { schema: { type: "object", required: ["model"], properties: { audio: { type: "string", format: "binary" }, model: { type: "string", examples: ["kv-listen-1"] } } } } } } } },
    },
  }, "https://api.kestrel-voice.example");
  const speak = read.endpoints.find((e) => e.path === "/speech/{voice_id}");
  const tool = keys.endpointTool(speak);
  assert.equal(tool.name, "POST /speech/{voice_id}");
  assert.deepEqual(tool.inputSchema.required, ["voice_id", "text"]);
  assert.deepEqual(tool.inputSchema.properties.format.enum, ["mp3", "wav"]);
  const listen = keys.endpointTool(read.endpoints.find((e) => e.path === "/listen"));
  assert.equal(listen.inputSchema.properties.audio.format, "binary");
  assert.deepEqual(listen.inputSchema.properties.model.examples, ["kv-listen-1"]);

  const req = keys.requestFor(speak, read.base, { voice_id: "kv 7", text: "Hello", format: "wav" });
  assert.equal(req.url, "https://api.kestrel-voice.example/v2/speech/kv%207");
  assert.equal(req.body, '{"text":"Hello","format":"wav"}');
  assert.throws(() => keys.requestFor(speak, read.base, { text: "Hello" }), /needs voice_id/);
  const form = keys.requestFor(read.endpoints.find((e) => e.path === "/listen"), read.base, { audio: Buffer.from("OggS"), model: "kv-listen-1", _fileExt: "ogg" });
  assert.ok(form.body instanceof FormData);
  assert.deepEqual([...form.body.keys()], ["audio", "model"]);
  assert.equal(form.headers["Content-Type"], undefined, "a form sets its own type");
});
