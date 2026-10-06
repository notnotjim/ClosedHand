// A saved connection Google or Microsoft stopped accepting (the bot flags it
// reconnect_required) is not shown as connected: setup and the dashboard ask
// the person to sign in again, and signing in again clears the flag.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const health = require("../webapp/connection-health");

test("connections split into working ones and ones to sign in to again", () => {
  const rows = [
    { service: "google", metadata: { email: "a@example.com", reconnect_required: true, reconnect_reason: "dead refresh token" } },
    { service: "microsoft", metadata: { email: "b@example.com" } },
    { service: "shopify", metadata: null },
    { service: null },
  ];
  assert.deepEqual(health.split(rows), { working: ["microsoft", "shopify"], signInAgain: ["google"] });
  assert.deepEqual(health.split(null), { working: [], signInAgain: [] });
  assert.deepEqual(health.cleared(rows[0].metadata), { email: "a@example.com" });
  assert.equal(health.cleared(null), null);
});

// Setup's state with the database and apps stood in for.
async function setupStateWith(rows) {
  const stubs = {
    "./db": { isDbConfigured: () => true, supabase: { from: (table) => query(table, rows) } },
    "./admin": { getAdminUserId: () => "admin" },
    "./google-app": { app: () => null, canReturnTo: () => false },
    "./microsoft-app": { appId: () => null },
  };
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.endsWith(path.join("webapp", "setup-state.js")) && stubs[request]) return stubs[request];
    return load.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve("../webapp/setup-state")];
    return await require("../webapp/setup-state").getSetupState();
  } finally {
    Module._load = load;
  }
}
function query(table, rows) {
  const result = table === "connections" ? { data: rows } : table === "profiles" ? { data: { settings: {} } } : { data: [] };
  const chain = { select: () => chain, eq: () => chain, limit: () => chain, single: async () => result, then: (ok, bad) => Promise.resolve(result).then(ok, bad) };
  return chain;
}

test("setup: a flagged Google is not connected and asks to sign in again", async () => {
  const flagged = await setupStateWith([{ service: "google", metadata: { email: "a@example.com", reconnect_required: true } }]);
  assert.equal(flagged.googleConnected, false);
  assert.equal(flagged.googleSignInAgain, true);
  assert.equal(flagged.googleAccount.email, "a@example.com", "the note can say which account");
  assert.equal(flagged.steps.find((x) => x.key === "accounts").done, true, "setup stays finished, so the dashboard stays open");
  const fine = await setupStateWith([{ service: "google", metadata: { email: "a@example.com" } }]);
  assert.equal(fine.googleConnected, true);
  assert.equal(fine.googleSignInAgain, false);
  const ms = await setupStateWith([{ service: "microsoft", metadata: { reconnect_required: true } }]);
  assert.equal(ms.microsoftConnected, false);
  assert.equal(ms.microsoftSignInAgain, true);
});

test("the dashboard and setup pages say sign in again, and signing in clears the flag", () => {
  const server = read("webapp/server.js");
  assert.match(server, /services: health\.working,\n\s*signInAgain: health\.signInAgain,/, "the dashboard's status lists only working connections");
  assert.match(server, /const kept = metadata \|\| require\("\.\/connection-health"\)\.cleared\(previous\?\.\[0\]\?\.metadata\);/);
  const setup = read("webapp/views/setup.html");
  for (const id of ["g-again", "g-again-badge", "m-again", "m-again-badge"]) assert.match(setup, new RegExp(`id="${id}"`), id);
  assert.match(setup, /againNote\("g", st\.googleSignInAgain, st\.googleAccount\)/);
  assert.match(setup, /againNote\("m", st\.microsoftSignInAgain, st\.microsoftAccount\)/);
  const dashboard = read("webapp/views/dashboard.html");
  assert.match(dashboard, /<span class="int-badge problem" title="\$\{again \? "Its sign-in stopped working"/);
  assert.match(dashboard, /if \(m\.reconnect_required\) \{/);
});
