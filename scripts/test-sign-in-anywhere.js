// A sign-in to Google or another service started away from the computer
// running Closedhand (a phone, through the personal URL) used to come back to
// localhost and end on a dead page after the person had agreed. Now it comes
// back to the personal URL once the app allows that address, and otherwise
// says to finish on the computer before anyone signs in. Links the bot sends
// in chat apps point at the personal URL, not this computer's own address.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const server = read("webapp/server.js");
const start = server.slice(server.indexOf('app.get("/auth/:service", async'), server.indexOf('// Build state'));

test("started away from this computer, a sign-in that can only come back here stops first", () => {
  assert.match(start, /if \(fromElsewhere\(req\) && require\("\.\/google-app"\)\.canReturnTo\(BASE_URL\)\) \{/);
  assert.match(start, /const anywhere = personal && !closedhandApp \?/, "Closedhand's own Google app returns only to the computer that asked");
  assert.match(start, /else return sendFinishHere\(res,/);
  assert.ok(start.indexOf("closedhandApp = true;") > 0);
});

test("the address it came back to is the one the code is exchanged at, and the app is remembered", () => {
  assert.match(server, /const stateData = \{\n\s*service: serviceKey,\n\s*redirectUri,/);
  const callback = server.slice(server.indexOf('app.get("/auth/:service/callback"'), server.indexOf("// Exchange auth code for tokens"));
  assert.match(callback, /const redirectUri = stateData\.redirectUri \|\| `\$\{BASE_URL\}\/auth\/\$\{serviceKey\}\/callback`;/);
  assert.match(callback, /setRuntimeConf\(\{ \[returnsAnywhereKey\(serviceKey\)\]: "1" \}\)/);
});

test("the page says where to finish, escapes what it shows, and offers the address only for an app of the person's own", () => {
  const src = server.slice(server.indexOf("const returnsAnywhereKey ="), server.indexOf('app.get("/auth/:service", async'));
  const sent = [];
  const res = { set() { return res; }, type() { return res; }, send(html) { sent.push(html); return res; } };
  const assets = { stamp: (h) => h, withAppearance: (h) => h };
  const { sendFinishHere, returnsAnywhereKey } = new Function("assets", "path", "require", "__dirname", src + "; return { sendFinishHere, returnsAnywhereKey };")(assets, path, require, path.join(__dirname, "..", "webapp"));
  assert.equal(returnsAnywhereKey("google"), "SIGN_IN_RETURNS_ANYWHERE_GOOGLE");
  sendFinishHere(res, { name: "Google<script>", anywhere: "https://quiet-test.closedhand.com/auth/google/callback", again: "/auth/google?extra=1" });
  assert.doesNotMatch(sent[0], /<script>alert|Google<script>/);
  assert.match(sent[0], /Google&lt;script&gt; hands this sign-in back only to that computer/);
  assert.match(sent[0], /<code id="addr">https:\/\/quiet-test\.closedhand\.com\/auth\/google\/callback<\/code>/);
  assert.match(sent[0], /href="\/auth\/google\?extra=1&amp;anywhere=1"/);
  assert.match(sent[0], /<div class="card">/);
  sendFinishHere(res, { name: "Google", anywhere: null, again: "/auth/google" });
  assert.match(sent[1], /<div class="card only-here">/, "nothing to add for Closedhand's own app");
});

test("links the bot sends stay on the web chat's address there, and use the personal URL in chat apps", async () => {
  const config = require("../lib/config");
  const saved = config.dashboardBase;
  config.dashboardBase = async () => "https://quiet-test.closedhand.com";
  delete require.cache[require.resolve("../lib/dashboard-links")];
  try {
    const { closedhandLink } = require("../lib/dashboard-links");
    assert.equal(await closedhandLink("web", "/bot-connect?token=t"), "/bot-connect?token=t");
    assert.equal(await closedhandLink("whatsapp", "/auth/google"), "https://quiet-test.closedhand.com/auth/google");
  } finally {
    config.dashboardBase = saved;
    delete require.cache[require.resolve("../lib/dashboard-links")];
  }
  const handlers = read("lib/tools/handlers.js");
  assert.doesNotMatch(handlers, /\/bot-connect\?token=\$\{token\}`;\n/, "no bot-connect link built on this computer's own address");
  assert.match(handlers, /closedhandLink\(ctx\.activePlatform \|\| "web", `\/bot-connect\?token=\$\{token\}`\)/);
  assert.match(handlers, /closedhandLink\(ctx\.activePlatform \|\| "web", `\/auth\/\$\{service\}`\)/);
});
