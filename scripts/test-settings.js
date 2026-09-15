const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { modelSummary } = require("../webapp/model-summary");
const policy = require("../webapp/model-policy");
const html = fs.readFileSync(require.resolve("../webapp/views/dashboard.html"), "utf8");
const block = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
function notifications() {
  const container = {
    innerHTML: "", buttons: [],
    querySelectorAll() {
      this.buttons = [...this.innerHTML.matchAll(/data-platform="([^"]+)"/g)].map(match => ({
        dataset: { platform: match[1] }, addEventListener(_, fn) { this.click = fn; },
      }));
      return this.buttons;
    },
  };
  const state = vm.createContext({
    window: {}, console: { error() {} },
    document: { getElementById: id => id === "platform-pills" ? container : null },
    renderPulseLevel() {}, renderQuietHours() {}, loadAllowedHosts() {}, showToast() {},
    escHtml: s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
  });
  vm.runInContext('let pulseState = {deliveryPlatforms: []}; let _pulseLoaded=false; let _pulseError=false; let _platformsLoadError=false; let _pulseSaving=false;\n' +
    block("    function escAttribute(", "    // --- MCP Connections") +
    block("    async function loadPulse()", "    async function saveConfirmSends") +
    block("    function renderPlatformPills(", "    function renderQuietHours") +
    block("    async function savePulse()", "    // --- Schedules"), state);
  return { state, container };
}
const linked = { whatsapp: { connected: true, linkedDevice: true, name: "WhatsApp" } };
for (const first of ["status", "preferences"]) test("notification controls render when " + first + " loads first", async () => {
  const { state, container } = notifications();
  state.fetch = async () => ({ ok: true, json: async () => ({ deliveryPlatforms: ["whatsapp_linked"] }) });
  if (first === "status") { state.window._platformsCache = linked; state.renderPlatformPills(linked); }
  await state.loadPulse();
  if (first === "preferences") { state.window._platformsCache = linked; state.renderPlatformPills(linked); }
  assert.match(container.innerHTML, /aria-pressed="true" data-platform="whatsapp_linked"/);
  assert.doesNotMatch(container.innerHTML, /24 hours|Loading/);
});
test("linked WhatsApp saves its delivery identity and rolls back a failed save", async () => {
  const { state, container } = notifications();
  state.window._platformsCache = linked;
  state.fetch = async () => ({ ok: true, json: async () => ({ deliveryPlatforms: [] }) });
  await state.loadPulse();
  let sent;
  state.fetch = async (_, options) => { sent = JSON.parse(options.body); return { ok: true }; };
  await container.buttons[0].click();
  assert.deepEqual(sent.deliveryPlatforms, ["whatsapp_linked"]);
  assert.match(container.innerHTML, /aria-pressed="true"/);
  state.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "Try again" }) });
  await container.buttons[0].click();
  assert.match(container.innerHTML, /aria-pressed="true"/);
});
test("failed settings requests are visible and retry recovers", async () => {
  const { state, container } = notifications();
  state.fetch = async () => ({ ok: false });
  await state.loadPulse();
  assert.match(container.innerHTML, /Could not load.*Try again/);
  state.window._platformsCache = {};
  state.fetch = async () => ({ ok: true, json: async () => ({ deliveryPlatforms: [] }) });
  await state.loadPulse();
  assert.match(container.innerHTML, /Connect a chat app/);
  assert.doesNotMatch(container.innerHTML, /Could not load/);
});
test("the Business WhatsApp limit is shown only for that connection", async () => {
  const { state, container } = notifications();
  state.fetch = async () => ({ ok: true, json: async () => ({ deliveryPlatforms: ["whatsapp"] }) });
  state.window._platformsCache = { whatsapp: { connected: true, name: "WhatsApp" } };
  await state.loadPulse();
  assert.match(container.innerHTML, /24 hours/);
  state.renderPlatformPills(linked);
  assert.doesNotMatch(container.innerHTML, /24 hours/);
});
test("effective model descriptions name selected models and redact credentials", () => {
  const conn = policy.connection({ provider: "deepinfra", apiKey: "PRIVATE-KEY" });
  const settings = { model_config: { connections: { primary: conn }, roles: {
    chat: { connection: "primary", model: "main" }, background: { connection: "primary", model: "small" }, vision: null,
  } } };
  const rows = modelSummary(settings, k => ({ EMBED_MODEL: "local:recall", RERANK_MODEL: "local:ranking" })[k], true);
  assert.equal(rows[0].model, "main");
  assert.equal(rows[1].model, "small");
  assert.equal(rows[0].provider, "DeepInfra");
  assert.equal(rows[2].model, "Not enabled");
  assert.equal(rows[3].provider, "On your computer");
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|apiKey/);
});
test("legacy models reflect active runtime choices without pretending defaults are configured", () => {
  const values = { DEEPINFRA_API_KEY: "SECRET", VISION_MODEL: "image-v2", EMBED_MODEL: "embed-v3" };
  const rows = modelSummary({ llm_provider: "custom", custom_model: "grok-4.5", custom_base_url: "https://api.x.ai/v1" }, k => values[k], true);
  assert.equal(rows[0].provider, "xAI");
  assert.equal(rows[1].model, "deepseek-ai/DeepSeek-V4-Flash");
  assert.equal(rows[2].model, "image-v2");
  assert.equal(rows[3].model, "embed-v3");
  const empty = modelSummary({}, () => undefined);
  assert.ok(empty.every(row => row.model === "Not enabled"));
  const missingKey = modelSummary({ llm_provider: "anthropic" }, k => k === "XAI_API_KEY" ? "SECRET" : undefined);
  assert.equal(missingKey[0].model, "grok-4.5");
});
test("unknown provider summaries do not disclose URL credentials, paths or query strings", () => {
  const rows = modelSummary({ llm_provider: "custom", custom_model: "model", custom_base_url: "https://user:SECRET@private.example/SECRET?key=SECRET" }, () => undefined);
  assert.equal(rows[0].provider, "private.example");
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});
test("preference origins distinguish chat, Settings and unknown sources", () => {
  const state = vm.createContext({});
  vm.runInContext(block("    function ruleOrigin(", "    async function loadUserRules"), state);
  assert.match(state.ruleOrigin({ source: "assistant", created_at: "2026-09-10" }), /Saved by ClosedHand.*2026/);
  assert.equal(state.ruleOrigin({ source: "user" }), "Added in Settings");
  assert.equal(state.ruleOrigin({ source: null }), "Source not recorded");
});
test("preference labels escape quotes before entering HTML attributes", async () => {
  const container = { innerHTML: "" };
  const state = vm.createContext({
    document: { getElementById: () => container },
    fetch: async () => ({ ok: true, json: async () => [{ id: "safe-id", active: true, source: "assistant", rule: 'A "quoted" preference <img src=x onerror=alert(1)>' }] }),
    escHtml: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  });
  vm.runInContext(block("    function escAttribute(", "    // --- MCP Connections") +
    block("    function ruleOrigin(", "    window.toggleRule"), state);
  await state.loadUserRules();
  assert.match(container.innerHTML, /aria-label="Enable preference: A &quot;quoted&quot;/);
  assert.doesNotMatch(container.innerHTML, /<img/);
});

test("the actual notification save route retains linked WhatsApp and rejects unknown platform names", async () => {
  const source = fs.readFileSync(require.resolve("../webapp/server.js"), "utf8");
  const start = source.indexOf('app.put("/api/pulse"');
  const route = source.slice(start, source.indexOf("\n});", start) + 4);
  let handler, stored = { pulse_settings: { deliveryPlatforms: ["telegram"] }, unrelated: "keep" };
  const state = vm.createContext({
    app: { put(_, fn) { handler = fn; } },
    getUserIdFromRequest: () => "test-owner",
    console: { log() {}, error() {} },
    supabase: { from(table) {
      return {
        select() { return this; },
        eq(_, id) { assert.equal(id, "test-owner"); return this; },
        async single() { return { data: { settings: stored } }; },
        update(values) { assert.equal(table, "profiles"); stored = values.settings; return this; },
        async upsert() { assert.equal(table, "pulse_config"); return {}; },
        then(resolve) { resolve({ error: null }); },
      };
    } },
  });
  vm.runInContext(source.match(/const SUPPORTED_PLATFORMS = \{[\s\S]*?\n\};/)[0] + "\n" + route, state);
  const response = { status(code) { throw new Error("Unexpected HTTP " + code); }, json(body) { assert.equal(body.success, true); } };
  await handler({ body: { proactiveLevel: "medium", deliveryPlatforms: ["whatsapp_linked", "unknown"] } }, response);
  assert.deepEqual(Array.from(stored.pulse_settings.deliveryPlatforms), ["whatsapp_linked"]);
  assert.equal(stored.unrelated, "keep");
  await handler({ body: { proactiveLevel: "medium", quietStart: 21 } }, response);
  assert.deepEqual(Array.from(stored.pulse_settings.deliveryPlatforms), ["whatsapp_linked"]);
  await handler({ body: { proactiveLevel: "medium", deliveryPlatforms: [] } }, response);
  assert.deepEqual(Array.from(stored.pulse_settings.deliveryPlatforms), []);
});
