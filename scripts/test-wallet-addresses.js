// Addresses in the Wallet: one is home, where cards are billed and orders go
// unless a card or a purchase names another. The card fill types the card's
// billing address, fill_address types a delivery address, and the question
// before paying says where the order is going.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

const HOME = { id: "a-home", label: "Home", name: "Ada Fixture", line1: "1 Example Road", line2: "Flat 2", city: "Testford", region: null, postcode: "TE1 1ST", country: "GB", phone: "07000 000000", is_home: true };
const WORK = { id: "a-work", label: "Work", name: "Ada Fixture", line1: "9 Sample Street", line2: null, city: "Sampleton", region: null, postcode: "SA9 9MP", country: "GB", phone: null, is_home: false };

function wallet(addresses) {
  const q = { select: () => q, eq: () => q, order: () => q, then: (resolve) => resolve({ data: addresses, error: null }) };
  const context = { module: { exports: {} }, console, require: (n) => (n === "./db" ? { supabase: { from: () => q } } : { decryptString: (s) => s }) };
  vm.runInNewContext(read("lib/wallet.js"), context);
  return context.module.exports;
}

test("addresses are a table of their own, added safely to any database", () => {
  const sql = read("migrations/070_wallet_addresses.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wallet_addresses \(/);
  assert.match(sql, /REFERENCES profiles\(id\) ON DELETE CASCADE/, "deleting the account deletes them");
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_wallet_addresses_user/);
});

test("home is used unless another is named, and a card is billed where it says, else home, else its old postcode", async () => {
  const w = wallet([HOME, WORK]);
  assert.equal((await w.findAddress("u", undefined)).address.id, "a-home");
  assert.equal((await w.findAddress("u", "home")).address.id, "a-home");
  assert.equal((await w.findAddress("u", "work")).address.id, "a-work");
  const miss = await w.findAddress("u", "the cottage");
  assert.equal(miss.address, null);
  assert.deepEqual(Array.from(miss.all, (a) => a.label), ["Home", "Work"], "a miss can say what there is");
  assert.equal((await w.billingFor("u", { billing: { address_id: "a-work" } })).id, "a-work");
  assert.equal((await w.billingFor("u", { billing: null })).id, "a-home");
  assert.equal((await w.billingFor("u", { billing: { address_id: "gone" } })).id, "a-home", "an address since removed falls back to home");
  const none = wallet([]);
  assert.deepEqual({ ...(await none.billingFor("u", { billing: { postcode: "TE9 9ZZ" } })) }, { postcode: "TE9 9ZZ" }, "a card from before addresses keeps its postcode");
  assert.equal(await none.billingFor("u", { billing: null }), null);
  assert.equal(w.oneLine(HOME), "1 Example Road, Flat 2, Testford, TE1 1ST, United Kingdom");
});

test("the card fill carries its billing address and the address fill a delivery one, each to its own kind of form", () => {
  const w = wallet([]);
  const card = w.fillScript({ number: "4242424242424242", exp_month: 4, exp_year: 2030, cvc: "123", holder: "Ada Fixture" }, "visible", HOME);
  assert.equal(JSON.parse(JSON.parse(card.match(/^B = json\.loads\((.*)\)$/m)[1])).line1, "1 Example Road");
  assert.match(card, /billing = fill_address\(page, B, "billing", True\) if B else None/);
  assert.doesNotMatch(card, /\("postcode", \['input\[autocomplete="postal-code"\]'/, "the postcode is the billing address's, not the first postcode field on the page");
  const delivery = w.addressScript(WORK);
  assert.match(delivery, /out = fill_address\(page, A, "shipping", False\)/);
  const values = JSON.parse(JSON.parse(delivery.match(/^A = json\.loads\((.*)\)$/m)[1]));
  assert.deepEqual(values.country_names, ["United Kingdom", "UK", "Great Britain"], "a dropdown may list the country by any of these");
  assert.equal(values.first, "Ada"); assert.equal(values.last, "Fixture");
  assert.match(delivery, /if not part or sec == other:/, "a field marked for the other kind of address is left alone");
  assert.match(delivery, /if sec == "" and only_empty_plain and info\["value"\]\.strip\(\):/, "the billing pass leaves a filled delivery address alone");
  const py = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: card + "\n" + delivery, encoding: "utf8" });
  if (!py.error) assert.equal(py.status, 0, py.stderr);
});

