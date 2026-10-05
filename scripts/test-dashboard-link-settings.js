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
test("the dashboard status route authenticates before reading only public address details", async () => {
  let handler, allowed = false, reads = 0, output;
  const state = vm.createContext({
    app: { get: (_, fn) => { handler = fn; } },
    requireSetupAccess: async () => allowed,
    getRuntimeConf: async key => { reads++; assert.ok(["PHONE_PERMANENT_URL", "PHONE_ADDRESS_NAME"].includes(key)); return key === "PHONE_ADDRESS_NAME" ? "example" : address; },
    require: name => { assert.equal(name, "./phone-registration"); return { validAddress: url => url === address, serviceAvailable: async () => false }; },
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
  assert.equal(output.addressName, "example");
  assert.equal(reads, 2);
  assert.equal(output.enabled, false);
  assert.equal(output.serviceAvailable, false, "setup learns whether closedhand.com can give one out");
  state.getRuntimeConf = async () => "https://untrusted.example";
  await handler({}, response);
  assert.equal(output.savedUrl, null);
});
test("Settings offers a picked personal URL, and renames a lasting one with a tidied preview", async () => {
  const { state, el } = page();
  state.renderPhone({ enabled: false, state: "off" });
  assert.equal(el("phone-start").textContent, "Get your personal URL");
  assert.equal(el("phone-change-line").hidden, true, "nothing to rename yet");
  assert.doesNotMatch(html, /id="phone-address-name"/, "no name to choose");
  const sent = [];
  state.fetch = async (url, options) => { sent.push([url, options && JSON.parse(options.body)]); return { ok: true, json: async () => ({ enabled: true, state: "pairing", pairingUrl: "https://closedhand.com/phone-access/pair#t" }) }; };
  await state.startDashboardLink();
  assert.deepEqual(sent[0], ["/api/phone", { enabled: true, mode: "managed" }]);
  state.renderPhone(ready);
  assert.equal(el("phone-change-line").hidden, false);
  el("phone-rename").hidden = true;
  state.toggleDashboardRename({ preventDefault() {} });
  assert.equal(el("phone-rename").hidden, false);
  el("phone-new-name").value = "  Lucy Smith! ";
  state.previewDashboardRename();
  assert.equal(el("phone-new-preview").textContent, "lucy-smith.closedhand.ai");
  sent.length = 0;
  state.fetch = async (url, options) => { sent.push([url, options && options.body && JSON.parse(options.body)]); return url === "/api/phone/rename" ? { ok: true, json: async () => ({ renamedTo: "https://lucy-smith.closedhand.ai", ...ready }) } : { ok: true, json: async () => ready }; };
  await state.renameDashboardLink();
  assert.deepEqual(sent[0], ["/api/phone/rename", { name: "  Lucy Smith! " }]);
  assert.match(el("phone-desc").textContent, /now at lucy-smith\.closedhand\.ai/);
  assert.equal(el("phone-rename").hidden, true);
  state.renderPhone({ enabled: true, state: "on", url: "https://test.trycloudflare.com" });
  assert.equal(el("phone-change-line").hidden, true, "a temporary address cannot be renamed");
  // A refusal stays readable.
  state.fetch = async () => ({ ok: false, json: async () => ({ error: "That name is taken. Try another." }) });
  el("phone-rename").hidden = false;
  await state.renameDashboardLink();
  assert.equal(el("phone-rename-status").textContent, "That name is taken. Try another.");
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
test("the dashboard offers a personal URL to a ClosedHand without one, and nothing more", async () => {
  const code = region(html, "    async function loadPersonalUrlPrompt()", "    async function loadScopeWarnings()");
  const els = {}, calls = [];
  const el = id => els[id] ||= { hidden: true, scrollIntoView() {} };
  let reply;
  const state = vm.createContext({
    document: { getElementById: el }, fetch: async () => ({ ok: true, json: async () => reply }),
    switchTab: tab => calls.push("tab:" + tab), startDashboardLink: () => calls.push("start"),
  });
  vm.runInContext(code, state);
  for (const [phone, shown, why] of [
    [{ enabled: false, state: "off" }, true, "skipped in setup"],
    [{ enabled: true, state: "on", url: "https://x.trycloudflare.com", permanent: false }, true, "only a temporary link"],
    [{ enabled: false, state: "off", savedUrl: address }, false, "has one, paused"],
    [ready, false, "has one"],
    [{ enabled: true, permanent: true, state: "pairing", pairingUrl: "https://closedhand.com/phone-access/pair#t" }, false, "on its way"],
    [{ enabled: false, state: "unavailable" }, false, "this version can't"],
  ]) {
    reply = phone; await state.loadPersonalUrlPrompt();
    assert.equal(el("personal-url-notice").hidden, !shown, why);
  }
  assert.doesNotMatch(html, /personal-url-notice-done|Not now/, "no dismiss: it goes once there is one");
  state.getPersonalUrlFromPrompt();
  assert.deepEqual(calls, ["tab:settings", "start"]);
  assert.equal(el("personal-url-notice").hidden, true);
  assert.doesNotMatch(source, /PHONE_ADDRESS_NOTICE|api\/phone\/notice/, "no start-up offer for existing installs");
});

// Settings > Account: the ClosedHand account, and Delete account.
function accountPage(respond) {
  const elements = {};
  const el = id => elements[id] ||= { id, hidden: true, disabled: false, textContent: "", dataset: {}, classList: { add() {}, remove() {} },
    append(...parts) { this.textContent += parts.map(p => typeof p === "string" ? p : p.textContent).join(""); } };
  const calls = [];
  const state = vm.createContext({
    URL, window: { location: {} },
    document: { getElementById: el, createElement: () => ({ textContent: "" }), querySelector: () => null },
    fetch: async (url, options = {}) => { calls.push([options.method || "GET", url]); const r = respond(url, options); return { ok: !r.status || r.status < 400, json: async () => r.body }; },
    showToast: message => calls.push(["toast", message]),
  });
  vm.runInContext(region(html, "    function cancelAccountAction(action)", "    function switchTab(tabName)"), state);
  return { state, el, calls };
}
test("Settings > Account says what the ClosedHand account holds, and Delete account says exactly what goes", async () => {
  const withAccount = accountPage(() => ({ body: { account: { provider: "google", email: "a@example.com", url: "https://amber-fox-42.closedhand.ai" } } }));
  await withAccount.state.loadAccountSummary();
  assert.equal(withAccount.el("account-summary").hidden, false);
  assert.equal(withAccount.el("account-summary-text").textContent,
    "Your ClosedHand account is Google: a@example.com. closedhand.com keeps only its email, linked to your personal URL, amber-fox-42.closedhand.ai. Everything else here is on your own computer.");
  assert.match(withAccount.el("delete-account-text").textContent, /^This deletes your ClosedHand account: amber-fox-42\.closedhand\.ai stops working and closedhand\.com forgets your sign-in\. It also permanently deletes everything ClosedHand keeps for you on your own computer/);
  const without = accountPage(() => ({ body: { account: null } }));
  await without.state.loadAccountSummary();
  assert.match(without.el("account-summary-text").textContent, /^You don’t have a ClosedHand account\. Getting a personal URL makes one/);
  assert.match(without.el("delete-account-text").textContent, /^This permanently deletes everything ClosedHand keeps for you on your own computer/);
  const offline = accountPage(() => ({ body: { account: null, unreachable: true } }));
  await offline.state.loadAccountSummary();
  assert.equal(offline.el("account-summary").hidden, true, "nothing claimed when closedhand.com can't say");
});
test("Delete account stops when closedhand.com can't be reached, and deletes anyway only when asked", async () => {
  const page = accountPage((url) => url.includes("anyway=1") ? { body: { success: true, redirect: "/" } }
    : { status: 502, body: { accountUnreachable: true, error: "closedhand.com couldn’t be reached, so nothing was deleted." } });
  await page.state.executeAccountAction("delete-account");
  assert.deepEqual(page.calls, [["DELETE", "/api/account"]]);
  assert.equal(page.el("delete-account-offline").hidden, false);
  assert.match(page.el("delete-account-offline").textContent, /nothing was deleted/);
  assert.equal(page.el("go-delete-anyway").hidden, false);
  assert.equal(page.state.window.location.href, undefined, "still here");
  await page.state.executeAccountAction("delete-account", true);
  assert.deepEqual(page.calls.at(-1), ["DELETE", "/api/account?anyway=1"]);
  assert.equal(page.state.window.location.href, "/");
  // The route deletes the ClosedHand account before anything on this computer.
  const route = region(source, 'app.delete("/api/account"', "// SUPABASE HELPERS");
  assert.ok(route.indexOf("deleteAccount()") > 0 && route.indexOf("deleteAccount()") < route.indexOf("WIPE_TABLES"));
  assert.match(route, /req\.query\.anyway !== "1"/);
  assert.ok(route.indexOf("phoneAccess.disable()") < route.indexOf("WIPE_TABLES"), "the personal URL connection stops too");
});
