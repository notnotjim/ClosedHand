// The flight and booking scanners sent the LLM the same unchanged emails
// every six hours and after every restart, to find nothing new. Each email
// is now read at most twice, and again when what is sent changes or the
// scanner's instructions do (lib/email-scans.js). A scan the person asks for
// still reads everything.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const scans = require("../lib/email-scans");

// Enough of the database client for email_scans: select with eq/in, and upsert.
function fakeDb({ failReads = false } = {}) {
  const rows = new Map();
  const db = {
    rows,
    from() {
      const filters = {};
      const q = {
        select() { return q; },
        eq(col, val) { filters[col] = val; return q; },
        in(col, vals) { filters[col] = vals; return q; },
        then(resolve) {
          if (failReads) return resolve({ data: null, error: { message: "down" } });
          const data = [...rows.values()].filter((r) => r.user_id === filters.user_id && r.scanner === filters.scanner && filters.email_id.includes(r.email_id));
          return resolve({ data, error: null });
        },
        upsert(list) {
          for (const r of list) rows.set(`${r.user_id}|${r.scanner}|${r.email_id}`, { ...r });
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
  return db;
}

const mail = (id, body = "Your stay at Lantern House, 3 to 5 March, ref QX7P") => ({ emailIndex: 0, id, subject: "Booking confirmed", from: "stays@example.com", date: "2026-02-01", body });

// The fixture mail was sent on 1 February: the next day it has just arrived;
// by March it is old mail, like the year read back at setup.
const ARRIVED = Date.parse("2026-02-02T09:00:00Z"), MONTH_ON = Date.parse("2026-03-01T09:00:00Z");

test("mail read as it arrives is sent twice at most, and again when its text or the instructions change", async () => {
  const db = fakeDb();
  const one = [mail("m1")];
  assert.equal((await scans.unread(db, "u1", "bookings", 1, one, ARRIVED)).length, 1, "new");
  await scans.markRead(db, "u1", "bookings", 1, one);
  assert.equal((await scans.unread(db, "u1", "bookings", 1, one, ARRIVED)).length, 1, "a second chance");
  await scans.markRead(db, "u1", "bookings", 1, one);
  assert.equal((await scans.unread(db, "u1", "bookings", 1, one, ARRIVED)).length, 0, "read twice: not sent again");
  assert.equal((await scans.unread(db, "u1", "bookings", 1, [mail("m1", "Your stay moved to 4 to 6 March, ref QX7P")], ARRIVED)).length, 1, "changed text is read again");
  assert.equal((await scans.unread(db, "u1", "bookings", 2, one, ARRIVED)).length, 1, "new instructions read everything again");
  assert.equal((await scans.unread(db, "u1", "flights", 1, one, ARRIVED)).length, 1, "each scanner keeps its own record");
  assert.equal((await scans.unread(db, "u2", "bookings", 1, one, ARRIVED)).length, 1, "and each person their own");
  const changed = [mail("m1", "Your stay moved to 4 to 6 March, ref QX7P")];
  await scans.markRead(db, "u1", "bookings", 1, changed);
  assert.equal(db.rows.get("u1|bookings|m1").reads, 1, "a changed email starts counting again");
  assert.doesNotMatch(JSON.stringify([...db.rows.values()]), /Lantern|QX7P/, "only a hash of the text is kept");
});

test("mail over a week old, like the year read back at setup, is read once", async () => {
  const db = fakeDb();
  const one = [mail("m1")];
  assert.equal((await scans.unread(db, "u1", "bookings", 1, one, MONTH_ON)).length, 1, "not read yet");
  await scans.markRead(db, "u1", "bookings", 1, one);
  assert.equal((await scans.unread(db, "u1", "bookings", 1, one, MONTH_ON)).length, 0, "read once: done");
  assert.equal((await scans.unread(db, "u1", "bookings", 1, [mail("m1", "Your stay moved to 4 to 6 March, ref QX7P")], MONTH_ON)).length, 1, "a changed one is still read again");
  assert.equal(scans.readsFor({ date: "not a date" }, MONTH_ON), 2, "a date that can't be read counts as new mail");
});

test("when the record can't be read, every email is sent, as before", async () => {
  const one = [mail("m1"), mail("m2")];
  assert.equal((await scans.unread(fakeDb({ failReads: true }), "u1", "flights", 1, one)).length, 2);
});

test("both scanners skip mail already read, count it read only after an answer, and read everything when asked", () => {
  const flights = read("lib/flights.js"), bookings = read("lib/bookings.js"), handlers = read("lib/tools/handlers.js");
  assert.match(flights, /if \(!opts\.force\) emailBodies = \(await scans\.unread\(scanDb, userId, "flights", FLIGHT_SCAN_VERSION, emailBodies\)\)\.map\(\(e, i\) => \(\{ \.\.\.e, emailIndex: i \}\)\);/);
  assert.match(flights, /if \(answered\) await scans\.markRead\(scanDb, userId, "flights", FLIGHT_SCAN_VERSION, emailBodies\);/);
  assert.match(bookings, /if \(!opts\.force\) emails = \(await scans\.unread\(supabase, userId, "bookings", BOOKING_SCAN_VERSION, emails\)\)\.map/);
  assert.match(bookings, /throw new Error\("extraction did not parse"\)/, "a reply that doesn't parse is not an answer");
  assert.match(handlers, /scanBookings\(toolInput\._userId \|\| ctx\.activeUserId, \{ force: true \}\)/);
  assert.match(handlers, /const newFlights = await scanEmailsForFlights\(userId, \{ force: true \}\);/);
  assert.match(read("migrations/064_email_scans.sql"), /CREATE TABLE IF NOT EXISTS email_scans \(/);
});

test("bookings are read ten emails at a time, so no answer is cut off and each batch counts on its own", () => {
  const bookings = read("lib/bookings.js");
  assert.match(bookings, /const EMAILS_PER_READ = 10;/);
  assert.match(bookings, /const batch = emails\.slice\(at, at \+ EMAILS_PER_READ\)\.map\(\(e, i\) => \(\{ \.\.\.e, emailIndex: i \}\)\);/);
  assert.match(bookings, /parsed\.push\(b && Number\.isInteger\(idx\) \? \{ \.\.\.b, emailIndex: idx \+ at \} : b\);/, "each answer points back at the right email");
  assert.match(bookings, /await scans\.markRead\(supabase, userId, "bookings", BOOKING_SCAN_VERSION, batch\);/, "only a batch that was answered counts as read");
  assert.match(bookings, /if \(failure && !parsed\.length\) return \{ scanned: emails\.length, found: 0, new: 0, error: failure \};/);
});
