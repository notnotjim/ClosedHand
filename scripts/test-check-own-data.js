// The push check finds details from the person's own ClosedHand in what is
// about to be pushed, and leaves ordinary code alone. All values invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { distinctive, findMatches } = require("./check-own-data");

const stored = (value) => JSON.stringify({ value, created: "2026-10-03T19:37:04.717Z", category: "profile", source: "email" });
const rows = [
  { kind: "fact:flight-QZ417-2026-10-09", value: stored(JSON.stringify({ airline: "Northwind Airways", flightNumber: "QZ417", confirmationCode: "KQ7P2X", departure: { airport: "LIS", dateTime: "2026-10-09T14:20:00+01:00", tz: "Europe/Lisbon" }, status: "scheduled" })) },
  { kind: "fact:profile-name", value: stored("Robbie Hale") },
  { kind: "fact:profile-email", value: stored("robbie.hale@example.org") },
  { kind: "booking", value: "Harbour House, Porto" },
  { kind: "page id", value: "4f0c9a2e-7b1d-4e8a-9c3f-6a5b2d1e8f07" },
  { kind: "mail sender", value: "Harbour House <stay@harbourhouse.example>" },
  { kind: "task id", value: "00000000-0000-0000-0000-0000000000ad" },
];

test("what a stored fact holds is looked for, not the labels around it", () => {
  const values = distinctive(rows).map((v) => v.value);
  for (const v of ["QZ417", "KQ7P2X", "Robbie Hale", "Robbie", "robbie.hale@example.org", "Harbour House, Porto", "stay@harbourhouse.example", "4f0c9a2e-7b1d-4e8a-9c3f-6a5b2d1e8f07"]) {
    assert.ok(values.includes(v), `looks for ${v}`);
  }
  for (const v of ["profile", "email", "scheduled", "Northwind Airways", "Europe/Lisbon", "2026-10-09T14:20:00+01:00", "00000000-0000-0000-0000-0000000000ad", "LIS"]) {
    assert.ok(!values.includes(v), `leaves out ${v}`);
  }
});

test("a match is reported with where it is; a word inside a longer word is not one", () => {
  const values = distinctive(rows);
  const hits = findMatches(values, [
    { where: "a1b2c3d scripts/test-x.js:12", text: 'body: "QZ417 LIS-OPO, ref KQ7P2X"' },
    { where: "a1b2c3d message", text: "Robbie asked why the card said train" },
    { where: "a1b2c3d lib/y.js:4", text: "const robbieHalek = profileEmail; // source: email" },
  ]);
  assert.deepEqual(hits.map((h) => `${h.where} ${h.value}`), [
    "a1b2c3d scripts/test-x.js:12 QZ417",
    "a1b2c3d scripts/test-x.js:12 KQ7P2X",
    "a1b2c3d message Robbie",
  ]);
});
