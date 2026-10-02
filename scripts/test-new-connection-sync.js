// A connection saved by the dashboard is synced within seconds, not at the next cycle.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load createConnectionWatch alone: data-sync.js requires the whole bot.
const src = fs.readFileSync(path.join(__dirname, "..", "lib", "services", "data-sync.js"), "utf8");
const start = src.indexOf("function createConnectionWatch");
const end = src.indexOf("async function listConnectionRows");
const box = {};
vm.runInNewContext(src.slice(start, end) + "\nthis.createConnectionWatch = createConnectionWatch;", box);

test("connections that exist at boot are left to the boot sync", async () => {
  const synced = [];
  const check = box.createConnectionWatch({ listConnections: async () => [{ id: 1, user_id: "a" }], syncUser: async (u) => synced.push(u) });
  assert.deepEqual([...(await check())], []);
  assert.deepEqual(synced, []);
});

test("a new connection syncs its owner once, straight away", async () => {
  let rows = [{ id: 1, user_id: "a" }];
  const synced = [];
  const check = box.createConnectionWatch({ listConnections: async () => rows, syncUser: async (u) => synced.push(u) });
  await check();
  rows = [...rows, { id: 2, user_id: "b" }, { id: 3, user_id: "b" }];
  assert.deepEqual([...(await check())], ["b"]);
  assert.deepEqual(synced, ["b"]);
  assert.deepEqual([...(await check())], []);
  assert.deepEqual(synced, ["b"]);
});

test("a reconnection (the row deleted and added again) syncs again", async () => {
  let rows = [{ id: 1, user_id: "a" }];
  const synced = [];
  const check = box.createConnectionWatch({ listConnections: async () => rows, syncUser: async (u) => synced.push(u) });
  await check();
  rows = [{ id: 7, user_id: "a" }];
  await check();
  assert.deepEqual(synced, ["a"]);
});

test("a failed look or a failed sync never stops the watch", async () => {
  let fail = true;
  const lines = [];
  const check = box.createConnectionWatch({
    listConnections: async () => { if (fail) throw new Error("db down"); return [{ id: 1, user_id: "a" }]; },
    syncUser: async () => { throw new Error("google down"); },
    log: (l) => lines.push(l),
  });
  assert.deepEqual([...(await check())], []);
  fail = false;
  await check();
  assert.ok(lines.some((l) => /db down/.test(l)));
});
