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
    "Signed in withGoogle \u00b7 a@example.comUsed forYour personal URL, amber-fox-42.closedhand.aiclosedhand.com storesYour email and nothing elseYour dataStays on your own computer", "labelled facts, not a sentence");
  assert.match(withAccount.el("delete-account-text").textContent, /^This deletes your ClosedHand account: amber-fox-42\.closedhand\.ai stops working and closedhand\.com forgets your sign-in\. It also permanently deletes everything ClosedHand keeps for you on your own computer/);
  const without = accountPage(() => ({ body: { account: null } }));
  await without.state.loadAccountSummary();
  assert.match(without.el("account-summary-text").textContent, /^Signed in withNothing yet\. Claiming a personal URL creates your ClosedHand account, which you sign in to with Google or Microsoft\./);
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

test("ClosedHand's two addresses are two matching cards side by side: its personal URL and its email address", () => {
  assert.match(html, /<section class="dashboard-link-section" id="addresses" aria-labelledby="addresses-heading">\n\s*<h2 id="addresses-heading">ClosedHand Addresses<\/h2>\n\s*<div class="address-parts">\n\s*<div class="address-card" id="phone-block" style="display:none;">\n\s*<div class="address-head"><svg[^\n]*<h3 class="address-title" id="phone-heading">Personal URL<\/h3><\/div>/);
  assert.match(html, /<div class="address-card">\n\s*<div class="address-head"><svg[^\n]*<h3 class="address-title" id="assistant-email-heading">Email address<\/h3><\/div>\n\s*<div id="assistant-email"><\/div>/);
  assert.match(html, /<div class="address-foot">\n\s*<p id="phone-change-line" hidden>[\s\S]*?<details id="phone-options" hidden>/, "Change URL and Link options share the card's footer");
  assert.match(html, /getElementById\('phone-block'\)\.style\.display = '';/, "shown as a card, not forced to block");
  assert.doesNotMatch(html, /settings-group-header"><h2 id="assistant-email-heading"/, "no separate full-width card for email");
  const css = fs.readFileSync(require.resolve("../webapp/public/interface.css"), "utf8");
  assert.match(css, /\.address-parts \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 340px\), 1fr\)\); gap: 16px; align-items: stretch;/, "side by side and equal height, stacked on a phone");
  assert.match(css, /\.address-card \{ display: flex; flex-direction: column;[^}]*background: #1A1817; border: 1px solid rgba\(239,230,214,0\.1\); border-radius: 12px; \}/, "each its own card");
  assert.match(css, /#addresses \.address-foot \{ margin-top: auto; padding-top: 12px; border-top: 1px solid/, "footers sit at the bottom, divided");
  assert.match(css, /#addresses \.address-foot > p, #addresses \.address-foot summary \{ padding: 0; min-height: 32px; font-size: 14px; line-height: 32px; \}/, "footer rows match across both cards");
  const email = fs.readFileSync(require.resolve("../webapp/public/assistant-email.js"), "utf8");
  assert.match(email, /heading\.textContent = 'Email address';/);
  assert.match(email, /allowance\.classList\.add\('address-foot'\);/);
});

test("location is set where it shows, not in a Settings card", () => {
  assert.doesNotMatch(html, /id="location-section"|Locate me|location-manual-input/, "no Location card in Settings");
  const chat = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  assert.match(chat, /<button class="here" id="hereBtn"/, "the chat page sets it from the browser and shows the weather there");
  assert.match(chat, /if \(t\) \{ flipUnit\(t\); return; \}\n\s*if \(!e\.target\.closest\('\.wx-place'\)\) return;\n\s*wx\.hidden = true; btn\.hidden = false; btn\.click\(\);/, "the temperature flips the unit; the rest of the sentence sets the place again after a move");
  assert.match(chat, /' <button type="button" class="wx-place" data-tip="Moved\? Click to update your location\." aria-label="[^"]*">and ' \+ esc\(w\.label\) \+ ' in ' \+ esc\(d\.location\.name\) \+ '<\/button>/, "the whole rest of the sentence is the one control");
  const defs = fs.readFileSync(require.resolve("../lib/tools/definitions.js"), "utf8");
  assert.match(defs, /name: "save_location"/, "and ClosedHand saves it when told in chat");
});

test("the weather line's tip shows at once, in the page's own quiet style", () => {
  const chat = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  assert.match(chat, /<span class="here-wx" id="hereWx" hidden><\/span>/);
  assert.match(chat, /class="wx-place" data-tip="Moved\? Click to update your location\."/);
  assert.doesNotMatch(chat, /\.wx-num small|<small>/, "the unit reads in the same tone as the number");
  assert.match(chat, /data-tip="Sets your local time from where you are and shows the weather here"/);
  assert.doesNotMatch(chat, /wx\.title = |id="hereBtn" type="button" hidden title=/, "no slow browser tooltip");
  assert.match(chat, /var info = e\.target\.closest\('\[data-tip\]'\);/, "drawn by the page's own instant tooltip");
  assert.doesNotMatch(chat, /\[data-tip\]::after/, "one tooltip, not two");
});

test("clicking the temperature flips it between Celsius and Fahrenheit, and the choice is kept everywhere", () => {
  const server = fs.readFileSync(require.resolve("../webapp/server.js"), "utf8");
  const a = server.indexOf("function weatherInUnit("), b = server.indexOf("\n}\n", a) + 3;
  const { weatherInUnit } = vm.runInNewContext(server.slice(a, b) + "\n({ weatherInUnit })");
  const w = { tempC: 26.4, defaultUnit: "C", label: "clear", kind: "clear", isDay: false, timezone: "Europe/Lisbon" };
  assert.deepEqual(JSON.parse(JSON.stringify(weatherInUnit(w, {}))), { label: "clear", kind: "clear", isDay: false, timezone: "Europe/Lisbon", temp: 26, unit: "C", other: { temp: 80, unit: "F" } }, "where they are, with the other unit ready");
  assert.equal(weatherInUnit(w, { temperature_unit: "F" }).temp, 80, "their choice wins");
  assert.equal(weatherInUnit({ ...w, defaultUnit: "F" }, { temperature_unit: "C" }).unit, "C");
  assert.match(server, /app\.post\("\/api\/here\/unit"/);
  assert.match(server, /await patchSettings\(supabase, userId, \{ set: \{ temperature_unit: unit \} \}\);/);
  const chat = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  assert.match(chat, /'<button type="button" class="wx-temp" data-tip="Click for \\u00b0' \+ other \+ '"/, "the number says what clicking it does");
  assert.match(chat, /fetch\('\/api\/here\/unit', \{ method: 'POST'/);
  assert.match(chat, /if \(still\) swap\(\); else \{ num\.classList\.add\('out'\); setTimeout\(swap, 160\); \}/, "no roll for people who turn motion off");
  const handlers = fs.readFileSync(require.resolve("../lib/tools/handlers.js"), "utf8");
  assert.match(handlers, /const chosenUnit = \(ctx\.activeUserStore \|\| ctx\.store\)\?\.profile\?\.settings\?\.temperature_unit;/, "ClosedHand's weather answers use the same choice");
  assert.match(handlers, /temperature: deg\(current\.temperature_2m\)/);
});
