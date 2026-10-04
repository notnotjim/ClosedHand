// A booking email that gives a date without its year means the first such
// day after the email was sent, never "this year". Old confirmation emails
// (a December 2022 Qatar trip, an October 2025 Trip.com order) were dated to
// 2026 and shown as upcoming; a real flight was also kept twice as a booking.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { yearCorrection, yearsToAnchor, implausiblyLate, shiftYears } = require("../lib/email-dates");
const { reconcileFlights } = require("../lib/flight-bookings");

test("a date without its year is the first such day after the email was sent", () => {
  assert.equal(yearCorrection("2026-12-21T19:00:00+08:00", "2022-12-21T06:48:44Z", false), -4, "a 2022 email describes a 2022 trip");
  assert.equal(yearCorrection("2026-12-03T00:00:00+09:00", "2025-10-25T00:00:00Z", false), -1);
  assert.equal(yearCorrection("2026-01-15T10:00:00+00:00", "2026-12-20T10:00:00Z", false), 1, "a January trip in a December email is next January");
  assert.equal(yearCorrection("2026-10-07T11:55:00+07:00", "2026-10-01T06:31:40Z", false), 0);
  assert.equal(yearCorrection("2026-10-04T09:00:00+07:00", "2026-10-04T08:00:00Z", false), 0, "booked on the day");
  assert.equal(yearCorrection("2028-06-01T10:00:00+00:00", "2026-06-01T10:00:00Z", true), 0, "a year the email wrote is kept, however far ahead");
  assert.equal(yearCorrection("2026-12-21T19:00:00+08:00", "2022-12-21T06:48:44Z"), -4, "unsaid, a date years after its email was guessed");
  assert.equal(yearCorrection("2026-11-01T10:00:00+00:00", "2026-03-01T10:00:00Z"), 0, "unsaid and plausible, left alone");
  assert.equal(implausiblyLate("2026-12-02T15:00:00Z", "2025-10-25T00:00:00Z"), true);
  assert.equal(shiftYears("2026-12-22T00:00:00+03:00", -4), "2022-12-22T00:00:00+03:00");
  assert.equal(yearsToAnchor("not a date", "2022-12-21T00:00:00Z"), 0);
});

test("a flight from an old email is dated by that email, so a past trip never shows as upcoming", () => {
  const emails = [
    { id: "old", date: "Wed, 21 Dec 2022 06:48:44 +0000", subject: "Your booking", body: "QR1563 DPS-DOH 21 Dec 19:00. QR0009 DOH-LHR 22 Dec 01:50. Booking ZR5LMT2A" },
    { id: "new", date: "2026-10-01T06:31:40Z", subject: "Your order", body: "VN123 DAD-SGN 7 Oct 11:55 KQ7P2X" },
  ];
  const parsed = [
    { emailIndex: 0, airline: "Qatar Airways", flightNumber: "QR1563", yearStated: false, departure: { airport: "DPS", dateTime: "2026-12-21T19:00:00+08:00" }, arrival: { airport: "DOH", dateTime: "2026-12-22T00:00:00+03:00" }, confirmationCode: "ZR5LMT2A" },
    { emailIndex: 1, airline: "Vietnam Airlines", flightNumber: "VN123", yearStated: false, departure: { airport: "DAD", dateTime: "2026-10-07T11:55:00+07:00" }, arrival: { airport: "SGN", dateTime: "2026-10-07T13:25:00+07:00" }, confirmationCode: "KQ7P2X" },
  ];
  const result = reconcileFlights({}, parsed, emails, Date.parse("2026-10-05T00:00:00Z"));
  const keys = result.patches.map(([key]) => key);
  assert.deepEqual(keys, ["flight-VN123-2026-10-07"], "the 2022 trip is past, so only the real flight is kept");
});

