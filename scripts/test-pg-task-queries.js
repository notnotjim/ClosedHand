const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPgClient } = require("../lib/db-driver-pg");
test("local recovery accepts a missing lease and binds its expiry timestamp", () => {
  const db = createPgClient({ pool: {} });
  const query = db.from("agent_tasks");
  const q = query.update({ status: "running" }).in("status", ["pending", "running"])
    .or("lease_until.is.null,lease_until.lt.2026-09-13T12:00:00.000Z").select("id")._compileMutation();
  assert.match(q.text, /"lease_until" IS NULL/);
  assert.doesNotMatch(q.text, /IS \$/);
  assert.ok(q.values.includes("2026-09-13T12:00:00.000Z"));
  assert.match(q.text, /RETURNING "id"/);
});
