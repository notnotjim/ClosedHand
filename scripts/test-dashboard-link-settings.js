const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const html = fs.readFileSync(require.resolve("../webapp/views/dashboard.html"), "utf8");
const source = fs.readFileSync(require.resolve("../webapp/server"), "utf8");
const region = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const address = "https://example.closedhand.ai";
function page() {
  const elements = {};
  const el = id => elements[id] ||= { hidden: false, style: {}, textContent: "", focus() {} };
  let removed = false, selected = false, fallback = false;
  const state = vm.createContext({
    URL, navigator: { clipboard: { writeText: async text => { state.copied = text; } } },
    document: {
      getElementById: el,
      body: { appendChild() {} },
      createElement: () => ({ style: {}, select() { selected = true; }, remove() { removed = true; } }),
      execCommand: command => { assert.equal(command, "copy"); return fallback; },
    },
    escHtml: text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    clearTimeout() {}, setTimeout: () => { state.polls++; }, confirm: () => true,
    polls: 0,
  });
  vm.runInContext("var _phone, _phonePoll;\n" + region(html, "    async function loadPhoneAccess()", "    // === Usage tab"), state);
  return { state, el, fallback: value => { fallback = value; }, cleanup: () => ({ removed, selected }) };
}
const ready = { enabled: true, permanent: true, mode: "managed", state: "on", url: address, savedUrl: address };
test("a ready address is copyable without showing setup or expanded instructions", async () => {
  const { state, el } = page();
  state.renderPhone(ready);
  assert.equal(el("phone-live").hidden, false);
  assert.equal(el("phone-url").href, address + "/");
  assert.equal(el("phone-setup").hidden, true);
  assert.equal(el("phone-options").open, undefined);
  assert.equal(state.polls, 0);
  await state.copyDashboardLink();
  assert.equal(state.copied, address + "/");
  assert.equal(el("phone-copy").textContent, "Copied");
});
test("a paused or reconnecting permanent address stays copyable, without claiming it is ready", () => {
  for (const status of [{ enabled: false, state: "off" }, { enabled: true, state: "error" }]) {
    const { state, el } = page();
    state.renderPhone({ ...ready, ...status, url: null });
    assert.equal(el("phone-url").href, address + "/");
    assert.equal(el("phone-setup").hidden, true);
    assert.match(el("phone-desc").textContent, status.enabled ? /Reconnecting/ : /paused/);
    assert.equal(el("phone-qr-details").hidden, true);
    assert.equal(state.polls, status.enabled ? 1 : 0);
  }
});
test("first setup, pairing and temporary connections have distinct next steps", () => {
  const { state, el } = page();
  state.renderPhone({ enabled: false, state: "off" });
  assert.equal(el("phone-live").hidden, true);
  assert.equal(el("phone-setup").hidden, false);
  assert.equal(el("phone-options").hidden, true);
  state.renderPhone({ enabled: true, state: "pairing", permanent: true, pairingUrl: "https://closedhand.com/phone-access/pair#fixture" });
  assert.equal(el("phone-live").hidden, true);
  assert.equal(el("phone-setup-link").hidden, false);
  assert.equal(el("phone-setup-link").href, "https://closedhand.com/phone-access/pair#fixture");
  state.renderPhone({ enabled: true, state: "on", url: "https://test.trycloudflare.com" });
  assert.equal(el("phone-setup").hidden, false);
  assert.equal(el("phone-save").hidden, true);
  assert.match(el("phone-link-help").textContent, /temporary/);
});
test("an embedded-browser clipboard denial falls back to selection and cleans up", async () => {
  const p = page();
  p.state.renderPhone(ready);
  p.state.navigator.clipboard.writeText = async () => { throw Error("Denied"); };
  p.fallback(true);
  await p.state.copyDashboardLink();
  assert.equal(p.el("phone-copy").textContent, "Copied");
  assert.deepEqual(p.cleanup(), { removed: true, selected: true });
});
test("copy failure gives manual instructions instead of false success", async () => {
  const p = page();
  p.state.renderPhone(ready);
  p.state.navigator.clipboard = undefined;
  await p.state.copyDashboardLink();
  assert.equal(p.el("phone-copy").textContent, "Copy");
  assert.match(p.el("phone-copy-status").textContent, /Touch and hold/);
  assert.equal(p.cleanup().removed, true);
});
test("pausing and resuming preserve the address and managed mode; cancelled pause does nothing", async () => {
  const { state, el } = page();
  state.renderPhone(ready);
  let calls = 0;
  state.fetch = async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.mode, "managed");
    return { ok: true, json: async () => ({ ...body, state: body.enabled ? "starting" : "off", permanent: true }) };
  };
  state.confirm = () => false;
  await state.togglePhoneAccess();
  assert.equal(calls, 0);
  state.confirm = () => true;
  await state.togglePhoneAccess();
  assert.equal(calls, 1);
  assert.equal(el("phone-btn").textContent, "Resume link");
  assert.equal(el("phone-url").href, address + "/");
  await state.togglePhoneAccess();
  assert.equal(calls, 2);
  assert.match(el("phone-desc").textContent, /Reconnecting/);
});
test("failed requests stay visible and do not silently change the connection", async () => {
  const { state, el } = page();
  state.renderPhone(ready);
  state.fetch = async () => ({ ok: false, json: async () => ({ error: "Try again later" }) });
  await state.togglePhoneAccess();
  assert.equal(el("phone-btn").disabled, false);
  assert.equal(el("phone-btn").textContent, "Pause link");
  assert.equal(el("phone-desc").textContent, "Try again later");
  await state.loadPhoneAccess();
  assert.match(el("phone-desc").innerHTML, /Try again/);
});
test("the dashboard status route authenticates before reading only the saved public URL", async () => {
  let handler, allowed = false, reads = 0, output;
  const state = vm.createContext({
    app: { get: (_, fn) => { handler = fn; } },
    requireSetupAccess: async () => allowed,
    getRuntimeConf: async key => { reads++; assert.equal(key, "PHONE_PERMANENT_URL"); return address; },
    require: name => { assert.equal(name, "./phone-registration"); return { validAddress: url => url === address }; },
    phoneAccess: { status: () => ({ enabled: false, state: "off", url: null }) },
  });
  vm.runInContext(region(source, 'app.get("/api/phone",', 'app.post("/api/phone",'), state);
  const response = { set(name, value) { assert.equal(name, "Cache-Control"); assert.equal(value, "no-store"); return this; }, json(data) { output = data; } };
  await handler({}, response);
  assert.equal(reads, 0);
  assert.equal(output, undefined);
  allowed = true;
  await handler({}, response);
  assert.equal(output.savedUrl, address);
  assert.equal(output.enabled, false);
  state.getRuntimeConf = async () => "https://untrusted.example";
  await handler({}, response);
  assert.equal(output.savedUrl, null);
});
test("the optional dashboard QR encodes the same address as Copy while preserving the save-page QR", async () => {
  let handler, encoded;
  const state = vm.createContext({
    URL, app: { get: (_, fn) => { handler = fn; } },
    requireSetupAccess: async () => true,
    phoneAccess: { status: () => ({ url: address }) },
    require: name => name === "./config" ? { dashboardBase: async () => address }
      : { toString: async url => { encoded = url; return "<svg/>"; } },
  });
  vm.runInContext(region(source, 'app.get("/api/phone/qr.svg",', 'phoneAccess.boot();'), state);
  const response = { set() { return this; }, send() {} };
  await handler({ query: { destination: "dashboard" } }, response);
  assert.equal(encoded, address + "/");
  await handler({ query: { destination: "//untrusted.example" } }, response);
  assert.equal(encoded, address + "/keep");
});