test("both readers are told to anchor on the email, and stored records heal", () => {
  for (const f of ["lib/flights.js", "lib/bookings.js"]) {
    const src = read(f);
    assert.doesNotMatch(src, /The current year is/, `${f} no longer dates by the current year`);
    assert.match(src, /Without a written year, use the year that puts the (flight|booking) first on or after the email's date, never simply the current year/);
    assert.match(src, /"yearStated": true/);
  }
  const flights = read("lib/flights.js");
  assert.match(flights, /flight\.sourceEmailAt && implausiblyLate\(flight\.departure\?\.dateTime, flight\.sourceEmailAt\)/, "a stored flight long after its email is re-dated, and goes if past");
  const bookings = read("lib/bookings.js");
  assert.match(bookings, /if \(b\.reference && flightRefs\.has\(String\(b\.reference\)/, "a flight is never also kept as a booking");
  assert.match(bookings, /let drop = !!ref && flightRefs\.has\(ref\);/);
});

test("a flight is labelled a flight: never a train or other, and never kept twice", () => {
  const vm = require("node:vm");
  const src = read("lib/bookings.js");
  const box = {};
  vm.runInNewContext(src.slice(src.indexOf("const KINDS"), src.indexOf("\n}\n", src.indexOf("function kindOf")) + 3) + "\nthis.kindOf = kindOf;", box);
  assert.equal(box.kindOf({ kind: "train", provider: "Vietnam Airlines" }), "flight");
  assert.equal(box.kindOf({ kind: "other", provider: "Vietnam Airlines" }), "flight");
  assert.equal(box.kindOf({ kind: "bus", provider: "Qatar Airways" }), "flight");
  assert.equal(box.kindOf({ kind: "flight", provider: "Trip.com" }), "flight", "the reader may now say flight itself");
  assert.equal(box.kindOf({ kind: "other", provider: "Airbnb" }), "other");
  assert.equal(box.kindOf({ kind: "train", provider: "Avanti West Coast" }), "train");
  assert.equal(box.kindOf({ kind: "hotel", provider: "Air Hotel Bangkok" }), "hotel", "only travel kinds are re-labelled");
  assert.match(src, /A flight is kind "flight", never train, bus or other\./);
  assert.doesNotMatch(src, /Skip flights entirely/);
  assert.match(src, /const kind = drop \? r\.kind : kindOf\(r\);/, "stored flights filed as trains are re-labelled on the next scan");
  assert.match(read("webapp/views/dashboard.html"), /var BOOKING_ICON = \{ flight: '&#9992;&#65039;',/);
});

// A table in memory, enough of the query builder for lib/bookings.js.
function memoryDb(tables) {
  return {
    from(name) {
      const rows = tables[name] || (tables[name] = []);
      const filters = [];
      let op = "select", patch = null;
      const q = {
        select() { return q; },
        update(p) { op = "update"; patch = p; return q; },
        delete() { op = "delete"; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        gte(k, v) { filters.push((r) => String(r[k]) >= v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        like(k, v) { const re = new RegExp("^" + v.replace(/%/g, ".*") + "$"); filters.push((r) => re.test(r[k])); return q; },
        then(done, fail) {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (op === "update") hit.forEach((r) => Object.assign(r, patch));
          if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
          return Promise.resolve({ data: op === "select" ? hit.map((r) => ({ ...r })) : null, error: null }).then(done, fail);
        },
      };
      return q;
    },
  };
}

test("a scan with no new mail still heals the stored bookings", async () => {
  const Module = require("node:module");
  const day = 86400000, at = (ms) => new Date(ms).toISOString();
  const soon = Date.now() + 2 * day;
  const tables = {
    facts: [{ user_id: "u1", key: "flight-NW210-x", value: { value: JSON.stringify({ flightNumber: "NW210", confirmationCode: "KQ7P2X" }) } }],
    data_cache: [{ user_id: "u1", type: "email", external_id: "m-old", received_at: "2025-09-14T10:00:00Z" }],
    bookings: [
      { id: "b1", user_id: "u1", kind: "train", provider: "Northwind Airways", title: "Harbourtown to Lakeside", reference: "KQ7P2X", starts_at: at(soon) },
      { id: "b2", user_id: "u1", kind: "other", provider: "Example Travel", title: "Old trip", reference: "ET1001", starts_at: "2026-11-20T09:00:00.000Z", source_email_id: "m-old" },
      { id: "b3", user_id: "u1", kind: "bus", provider: "Northwind Airways", title: "Lakeside to Harbourtown", reference: "ZZ9Q4M", starts_at: at(soon + day) },
      { id: "b4", user_id: "u1", kind: "hotel", provider: "Harbour House", title: "Harbour House", reference: "HH4471", starts_at: at(soon) },
    ],
  };
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /lib\/bookings\.js$/.test(parent.filename)) {
      if (request === "./db") return { supabase: memoryDb(tables) };
      if (request === "./services/data-access") return { searchCache: async () => ({ results: [] }) };
      if (request === "./llm") return { getInternalClient: () => ({}) };
      if (request === "./mail-attachments") return { bodyForScan: (e) => e.body || "" };
    }
    return load.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve("../lib/bookings")];
    const result = await require("../lib/bookings").scanBookings("u1");
    assert.equal(result.scanned, 0, "no booking mail to read");
  } finally { Module._load = load; delete require.cache[require.resolve("../lib/bookings")]; }
  const left = Object.fromEntries(tables.bookings.map((b) => [b.id, b.kind]));
  assert.deepEqual(left, { b3: "flight", b4: "hotel" }, "the flight kept as a train goes, the past trip goes, the airline 'bus' is a flight");
});
