const { test, afterEach } = require("node:test");

test("dashboard settings never expose connection secrets", () => {
  const conn = policy.connection({ provider: "custom", baseUrl: "https://chosen.example/v1", apiKey: "NEW_SECRET" });
  const result = policy.publicSettings({ location: { name: "London" }, custom_api_key: "OLD_SECRET",
    self_host_config: { EMBED_API_KEY: "MEMORY_SECRET" },
    model_config: { connections: { primary: conn }, roles: { chat: { model: "chat", connection: "primary" } } } });
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(result.model_config.connections.primary.hasKey, true);
  assert.equal(result.location.name, "London");
});
test("parallel document jobs keep each user's selected provider", async () => {
  const calls = mockProvider();
  const dbPath = require.resolve("../lib/db");
  const prior = require.cache[dbPath];
  const make = id => ({ model_config: { connections: { primary: policy.connection({
    provider: "custom", baseUrl: "https://" + id + ".example/v1", apiKey: id + "-key",
  }) }, roles: { background: { connection: "primary", model: id + "-small" }, vision: null } } });
  require.cache[dbPath] = { exports: { supabase: { from: () => ({ select: () => ({ eq: (_, id) => ({
    single: async () => ({ data: { settings: make(id) } }),
  }) }) }) } } };
  try {
    const jobs = require("../lib/model-jobs");
    await Promise.all(["alice", "bob"].map(id => jobs.withSettings(id, async () => {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(jobs.role("background").model, id + "-small");
      await jobs.complete("background", "Summarise", "Synthetic example", 100, 2000);
      assert.equal(await jobs.complete("vision", "Describe", "Synthetic example", 100, 2000), null);
    })));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const id = new URL(call.url).hostname.split(".")[0];
      assert.equal(call.headers.Authorization, "Bearer " + id + "-key");
      assert.equal(call.body.model, id + "-small");
    }
  } finally { if (prior) require.cache[dbPath] = prior; else delete require.cache[dbPath]; }
});
test("Gemini bills thinking tokens and context estimates include hidden provider state", () => {
  const response = wire.convertResponseFromGemini({ candidates: [{ content: { parts: [{ text: "ready" }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 25 } });
  assert.equal(response.usage.output_tokens, 30);
  const tracker = require("../lib/token-tracker");
  assert.equal(tracker.estimateContextTokens([], "", [], { contextWindow: 32768 }).window, 32768);
  const ordinary = { role: "assistant", content: [{ type: "text", text: "ready" }] };
  const withState = { role: "assistant", content: [...ordinary.content, { type: "provider_state", value: { reasoning_content: "x".repeat(2000) } }] };
  assert.ok(tracker.estimateMessageTokens(withState) > tracker.estimateMessageTokens(ordinary) + 200);
});
test("an incomplete configured chat cannot fall through to a platform provider", () => {
  assert.throws(() => llm.getUserLLMClient("u", { profile: { settings: { model_config: { roles: {}, connections: {} } } } }), /Choose a chat model/);
});

test("Anthropic thinking signatures stay bound to their original model", async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Response.json({ content: [{ type: "thinking", thinking: "private", signature: "signed" }, { type: "text", text: "ready" }] });
  };
  const conn = policy.connection({ provider: "anthropic", apiKey: "key" });
  const result = await wire.request(conn, { ...params, model: "claude-sonnet-4-6" });
  const messages = [{ role: "assistant", content: result.content }];
  await wire.request(conn, { ...params, model: "claude-sonnet-4-6", messages });
  assert.equal(calls[1].messages[0].content[0].signature, "signed");
  assert.equal(calls[1].messages[0].content[0]._identity, undefined);
  await wire.request(conn, { ...params, model: "claude-opus-4-6", messages });
  assert.equal(calls[2].messages[0].content.some(b => b.type === "thinking"), false);
  assert.equal(wire.responseText(result), "ready");
});
const assert = require("node:assert/strict");
const wire = require("../lib/model-wire");
const policy = require("../lib/model-policy");
const llm = require("../lib/llm");
const config = require("../webapp/model-config");
const originalFetch = global.fetch;

test("a text-only chat receives tool screenshots through its chosen image model, once per image", async () => {
  const calls = mockProvider();
  const prepared = await config.prepare({ primary: { provider: "custom", baseUrl: "https://screen-chat.example/v1", apiKey: "chat-key" },
    model: "chat", visionMode: "separate", visionModel: "image",
    vision: { provider: "custom", baseUrl: "https://screen-vision.example/v1", apiKey: "vision-key" } }, {});
  const { client, model } = llm.getUserLLMClient("u", { userId: "screenshots-user", profile: { settings: config.withConfig({}, prepared) } });
  calls.length = 0;
  const messages = [{ role: "assistant", content: [{ type: "tool_use", id: "screen", name: "screenshot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "screen", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "synthetic-image" } }] }] }];
  await client.messages.create({ ...params, model, messages });
  await client.messages.create({ ...params, model, messages });
  assert.equal(calls.filter(c => c.url.includes("screen-vision")).length, 1);
  const chats = calls.filter(c => c.url.includes("screen-chat"));
  assert.equal(chats.length, 2);
  for (const call of chats) {
    assert.ok(!JSON.stringify(call.body).includes("image_url"));
    assert.ok(JSON.stringify(call.body).includes("Description from the selected image model"));
  }
  assert.equal(messages[1].content[0].content[0].type, "image");
});

afterEach(() => { global.fetch = originalFetch; });
function mockProvider(options = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), headers: opts.headers, body });
    if (!body) return Response.json({ data: options.models || [
      { id: "chat", architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"], context_length: 32768 },
      { id: "image", architecture: { input_modalities: ["text", "image"] } }, { id: "small" },
    ] });
    if (options.reject === body.model) return new Response("", { status: 404 });
    const isImage = body.messages?.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image_url"));
    const toolResult = body.messages?.some(m => m.role === "tool");
    const message = body.tools?.length && !toolResult
      ? { role: "assistant", content: null, reasoning_content: "opaque provider reasoning", tool_calls: [{ id: "call_1", type: "function", function: { name: "capability_check", arguments: '{"value":4}' } }] }
      : { role: "assistant", content: isImage ? "red" : "ready" };
    return Response.json({ choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  };
  return calls;
}
const params = { model: "chat", max_tokens: 4096, messages: [{ role: "user", content: "hello" }] };

test("image model lists reuse only the saved image provider credential", async () => {
  const calls = mockProvider();
  const settings = { model_config: { connections: {
    primary: policy.connection({ provider: "custom", baseUrl: "https://chat.example/v1", apiKey: "chat-key" }),
    vision: policy.connection({ provider: "custom", baseUrl: "https://images.example/v1", apiKey: "image-key" }),
  }, roles: {} } };
  const routes = {};
  config.install({ get() {}, post: (path, handler) => routes[path] = handler }, {
    authorize: async () => "u",
    supabase: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { settings } }) }) }) }) },
  });
  const invoke = async baseUrl => {
    const res = { code: 200, status(n) { this.code = n; return this; }, json(data) { this.data = data; return this; } };
    await routes["/api/model-config/models"]({ body: { connection: "vision", vision: {
      provider: "custom", baseUrl, useSavedKey: true,
    } } }, res);
    return res;
  };
  const result = await invoke("https://images.example/v1");
  assert.equal(result.code, 200);
  assert.equal(result.data.models[1].id, "image");
  assert.equal(calls[0].headers.Authorization, "Bearer image-key");
  assert.equal((await invoke("https://other.example/v1")).code, 400);
  assert.equal(calls.length, 1);
});

