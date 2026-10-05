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

test("mail reconciliation returns separately named JSON fields", () => {
  const db = createPgClient({ pool: {} });
  const q = db.from("data_cache").select("record_id:external_id, mfrom:data->>from, msubject:data->>subject").limit(1)._compile();
  assert.match(q.text, /"external_id" AS "record_id"/);
  assert.match(q.text, /"data"->>'from' AS "mfrom"/);
  assert.match(q.text, /"data"->>'subject' AS "msubject"/);
  assert.doesNotMatch(q.text, /"mfrom:data"/);
});

// Unnamed, Postgres calls every JSON path "?column?": two collided and Pulse
// read every sender and subject as empty, so its junk filter dropped nothing.
test("an unnamed JSON field comes back under its own key, as PostgREST does", () => {
  const db = createPgClient({ pool: {} });
  const q = db.from("data_cache").select("external_id, data->>from, data->>subject, data->labels, data->meta->>kind").limit(1)._compile();
  assert.match(q.text, /"data"->>'from' AS "from"/);
  assert.match(q.text, /"data"->>'subject' AS "subject"/);
  assert.match(q.text, /"data"->'labels' AS "labels"/);
  assert.match(q.text, /"data"->'meta'->>'kind' AS "kind"/);
  const w = db.from("data_cache").select("id").eq("data->>from", "x").limit(1)._compile();
  assert.doesNotMatch(w.text, /WHERE[^]*AS "from"/, "filters stay plain expressions");
});

test("returned writes preserve projection aliases and escape JSON keys", () => {
  const db = createPgClient({ pool: {} });
  // Compile only. No database call is made by this assertion.
  const query = db.from("data_cache");
  const q = query.update({ external_id: "fixture" }).eq("id", "row")
    .select("record_id:external_id, value:data->>owner's")._compileMutation();
  assert.match(q.text, /RETURNING "external_id" AS "record_id", "data"->>'owner''s' AS "value"/);
  assert.deepEqual(q.values, ["fixture", "row"]);
});
