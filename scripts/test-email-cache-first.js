// The synced copy is the mailbox. A search answers from it, "no match"
// included, whenever it covers the period asked; the provider is asked only
// for older mail, an unread check or a stopped sync, and even then only for
// the list of matches: messages already synced are read from the copy.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const fn = (src, name) => { const s = src.indexOf(`async function ${name}`); return src.slice(s, src.indexOf("\n}\n", s) + 2); };

function fakeDb(rows) {
  return { from: () => { const q = { filters: [], select: () => q, eq: () => q, not: () => q, order: () => q, in: (k, ids) => { q.ids = ids; return q; },
    limit: async () => ({ data: rows }), then: (r) => r({ data: rows.filter((x) => !q.ids || q.ids.includes(x.external_id)) }) }; return q; } };
}
// Tables by name, for cacheCovers.
function tables(t) { return { from: (name) => ({ select: () => ({ eq: async () => ({ data: t[name] || [] }) }) }) }; }

test("the copy covers a period when every mailbox holds all of it, within the year kept", async () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const horizon = () => new Date(now - 365 * 86400000).toISOString();
  const covers = (t) => { const box = { supabase: tables(t), Date, require: () => ({ horizon }) }; vm.runInNewContext(fn(read("lib/services/data-sync.js"), "cacheCovers") + "\nthis.f = cacheCovers;", box); return box.f; };
  const two = { connections: [{ service: "google" }, { service: "google_extra_work" }, { service: "whatsapp_linked" }] };
  let f = covers({ ...two, mail_coverage: [{ source: "gmail", complete_since: "2026-08-01T00:00:00Z" }, { source: "gmail_work", complete_since: "2026-09-01T00:00:00Z" }] });
  assert.equal(await f("u", "2026-09-27T00:00:00Z"), true, "the last weeks are inside both");
  assert.equal(await f("u", "2026-08-15T00:00:00Z"), false, "one mailbox doesn't reach back that far");
  assert.equal(await f("u", "2025-01-01T00:00:00Z"), false, "past the year kept");
  f = covers({ ...two, mail_coverage: [{ source: "gmail", complete_since: "2026-08-01T00:00:00Z" }] });
  assert.equal(await f("u", "2026-09-27T00:00:00Z"), false, "a mailbox not yet read back covers nothing");
  // The old rule: the oldest cached email. One sent in 2020 made three weeks
  // of mail "cover" six years, and search said no match for mail that existed.
  assert.doesNotMatch(read("lib/services/data-sync.js"), /\.order\("received_at", \{ ascending: true \}\)\s*\.limit\(1\);\s*if \(error \|\| !data\?\.length\) return false;/);
});

test("a live search reads synced messages from the copy and fetches only the rest", async () => {
  const box = { ctx: { activeUserId: "u" }, console: { log() {} },
    supabase: fakeDb([{ external_id: "m1", source: "gmail", data: { subject: "Synced", body: "from the copy" } }]) };
  vm.runInNewContext(fn(read("lib/services/data-access.js"), "syncedCopies") + "\nthis.f = syncedCopies;", box);
  const got = await box.f(["m1", "m2"]);
  assert.equal(got.size, 1);
  assert.equal(got.get("m1").subject, "Synced");
  const src = read("lib/services/data-access.js");
  assert.equal((src.match(/synced\.has\(id\) \? Promise\.resolve\(synced\.get\(id\)\)/g) || []).length, 2, "both Gmail paths reuse the copy");
});

test("no match inside the copy's period is the answer, not a reason to go live", () => {
  const sync = read("lib/services/data-sync.js");
  assert.match(sync, /return \{ results: \[\], cacheAgeMin, fresh: cacheAgeMin < 1440, covers: await cacheCovers\(userId, since\), source: "data_cache_hybrid" \};/);
  assert.doesNotMatch(sync, /report a miss so the caller falls to\n\s*\/\/ live search/);
  const access = read("lib/services/data-access.js");
  assert.match(access, /if \(cached && cached\.fresh && !cached\.covers && cached\.results\.length > 0\) fromCopy = cached\.results;\n\s*else if \(cached && cached\.fresh && \(cached\.results\.length > 0 \|\| cached\.covers\)\) \{/);
  assert.match(access, /if \(fromCopy\.length\) \{\n\s*allResults\.unshift\(\.\.\.fromCopy\);/, "matches from a copy that doesn't hold the period join the mailbox's");
  assert.match(sync, /return \{ results: ordered, cacheAgeMin, fresh: cacheAgeMin < 1440, covers: await cacheCovers\(userId, since\), source: "data_cache_hybrid" \};/);
  assert.match(access, /so this is the answer, not a gap/);
});