test("the question before paying says where the order is going, and a finished purchase forgets the address", async () => {
  let cleared = 0;
  const q = { select: () => q, eq: () => q, in: () => q, gte: () => q, order: () => q, limit: () => q,
    insert: () => ({ select: () => ({ single: async () => ({ data: { id: "l1" }, error: null }) }) }),
    update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { user_id: "u" }, error: null }) }) }) }),
    then: (resolve) => resolve({ data: [], error: null }) };
  const stubs = {
    "./db": { supabase: { from: () => q } },
    "./wallet": { lastCardFill: () => null, listCards: async () => [], clearFills: () => { cleared++; },
      lastAddressFill: () => ({ label: "Work", line: "9 Sample Street, Sampleton, SA9 9MP, United Kingdom" }) },
    "./fx": { convert: async (v) => v },
  };
  const context = { module: { exports: {} }, URL, console, Date, Map, Promise, Number, String, Math, require: (n) => stubs[n] || {} };
  vm.runInNewContext(read("lib/spend-guard.js"), context);
  const g = context.module.exports;
  const verdict = await g.assess({ userId: "u", userStore: {}, toolName: "sandbox_browse", source: "chat", intent: { kind: "click", why: "the button says it pays" },
    page: { host: "shop.example.com", url: "https://shop.example.com/checkout", title: "Checkout", total: { value: 20, currency: "GBP", text: "£20.00" } } });
  assert.equal(verdict.action, "ask");
  assert.match(verdict.card, /\nDelivering to: Work, 9 Sample Street, Sampleton, SA9 9MP, United Kingdom\n/);
  await g.ledgerUpdate("l1", { status: "completed" });
  assert.equal(cleared, 1);
});

test("fill_address types a saved address, says which are saved when the name is wrong, and asks when there is none", () => {
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /const \{ address, all \} = await wallet\.findAddress\(userId, toolInput\.address\);/);
  assert.match(handlers, /There is no saved address matching "\$\{toolInput\.address\}"\. Saved: \$\{all\.map\(\(a\) => a\.label\)\.join\(", "\)\}\./);
  assert.match(handlers, /The user has no address saved\. Ask them where it should go and type it with fill; they can save it under Wallet in Settings so it is filled in next time\./);
  assert.match(handlers, /wallet\.noteAddressFill\(userId, address\);/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /fill_address types one of the user's saved addresses into the delivery form on the page already open: 'home' unless the user asked for another saved one by its label/);
  assert.match(defs, /address: \{\n\s*type: "string",\n\s*description: "For fill_address: which saved address, as 'home' or its label, e\.g\. 'work'\.",/);
});

test("Settings adds, changes and removes addresses behind the dashboard's own checks, and a card is billed to one of them", () => {
  const server = read("webapp/server.js");
  for (const route of ['app.post("/api/wallet/addresses"', 'app.patch("/api/wallet/addresses/:id"', 'app.delete("/api/wallet/addresses/:id"']) {
    const body = server.slice(server.indexOf(route), server.indexOf("\n});", server.indexOf(route)));
    assert.ok(body.length > 50, route);
    assert.match(body, /if \(!\(await requireSetupAccess\(req, res\)\)\) return;/, route);
  }
  const fn = server.slice(server.indexOf("function cleanAddress("), server.indexOf("// A card's billing address"));
  const ctx = {}; vm.runInNewContext(fn + "; this.cleanAddress = cleanAddress;", ctx);
  assert.equal(ctx.cleanAddress({ line1: "", city: "Testford", country: "GB" }).error, "Enter the first line of the address.");
  assert.equal(ctx.cleanAddress({ line1: "1 Example Road", country: "GB" }).error, "Enter the town or the postcode.");
  assert.equal(ctx.cleanAddress({ line1: "1 Example Road", city: "Testford", country: "" }).error, "Choose the country.");
  assert.equal(ctx.cleanAddress({ line1: " 1 Example Road ", postcode: "TE1 1ST", country: "gb" }).address.country, "GB");
  assert.match(server, /const \{ data \} = await supabase\.from\("wallet_addresses"\)\.select\("id"\)\.eq\("user_id", userId\)\.eq\("id", id\)\.limit\(1\);/, "a card is only billed to the person's own address");
  assert.match(server, /if \(c\.billing && c\.billing\.address_id === id\) \{/, "removing an address sends its cards back to home");
  assert.match(server, /if \(gone\.is_home\) \{/, "and the oldest address left becomes home");
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<div style="font-size:13px;font-weight:600;color:var\(--fg\);margin-bottom:4px;">Addresses<\/div>/);
  assert.match(dash, /addCard\('Add a card', 'toggleAddCard\(\)'\);/, "both lists end with the same add tile");
  assert.match(dash, /addCard\('Add an address', 'openAddressForm\(\)'\);/);
  assert.match(dash, /<label class="wallet-field"><span>Billing address<\/span><select id="wc-billing"><\/select><\/label>/);
  assert.doesNotMatch(dash, /wc-postcode|Billing postcode/);
});