for (const [provider, model, expected] of [
  ["deepseek", "deepseek-flash", { thinking: { type: "enabled" }, reasoning_effort: "max" }],
  ["deepinfra", "deepseek-ai/DeepSeek-V4.1-Flash", { reasoning_effort: "high" }],
  ["xai", "grok-4.5", { reasoning_effort: "high" }],
  ["openai", "gpt-5", { reasoning_effort: "high" }],
]) test(provider + " translates strong effort on the actual request", async () => {
  const calls = mockProvider();
  await wire.request(policy.connection({ provider, apiKey: "key" }), { ...params, model, effort: "strong" });
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(calls[0].body[key], value);
  assert.equal(calls[0].body.model, model);
});
test("quick work disables DeepSeek thinking but leaves unknown hosts unchanged", async () => {
  const calls = mockProvider();
  await wire.request(policy.connection({ provider: "deepseek", apiKey: "key" }), { ...params, model: "deepseek-flash", effort: "fast" });
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  await wire.request(policy.connection({ provider: "custom", baseUrl: "https://unknown.example/v1" }), { ...params, model: "deepseek-flash", effort: "strong" });
  assert.equal(calls[1].body.thinking, undefined);
  assert.equal(calls[1].body.reasoning_effort, undefined);
});
test("OpenRouter uses advertised parameters and keeps real model suffixes", async () => {
  const calls = mockProvider();
  const conn = policy.connection({ provider: "openrouter", apiKey: "key" });
  conn.capabilities = policy.capabilities(conn, "test:free", { supported_parameters: ["reasoning", "tools"], architecture: { input_modalities: ["text", "image"] } });
  await wire.request(conn, { ...params, model: "test:free", effort: "strong" });
  assert.equal(calls[0].body.model, "test:free");
  assert.deepEqual(calls[0].body.reasoning, { effort: "high" });
  assert.deepEqual(calls[0].body.provider, { require_parameters: true });
});
test("reasoning survives a tool round trip only on its original model, host and credential", async () => {
  const calls = mockProvider();
  const conn = policy.connection({ provider: "deepseek", apiKey: "first" });
  const result = await wire.request(conn, { ...params, tools: [{ name: "capability_check" }] });
  const continuation = { ...params, messages: [{ role: "assistant", content: result.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "4" }] }] };
  await wire.request(conn, continuation);
  assert.equal(calls[1].body.messages[0].reasoning_content, "opaque provider reasoning");
  await wire.request({ ...conn, apiKey: "second" }, continuation);
  assert.equal(calls[2].body.messages[0].reasoning_content, undefined);
  assert.ok(!result.content.some(b => b.type === "text" && b.text?.includes("opaque")));
});
test("Gemini thought signatures survive without becoming visible answers", async () => {
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push(JSON.parse(opts.body));
    return Response.json({ candidates: [{ content: { parts: [
      { thought: true, text: "private", thoughtSignature: "signed-thought" },
      { functionCall: { name: "lookup", args: {} }, thoughtSignature: "signed-tool" },
    ] } }], usageMetadata: {} });
  };
  const conn = policy.connection({ provider: "gemini", apiKey: "key" });
  const result = await wire.request(conn, { ...params, model: "gemini-3-pro-preview", effort: "strong" });
  assert.equal(seen[0].generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(result.content.some(b => b.type === "text"), false);
  await wire.request(conn, { ...params, model: "gemini-3-pro-preview", messages: [{ role: "assistant", content: result.content }] });
  assert.equal(seen[1].contents[0].parts[1].thoughtSignature, "signed-tool");
});
test("Anthropic adaptive and budget models use their own controls", async () => {
  const calls = mockProvider();
  const conn = policy.connection({ provider: "anthropic", apiKey: "key" });
  await wire.request(conn, { ...params, model: "claude-sonnet-4-6", effort: "strong" });
  assert.deepEqual(calls[0].body.thinking, { type: "adaptive" });
  assert.deepEqual(calls[0].body.output_config, { effort: "high" });
  await wire.request(conn, { ...params, model: "claude-sonnet-4-5", effort: "strong" });
  assert.equal(calls[1].body.thinking.budget_tokens, 4095);
});
test("native selected IDs are not overwritten by legacy defaults", async () => {
  const calls = mockProvider();
  await llm.createLLMClient({ backend: "openai", apiKey: "key" }).messages.create({ ...params, model: "gpt-5.2" });
  assert.equal(calls[0].body.model, "gpt-5.2");
  await llm.createLLMClient({ backend: "xai", apiKey: "key" }).messages.create({ ...params, model: "grok-4.5:low" });
  assert.equal(calls[1].body.model, "grok-4.5");
  assert.equal(calls[1].body.reasoning_effort, "low");
});
test("image-less setup requires an explicit choice and does not change stored settings", async () => {
  mockProvider();
  const settings = { custom_api_key: "old", self_host_config: { EMBED_MODEL: "locked" } };
  const before = JSON.stringify(settings);
  await assert.rejects(config.prepare({ primary: { provider: "custom", baseUrl: "https://chosen.example/v1", apiKey: "new" }, model: "chat" }, settings), /does not accept images/);
  assert.equal(JSON.stringify(settings), before);
});
test("one model can serve all roles after a real image check, even when catalog metadata is absent", async () => {
  mockProvider({ models: [{ id: "chat" }] });
  const prepared = await config.prepare({ primary: { provider: "custom", baseUrl: "https://chosen.example/v1", apiKey: "key" }, model: "chat", visionMode: "same" }, {});
  assert.equal(prepared.roles.chat.capabilities.vision, true);
  assert.equal(prepared.roles.vision.model, "chat");
});
test("separate image provider gets only its own key; old keys cannot survive the switch", async () => {
  const calls = mockProvider();
  const prepared = await config.prepare({ primary: { provider: "custom", baseUrl: "https://new.example/v1", apiKey: "new-key" },
    model: "chat", backgroundModel: "small", visionMode: "separate", visionModel: "image",
    vision: { provider: "custom", baseUrl: "https://images.example/v1", apiKey: "image-key" } }, {});
  for (const call of calls) assert.equal(call.headers.Authorization, call.url.includes("images.example") ? "Bearer image-key" : "Bearer new-key");
  const settings = config.withConfig({ openai_api_key: "old-key", custom_model_fast: "old-fast", self_host_config: { EMBED_MODEL: "locked" } }, prepared);
  assert.equal(settings.openai_api_key, undefined);
  assert.equal(settings.custom_model_fast, undefined);
  assert.equal(settings.self_host_config.EMBED_MODEL, "locked");
  assert.equal(policy.publicConfig(prepared).connections.primary.apiKey, undefined);
  assert.equal(policy.getRole(settings, "background").model, "small");
  assert.equal(policy.getRole(settings, "vision").apiKey, "image-key");
});
test("invalid summaries model rejects the whole proposal", async () => {
  mockProvider({ reject: "missing" });
  await assert.rejects(config.prepare({ primary: { provider: "custom", baseUrl: "https://new.example/v1" }, model: "chat", backgroundModel: "missing", visionMode: "off" }, {}), /HTTP 404/);
});
test("new user clients and internal work never fall through to old environment credentials", async () => {
  const calls = mockProvider();
  const prepared = await config.prepare({ primary: { provider: "custom", baseUrl: "https://new.example/v1", apiKey: "new-key" }, model: "chat", backgroundModel: "small", visionMode: "off" }, {});
  const store = { profile: { settings: config.withConfig({}, prepared) } };
  calls.length = 0;
  const internal = llm.getInternalClient("u1", store);
  await internal.client.messages.create({ ...params, model: internal.model });
  assert.equal(calls[0].url, "https://new.example/v1/chat/completions");
  assert.equal(calls[0].body.model, "small");
  assert.equal(llm.getConfiguredRole("vision", store), null);
  assert.equal(llm.chatModelSupportsVision(store), false);
});
test("provider errors keep status and context classification without leaking request bodies", async () => {
  global.fetch = async () => new Response(JSON.stringify({ error: { message: "SECRET credential in provider error" } }), { status: 401 });
  await assert.rejects(wire.request(policy.connection({ provider: "openai", apiKey: "SECRET" }), params), error => /401/.test(error.message) && !error.message.includes("SECRET"));
});
test("catalog lookup preserves context for real Ollama tags", async () => {
  mockProvider({ models: [{ id: "qwen:32b", context_length: 65536 }] });
  const client = llm.createLLMClient({ backend: "custom", baseUrl: "http://localhost:11434/v1", model: "qwen:32b" });
  assert.deepEqual(await client.getModelLimits("qwen:32b"), { contextWindow: 65536 });
});
test("a save receipt belongs to one user and preserves unrelated settings", async () => {
  mockProvider();
  let settings = { marker: "preserve", self_host_config: { EMBED_MODEL: "locked" } };
  const routes = {};
  const app = { get: (p, fn) => routes["GET " + p] = fn, post: (p, fn) => routes["POST " + p] = fn };
  const db = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { settings } }) }) }),
    update: values => ({ eq: async () => { settings = values.settings; return { error: null }; } }) }) };
  config.install(app, { supabase: db, authorize: async req => req.user, allowDefault: true,
    ensureMemory: async () => { settings.self_host_config.INITIALIZED = true; } });
  async function invoke(path, user, body) {
    const res = { code: 200, status(n) { this.code = n; return this; }, set() { return this; }, json(data) { this.data = data; return this; } };
    await routes["POST /api/model-config/" + path]({ user, body }, res); return res;
  }
  const checked = await invoke("check", "u1", { primary: { provider: "custom", baseUrl: "https://new.example/v1", apiKey: "key" }, model: "chat", visionMode: "off" });
  assert.equal(settings.model_config, undefined);
  const wrong = await invoke("save", "u2", { ticket: checked.data.ticket });
  assert.equal(wrong.code, 400);
  const saved = await invoke("save", "u1", { ticket: checked.data.ticket });
  assert.equal(saved.code, 200);
  assert.equal(settings.marker, "preserve");
  assert.equal(settings.self_host_config.EMBED_MODEL, "locked");
  assert.equal(settings.self_host_config.INITIALIZED, true);
  const replay = await invoke("save", "u1", { ticket: checked.data.ticket });
  assert.equal(replay.code, 400);
  assert.equal((await invoke("default", "u1", {})).code, 200);
  assert.equal(settings.model_config, undefined);
  assert.equal(settings.custom_api_key, undefined);
  assert.equal(settings.self_host_config.EMBED_MODEL, "locked");
  config.install(app, { supabase: db, authorize: async req => req.user });
  assert.equal((await invoke("default", "u1", {})).code, 400);
});
