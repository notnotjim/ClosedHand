// A finished job's page does not keep running: after ten quiet minutes the
// bot's own tab goes blank and keeps its mark, and other tabs are left alone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const server = fs.readFileSync(path.join(__dirname, "../sandbox-image/agent/server.js"), "utf8");
const helper = fs.readFileSync(path.join(__dirname, "../sandbox-image/agent/browser_helper.py"), "utf8");

function parker(targets, names) {
  const start = server.indexOf('const TAB_MARKER = "closedhand-bot";');
  const end = server.indexOf("setInterval(() => { parkIdleTab()", start);
  const calls = [];
  const box = {
    console: { log() {} }, setTimeout: (f) => f(), Promise, JSON, Date,
    cdpTargets: async () => targets,
    cdpCall: async (ws, method, params) => {
      calls.push({ ws, method, params });
      if (method === "Runtime.evaluate" && params.expression === "window.name") return { result: { value: names[ws] } };
      return {};
    },
  };
  vm.runInNewContext(server.slice(start, end) + "\nthis.park = parkIdleTab; this.idle = () => { lastExecAt = 0; };", box);
  return { box, calls };
}

test("the marker is the one the browser helper stamps", () => {
  assert.match(helper, /^TAB_MARKER = "closedhand-bot"$/m);
});

test("after a quiet spell only the bot's tab goes blank, and is marked again", async () => {
  const targets = [
    { type: "page", url: "https://www.booking.com/hotel", webSocketDebuggerUrl: "bot" },
    { type: "page", url: "https://mail.example.com/", webSocketDebuggerUrl: "person" },
    { type: "service_worker", url: "https://x/sw.js", webSocketDebuggerUrl: "sw" },
  ];
  const { box, calls } = parker(targets, { bot: "closedhand-bot", person: "" });
  await box.park();
  assert.equal(calls.length, 0, "nothing happens while the bot was busy recently");
  box.idle();
  await box.park();
  assert.equal(JSON.stringify(calls.filter((c) => c.method === "Page.navigate")), JSON.stringify([{ ws: "bot", method: "Page.navigate", params: { url: "about:blank" } }]));
  const bot = calls.filter((c) => c.ws === "bot").map((c) => c.params.expression || c.params.url);
  assert.deepEqual(bot, ["window.name", "about:blank", 'window.name = "closedhand-bot"'], "blanked, then marked again so the next call finds it");
  assert.ok(!calls.some((c) => c.ws === "sw"), "only pages");
  const before = calls.length;
  await box.park();
  assert.equal(calls.length, before, "once per quiet spell");
});

test("any bot call starts the quiet spell again", () => {
  assert.match(server, /app\.post\("\/exec", \(req, res\) => \{\n  const \{ language, code, timeout_ms \} = req\.body;\n  lastExecAt = Date\.now\(\); parked = false;/);
  assert.match(server, /const PARK_AFTER_MS = 10 \* 60 \* 1000;/);
});
