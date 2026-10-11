// A booking email that gives a date without its year means the first such
// day after the email was sent, never "this year". Old confirmation emails
// (a December 2022 Qatar trip, an October 2025 Trip.com order) were dated to
// 2026 and shown as upcoming; a real flight was also kept twice as a booking.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { yearCorrection, yearsToAnchor, yearWritten, implausiblyLate, shiftYears } = require("../lib/email-dates");
const { reconcileFlights } = require("../lib/flight-bookings");

test("a date without its year is the first such day after the email was sent", () => {
  assert.equal(yearCorrection("2026-12-21T19:00:00+08:00", "2022-12-21T06:48:44Z", false), -4, "a 2022 email describes a 2022 trip");
  assert.equal(yearCorrection("2026-12-03T00:00:00+09:00", "2025-10-25T00:00:00Z", false), -1);
  assert.equal(yearCorrection("2026-01-15T10:00:00+00:00", "2026-12-20T10:00:00Z", false), 1, "a January trip in a December email is next January");
  assert.equal(yearCorrection("2026-10-09T14:20:00+01:00", "2026-10-01T06:31:40Z", false), 0);
  assert.equal(yearCorrection("2026-10-04T09:00:00+07:00", "2026-10-04T08:00:00Z", false), 0, "booked on the day");
  assert.equal(yearCorrection("2028-06-01T10:00:00+00:00", "2026-06-01T10:00:00Z", true), 0, "a year the email wrote is kept, however far ahead");
  assert.equal(yearCorrection("2026-12-21T19:00:00+08:00", "2022-12-21T06:48:44Z"), -4, "unsaid, a date years after its email was guessed");
  assert.equal(yearCorrection("2026-11-01T10:00:00+00:00", "2026-03-01T10:00:00Z"), 0, "unsaid and plausible, left alone");
  assert.equal(implausiblyLate("2026-12-02T15:00:00Z", "2025-10-25T00:00:00Z"), true);
  assert.equal(shiftYears("2026-12-22T00:00:00+03:00", -4), "2022-12-22T00:00:00+03:00");
  assert.equal(yearsToAnchor("not a date", "2022-12-21T00:00:00Z"), 0);
});

test("mail sent during or just after a trip is about that trip, not the same days next year", () => {
  // A host's message in the reservation thread, sent on the last day of the stay.
  const thread = { end: "2027-05-20T04:00:00Z", text: "RE: Reservation for Garden loft, 2 – 20 May. On 19 May 2026, Mai wrote: see you soon" };
  assert.equal(yearCorrection("2027-05-02T07:00:00Z", "2026-05-20T02:51:37Z", false, thread), -1, "the stay that just ended, not one almost a year away");
  assert.equal(yearCorrection("2027-05-02T07:00:00Z", "2026-05-20T02:51:37Z", true, thread), -1, "a year the email never writes was guessed, whatever the reader says");
  assert.equal(yearCorrection("2027-05-02T07:00:00Z", "2026-05-20T02:51:37Z", undefined, thread), -1);
  assert.equal(yearCorrection("2027-05-02T07:00:00Z", "2026-05-20T02:51:37Z", true, { text: "Your stay 2 May 2027 – 20 May 2027" }), 0, "a year the email writes is kept");
  assert.equal(yearCorrection("2027-03-05T19:00:00+07:00", "2026-03-09T03:53:47Z", false, { text: "How was dinner on 5 March?" }), -1, "a review request after a table is about that table");
  assert.equal(yearCorrection("2026-01-15T10:00:00+00:00", "2026-12-20T10:00:00Z", false, { end: "2026-01-20T10:00:00+00:00", text: "15 Jan – 20 Jan" }), 1, "a stay that ended months before the email is next year's");
  assert.equal(yearCorrection("2026-06-20T15:00:00+07:00", "2026-06-07T02:00:00Z", false, { end: "2026-06-25T11:00:00+07:00", text: "20 June – 25 June" }), 0, "a stay ahead of its email keeps the email's year");
  assert.equal(yearsToAnchor("2027-05-02T07:00:00Z", "2026-06-30T00:00:00Z", "2027-05-20T04:00:00Z"), 0, "more than a month after the stay, the next one is meant");
  assert.equal(yearWritten("2027-05-02", "booked for 2027"), true);
  assert.equal(yearWritten("2027-05-02", "ref 120279 and 2 May"), false, "digits inside a longer number are not a year");
});

