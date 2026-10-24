// A page leaves the Pages list for Archived after a week and is deleted three
// months after that: it is a laid-out copy of an answer that stays in the
// chat. Archived projects are not touched. Archived pages say so where they
// are shown.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const expiry = require("../lib/page-expiry");

test("pages archived three months ago are deleted, and only pages", async () => {
  const DAY = 86400000, now = Date.UTC(2026, 9, 24);
  const seen = [];
  const db = { from: (table) => {
    const q = { delete() { seen.push(["table", table]); return q; }, lt(col, val) { seen.push([col, val]); return q; }, select: async () => ({ data: [{ id: "p1" }, { id: "p2" }], error: null }) };
    return q;
  } };
  assert.equal(await expiry.deleteOldPages(db, now), 2);
  assert.deepEqual(seen, [["table", "reports"], ["created_at", new Date(now - 97 * DAY).toISOString()]], "a week on the list, then three months in Archived");
  assert.match(read("index.js"), /require\("\.\/lib\/page-expiry"\)\.start\(\);/);
  assert.match(read("webapp/views/dashboard.html"), /\(_archivedPages \? '<p class="auto-card-meta" style="padding:0 4px;">Archived pages are deleted three months after they move here\.<\/p>' \+ _archivedPages\.map\(renderPageCard\)/);
});
