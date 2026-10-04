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

test("the copy covers a period when its oldest email is no newer than the start", async () => {
  const box = { supabase: fakeDb([{ received_at: "2026-08-01T00:00:00Z" }]), Date };
  vm.runInNewContext(fn(read("lib/services/data-sync.js"), "cacheCovers") + "\nthis.f = cacheCovers;", box);
  assert.equal(await box.f("u", "2026-09-27T00:00:00Z"), true, "the last week is inside the copy");
  assert.equal(await box.f("u", "2025-01-01T00:00:00Z"), false, "last year reaches past it");
  const empty = { supabase: fakeDb([]), Date };
  vm.runInNewContext(fn(read("lib/services/data-sync.js"), "cacheCovers") + "\nthis.f = cacheCovers;", empty);
  assert.equal(await empty.f("u", "2026-09-27T00:00:00Z"), false, "a mailbox on its first sync covers nothing yet");
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
  assert.match(access, /if \(cached && cached\.fresh && \(cached\.results\.length > 0 \|\| cached\.covers\)\) \{/);
  assert.match(access, /so this is the answer, not a gap/);
});