test("a flight from an old email is dated by that email, so a past trip never shows as upcoming", () => {
  const emails = [
    { id: "old", date: "Wed, 21 Dec 2022 06:48:44 +0000", subject: "Your booking", body: "QR1563 DPS-DOH 21 Dec 19:00. QR0009 DOH-LHR 22 Dec 01:50. Booking ZR5LMT2A" },
    { id: "new", date: "2026-10-01T06:31:40Z", subject: "Your order", body: "QZ417 LIS-OPO 9 Oct 14:20 KQ7P2X" },
  ];
  const parsed = [
    { emailIndex: 0, airline: "Qatar Airways", flightNumber: "QR1563", yearStated: false, departure: { airport: "DPS", dateTime: "2026-12-21T19:00:00+08:00" }, arrival: { airport: "DOH", dateTime: "2026-12-22T00:00:00+03:00" }, confirmationCode: "ZR5LMT2A" },
    { emailIndex: 1, airline: "Northwind Airways", flightNumber: "QZ417", yearStated: false, departure: { airport: "LIS", dateTime: "2026-10-09T14:20:00+01:00" }, arrival: { airport: "OPO", dateTime: "2026-10-09T15:10:00+01:00" }, confirmationCode: "KQ7P2X" },
  ];
  const result = reconcileFlights({}, parsed, emails, Date.parse("2026-10-05T00:00:00Z"));
  const keys = result.patches.map(([key]) => key);
  assert.deepEqual(keys, ["flight-QZ417-2026-10-09"], "the 2022 trip is past, so only the real flight is kept");
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
        upsert(row) { op = "upsert"; patch = row; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        gte(k, v) { filters.push((r) => String(r[k]) >= v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        like(k, v) { const re = new RegExp("^" + v.replace(/%/g, ".*") + "$"); filters.push((r) => re.test(r[k])); return q; },
        then(done, fail) {
          if (op === "upsert") { const row = { id: "id" + (rows.length + 1), ...patch }; rows.push(row); return Promise.resolve({ data: [{ id: row.id }], error: null }).then(done, fail); }
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

test("a finished stay dated a year ahead by a host's message heals on the next scan", async () => {
  const Module = require("node:module");
  const day = 86400000, at = (ms) => new Date(ms).toISOString(), now = Date.now();
  const tables = {
    facts: [],
    data_cache: [
      { user_id: "u1", type: "email", external_id: "m-thread", received_at: at(now - 5 * day), data: { subject: "RE: Reservation for Garden studio", body: "See you at check-out. Your stay runs to the day this was sent." } },
      { user_id: "u1", type: "email", external_id: "m-ahead", received_at: at(now - 10 * day), data: { subject: "Reservation confirmed", body: "Lake cabin, check-in in a few weeks" } },
    ],
    bookings: [
      { id: "s1", user_id: "u1", kind: "hotel", provider: "Example Stays", title: "Garden studio", reference: null, starts_at: shiftYears(at(now - 25 * day), 1), ends_at: shiftYears(at(now - 5 * day), 1), source_email_id: "m-thread" },
      { id: "s2", user_id: "u1", kind: "hotel", provider: "Example Stays", title: "Lake cabin", reference: null, starts_at: at(now + 40 * day), ends_at: at(now + 45 * day), source_email_id: "m-ahead" },
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
    await require("../lib/bookings").scanBookings("u1");
  } finally { Module._load = load; delete require.cache[require.resolve("../lib/bookings")]; }
  assert.deepEqual(tables.bookings.map((b) => b.id), ["s2"], "the finished stay goes; the stay ahead stays");
  assert.equal(tables.bookings[0].starts_at, at(now + 40 * day), "and keeps its date");
});

test("a booking is read from the whole email, and dates the email doesn't give are dropped", async () => {
  const Module = require("node:module");
  const day = 86400000, now = Date.now();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const words = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10) + "T14:00:00+07:00";
  const checkIn = now + 5 * day, checkOut = now + 9 * day;
  const stay = `${words(checkIn)} - ${words(checkOut)}, 4 nights, 2 guests`;
  const tables = { facts: [], data_cache: [], bookings: [] };
  // The search hands over a window near the top; the dates sit further down.
  const window = { id: "m1", subject: "Confirmed booking - Example Hostel", from: "Example <hi@example.com>", date: new Date(now - day).toISOString(), body: "Booking Confirmation. Booking Reference 4471-2290" };
  const whole = `Booking Confirmation. Booking Reference 4471-2290. Example Hostel, Harbour Road. ${stay}. Private double room.`;
  let prompt = "";
  const reply = [
    { emailIndex: 0, kind: "hotel", title: "Example Hostel", provider: "Example Hostel", reference: "4471-2290", starts_at: iso(checkIn), ends_at: iso(checkOut), timezone: "Asia/Bangkok", yearStated: true, dates_quote: stay, details: { room: "Private double room" } },
    { emailIndex: 0, kind: "hotel", title: "Example Hostel dorm", provider: "Example Hostel", reference: null, starts_at: iso(checkIn + day), ends_at: iso(checkOut - day), timezone: "Asia/Bangkok", yearStated: true, dates_quote: "3 Mar - 5 Mar, 2 nights", details: { room: "Shared dorm bed" } },
  ];
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /lib\/bookings\.js$/.test(parent.filename)) {
      if (request === "./db") return { supabase: memoryDb(tables) };
      if (request === "./services/data-access") return { searchCache: async () => ({ results: [window] }) };
      if (request === "./llm") return { getInternalClient: () => ({ model: "fixture", client: { messages: { create: async (p) => { prompt = p.messages[0].content; return { content: [{ type: "text", text: JSON.stringify(reply) }] }; } } } }) };
      if (request === "./mail-attachments") return { withWholeBodies: async (_, es) => es.map((e) => ({ ...e, body: whole })), bodyForScan: (_, e) => e.body };
    }
    return load.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve("../lib/bookings")];
    await require("../lib/bookings").scanBookings("u1");
  } finally { Module._load = load; delete require.cache[require.resolve("../lib/bookings")]; }
  assert.match(prompt, /4 nights, 2 guests/, "the reader sees the whole email, not the search window");
  assert.match(prompt, /dates_quote must be COPIED from the email/);
  assert.deepEqual(tables.bookings.map((b) => b.title), ["Example Hostel"], "the stay with dates the email doesn't give is dropped");
});

test("invisible padding at the top of an email is stripped before a reader sees it", () => {
  const src = read("lib/mail-attachments.js");
  const box = {};
  vm.runInNewContext(src.slice(src.indexOf("const INVISIBLE"), src.indexOf("\n}\n", src.indexOf("function readable")) + 3) + "\nthis.readable = readable;", box);
  const padded = "Booking Confirmation " + "\u034f\ufeff ".repeat(300) + "\n\n  You are going\u00a0to Example Hostel";
  assert.equal(box.readable(padded), "Booking Confirmation\nYou are going to Example Hostel");
  const flights = read("lib/flights.js");
  assert.match(flights, /const flightEmails = await withWholeBodies\(userId,/, "the flight reader reads whole emails too");
  assert.doesNotMatch(flights, /filter\(e => !e\.body\)/, "not only when the search result has no body, which it always has");
});
