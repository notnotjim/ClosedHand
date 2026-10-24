// A purchase is put to the person first however it is made, unless their
// card is set to not need asking. A payment sent from
// code is no longer refused outright: it is asked about like any other, and
// with no checkout page to read, its amount is unknown so it is always
// asked. A pay button clicked by its outline number, with no selector, is
// still recognised by what the outline said it was.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function guard() {
  const rows = [];
  const query = () => {
    const q = { select: () => q, eq: () => q, in: () => q, gte: () => q, order: () => q, limit: () => q,
      insert: (row) => { rows.push(row); return { select: () => ({ single: async () => ({ data: { id: "l" + rows.length }, error: null }) }) }; },
      then: (resolve) => resolve({ data: [], error: null }) };
    return q;
  };
  const stubs = {
    "./db": { supabase: { from: query } },
    "./wallet": { lastCardFill: () => null, lastAddressFill: () => null, listCards: async () => [] },
    "./fx": { convert: async (v) => v },
  };
  const context = { module: { exports: {} }, URL, console, Date, Map, Promise, Number, String, Math, require: (name) => stubs[name] || {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../lib/spend-guard"), "utf8"), context);
  return { g: context.module.exports, rows };
}

test("a pay button clicked by its outline number is still a purchase", () => {
  const { g } = guard();
  g.notePage("u", "https://shop.example.com/basket", "Your basket");
  g.noteOutline("u", '# Basket\n[3] link "Keep shopping" -> /\n[7] button "Pay now"');
  assert.ok(g.spendIntent("sandbox_browse", { _userId: "u", action: "click", ref: 7 }), "the number names the pay button");
  assert.equal(g.spendIntent("sandbox_browse", { _userId: "u", action: "click", ref: 3 }), null, "another number is not paying");
  assert.ok(g.spendIntent("sandbox_browse", { _userId: "u", action: "batch", steps: [{ action: "click", ref: 3 }, { action: "click", ref: 7 }] }), "within a sequence too");
});

test("a payment sent from code is asked about, with its amount unknown, never refused outright", async () => {
  const { g, rows } = guard();
  const intent = g.spendIntent("api_request", { _userId: "u", method: "POST", url: "https://api.stripe.com/v1/payment_intents" });
  assert.equal(intent.kind, "api");
  assert.equal(intent.hard, undefined);
  assert.equal(intent.host, "api.stripe.com");
  // The browser last showed a page with a total; it has nothing to do with this request.
  const verdict = await g.assess({ userId: "u", userStore: { profile: { settings: { spend_limits: { always_ask: false, auto_under: 1000 } } } }, toolName: "api_request", source: "chat", intent,
    page: { host: "shop.example.com", url: "https://shop.example.com/checkout", title: "Checkout", total: { value: 5, currency: "GBP", text: "£5.00" } } });
  assert.equal(verdict.action, "ask", "an unknown amount is never under the no-questions amount");
  assert.match(verdict.card, /about to pay at api\.stripe\.com/);
  assert.match(verdict.card, /Total: not known, because this pays by a request from code rather than on a page\./);
  assert.doesNotMatch(verdict.card, /£5\.00/);
  assert.equal(rows[0].status, "asked");
  const exec = g.spendIntent("sandbox_exec", { _userId: "u", code: "import requests\nrequests.post('https://api.example-pay.com/v1/charges', data={'amount': 500})" });
  assert.equal(exec && exec.kind, "api");
});

test("the prompts state the person's rule, not a ban on paying from code", () => {
  const agents = fs.readFileSync(require.resolve("../lib/agents"), "utf8");
  const defs = fs.readFileSync(require.resolve("../lib/tools/definitions"), "utf8");
  for (const text of [agents, defs, fs.readFileSync(require.resolve("../lib/spend-guard"), "utf8")]) {
    assert.doesNotMatch(text, /never by calling (the|a) site or a payment provider directly/);
  }
  assert.match(agents, /paying for anything are put to the user first, however the payment is made, unless their card is set to not need asking/);
  assert.match(defs, /Any purchase, however it is made, is put to the user before it runs unless their card is set to not need asking\./);
});
