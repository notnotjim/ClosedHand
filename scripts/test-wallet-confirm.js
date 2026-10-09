// The Wallet asks for the dashboard password again before anything that lets
// ClosedHand spend more, or more without asking: adding a card, raising or
// removing a limit, turning off "ask me before every purchase", or raising
// the amount it may spend without asking. Looking, tightening a rule and
// removing a card never ask. One check trusts that browser for five minutes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const server = read("webapp/server.js");
const dashboard = read("webapp/views/dashboard.html");
const fn = (src, name) => { const a = src.indexOf(`function ${name}(`); return src.slice(a, src.indexOf("\n}\n", a) + 3); };

test("only a change that lets ClosedHand spend more, or more without asking, counts as loosening", () => {
  const { loosensLimits } = vm.runInNewContext(fn(server, "loosensLimits") + "\n({ loosensLimits })");
  const now = { per_purchase: 100, per_day: 200, always_ask: true };
  assert.equal(loosensLimits(now, { per_purchase: 150, per_day: 200, always_ask: true }), true, "a higher limit");
  assert.equal(loosensLimits(now, { per_day: 200, always_ask: true }), true, "a limit removed");
  assert.equal(loosensLimits(now, { per_purchase: 100, per_day: 200, always_ask: false }), true, "no longer asking");
  assert.equal(loosensLimits({ always_ask: false, auto_under: 20 }, { always_ask: false, auto_under: 50 }), true, "more without asking");
  assert.equal(loosensLimits(now, { per_purchase: 50, per_day: 200, always_ask: true }), false, "a lower limit");
  assert.equal(loosensLimits(now, { per_purchase: 100, per_day: 200, per_month: 500, always_ask: true }), false, "a new limit");
  assert.equal(loosensLimits({ always_ask: false }, { always_ask: true }), false, "asking again");
  assert.equal(loosensLimits(undefined, { always_ask: true }), false, "the first rules, still asking");
});

test("adding a card and loosening the rules are guarded on the server, where they cannot be skipped", () => {
  const add = server.slice(server.indexOf('app.post("/api/wallet", async'), server.indexOf('app.patch("/api/wallet/:id"'));
  assert.match(add, /if \(!\(await walletConfirmed\(req\)\)\) return walletNeedsPassword\(res\);/);
  const rules = server.slice(server.indexOf('app.post("/api/settings/spend-limits"'), server.indexOf('app.get("/keep"'));
  assert.match(rules, /if \(loosensLimits\(before, next\) && !\(await walletConfirmed\(req\)\)\) return walletNeedsPassword\(res\);/);
  const patch = server.slice(server.indexOf('app.patch("/api/wallet/:id"'), server.indexOf('app.delete("/api/wallet/:id"'));
  assert.match(patch, /if \(loosensLimits\(card && card\.limits, patch\.limits\) && !\(await walletConfirmed\(req\)\)\) return walletNeedsPassword\(res\);/);
  const del = server.slice(server.indexOf('app.delete("/api/wallet/:id"'), server.indexOf('app.delete("/api/wallet/:id"') + 600);
  assert.doesNotMatch(del, /walletConfirmed/, "removing a card never asks");
  const confirm = server.slice(server.indexOf('app.post("/api/wallet/confirm"'), server.indexOf("function walletAvailable()"));
  assert.match(confirm, /if \(lockedOut\(ip, req\)\) return res\.status\(429\)/, "the same lockout as signing in");
  assert.match(confirm, /noteWrongPassword\(ip, req\);/, "wrong passwords here count towards it");
  assert.match(confirm, /ch_wallet_ok=\$\{token\}; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=\$\{WALLET_CONFIRM_MS \/ 1000\}/, "a browser token, not shared between sessions");
  assert.match(server, /const WALLET_CONFIRM_MS = 5 \* 60 \* 1000;/);
  assert.match(server, /async function walletConfirmed\(req\) \{\n\s*if \(!\(await passwordConfigured\(\)\)\) return true;/, "nothing to check against without a password");
});

test("the dashboard asks for the password once and then makes the change", async () => {
  const start = dashboard.indexOf("    function askWalletPassword() {"), end = dashboard.indexOf("    function toggleAddCard() {");
  const calls = [];
  const els = {};
  const el = (id) => els[id] ||= { id, hidden: true, value: "", textContent: "", disabled: false, focus() {}, select() {}, scrollIntoView() {} };
  let walletAllowed = false;
  const respond = (status, body) => ({ ok: status < 400, status, json: async () => body, clone() { return this; } });
  const ctx = { document: { getElementById: el }, console,
    fetch: async (url, opts = {}) => {
      calls.push(url);
      if (url === "/api/wallet/confirm") { walletAllowed = JSON.parse(opts.body).password === "right"; return walletAllowed ? respond(200, { success: true }) : respond(403, { error: "That password is not right." }); }
      return walletAllowed ? respond(200, { success: true }) : respond(403, { needs_password: true, error: "Enter your dashboard password" });
    } };
  vm.runInNewContext(dashboard.slice(start, end) + "\nthis.walletFetch = walletFetch;", ctx);
  const pending = ctx.walletFetch("/api/settings/spend-limits", { method: "POST", body: "{}" });
  await new Promise((r) => setImmediate(r));
  assert.equal(el("wallet-confirm").hidden, false, "the prompt shows");
  el("wallet-confirm-pw").value = "wrong"; await el("wallet-confirm-go").onclick();
  assert.match(el("wallet-confirm-status").textContent, /not right/);
  el("wallet-confirm-pw").value = "right"; await el("wallet-confirm-go").onclick();
  const res = await pending;
  assert.equal(res.ok, true, "the change goes through after the password");
  assert.deepEqual(calls, ["/api/settings/spend-limits", "/api/wallet/confirm", "/api/wallet/confirm", "/api/settings/spend-limits"]);
  assert.equal(el("wallet-confirm").hidden, true);
  assert.match(dashboard, /var res = await walletFetch\('\/api\/settings\/spend-limits'/);
  assert.match(dashboard, /var res = await walletFetch\('\/api\/wallet', \{ method: 'POST'/);
});
