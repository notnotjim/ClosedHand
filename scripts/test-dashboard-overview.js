const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getDashboardOverview } = require("../lib/dashboard-overview");
const { INTERNAL_TOOLS } = require("../lib/tools/definitions");
const { dashboardUrl } = require("../lib/dashboard-links");
const NOW = Date.parse("2026-09-12T08:00:00Z");
const USER = "owner";
const row = (table, value) => ({ user_id: USER, ...value });
const flight = (number, extra = {}) => ({
  flightNumber: number,
  departure: { airport: "SGN", dateTime: "2026-09-16T20:00:00+07:00" },
  arrival: { airport: "DAD", dateTime: "2026-09-16T21:20:00+07:00" },
  ...extra,
});
function fixture(fail = "") {
  const records = {
    agent_tasks: [row("", { id: "done", title: "Completed lookup", status: "completed" })],
    automations: [],
    schedules: [],
    facts: [
      row("", { key: "flight-old", value: JSON.stringify(flight("VJ646", { supersededBy: "flight-new" })) }),
      row("", { key: "flight-new", value: JSON.stringify({ value: JSON.stringify(flight("VJ648")) }) }),
      { user_id: "someone-else", key: "flight-other", value: JSON.stringify(flight("PRIVATE")) },
    ],
    bookings: [
      row("", { id: "hotel", kind: "hotel", title: "Booked apartment", starts_at: "2026-09-16T07:00:00Z", ends_at: "2026-10-07T04:00:00Z", timezone: "Asia/Ho_Chi_Minh", status: "confirmed" }),
      row("", { id: "ongoing", kind: "hotel", title: "Current stay", starts_at: "2026-09-01T07:00:00Z", ends_at: "2026-09-14T04:00:00Z", timezone: "Asia/Ho_Chi_Minh", status: "confirmed" }),
      row("", { id: "past", kind: "hotel", title: "Expired stay", starts_at: "2026-08-01T07:00:00Z", ends_at: "2026-08-02T04:00:00Z", timezone: "Asia/Ho_Chi_Minh", status: "confirmed" }),
      { user_id: "someone-else", id: "private", kind: "hotel", title: "Private hotel", starts_at: "2026-09-16T07:00:00Z" },
    ],
  };
  const db = { records, calls: [], from(table) {
    db.calls.push(table); let filters = [], count = Infinity;
    const q = {
      select() { return q; }, eq(key, val) { filters.push(r => r[key] === val); return q; },
      like(key, val) { filters.push(r => r[key].startsWith(val.replace("%", ""))); return q; },
      in(key, vals) { filters.push(r => vals.includes(r[key])); return q; },
      order() { return q; }, limit(n) { count = n; return q; },
      or(expr) { const since = expr.split("starts_at.gte.")[1].split(",")[0]; filters.push(r => new Date(r.starts_at) >= new Date(since) || new Date(r.ends_at) >= new Date(since)); return q; },
      then(resolve, reject) {
        return Promise.resolve(table === fail ? { error: { message: "offline" } } :
          { data: records[table].filter(r => filters.every(f => f(r))).slice(0, count) }).then(resolve, reject);
      },
    };
    return q;
  } };
  return db;
}
const getUrl = async (platform, section) => (platform === "web" ? "" : "https://phone.example.com") + "/dashboard#" + section;
const overview = (db, opts = {}) => getDashboardOverview({ db, userId: USER, platform: "whatsapp_linked", now: NOW, getUrl, ...opts });
test("an idle dashboard still has a phone link, flights and hotels despite no reminder tasks", async () => {
  const r = await overview(fixture());
  assert.equal(r.dashboard_url, "https://phone.example.com/dashboard#agents");
  assert.equal(r.schedules_url, "https://phone.example.com/dashboard#schedules");
  assert.equal(r.sections.agents.running_count, 0);
  assert.equal(r.sections.schedules.count, 0);
  assert.equal(r.sections.flights.count, 1);
  assert.equal(r.sections.flights.items[0].flightNumber, "VJ648");
  assert.equal(r.sections.flights.items[0].departure.local_time, "20:00");
  assert.equal(r.sections.flights.items[0].arrival.local_time, "21:20");
  assert.equal(r.sections.bookings.count, 2, "ongoing stays remain visible; past stays are excluded");
  assert.equal(r.sections.bookings.items[0].start_local.local_time, "14:00");
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|Private hotel/);
});
test("one failed section stays unknown while the URL and other sections remain useful", async () => {
  const r = await overview(fixture("bookings"));
  assert.equal(r.sections.bookings.available, false);
  assert.equal(r.sections.bookings.count, null);
  assert.equal(r.sections.bookings.items, null);
  assert.equal(r.sections.flights.count, 1);
  assert.ok(r.dashboard_url);
  assert.deepEqual(r.unavailable, ["bookings"]);
});
test("missing user context never queries another user's data", async () => {
  const db = fixture();
  const r = await overview(db, { userId: null });
  assert.match(r.error, /Missing user/);
  assert.equal(db.calls.length, 0);
});
test("unknown airport zones stay unknown; stale superseded and invalid records cannot invent clocks", async () => {
  const db = fixture();
  db.records.facts.push(row("", { key: "flight-utc", value: JSON.stringify(flight("UTC", { departure: { airport: "XXX", dateTime: "2026-09-16T13:00:00Z" } })) }));
  db.records.facts.push(row("", { key: "flight-broken", value: "invalid" }));
  const r = await overview(db);
  assert.equal(r.sections.flights.items.find(f => f.flightNumber === "UTC").departure.local_time, null);
  assert.equal(r.sections.flights.unreadable_count, 1);
});
test("web keeps a relative link and unavailable phone configuration never becomes localhost", async () => {
  const web = await overview(fixture(), { platform: "web", getUrl: dashboardUrl });
  assert.equal(web.dashboard_url, "/dashboard#agents");
  const noLink = await overview(fixture(), { getUrl: async () => null });
  assert.equal(noLink.dashboard_url, null);
  assert.match(noLink.link_note, /Your phone/);
  const failed = await overview(fixture(), { getUrl: async () => { throw Error("offline"); } });
  assert.match(failed.link_note, /could not be checked/);
});
test("the overview is immediately discoverable, while reminder lookup clearly names its limited scope", () => {
  const tool = INTERNAL_TOOLS.find(t => t.name === "get_dashboard_overview");
  assert.equal(tool.core, true);
  assert.match(tool.description, /flights.*hotel/);
  assert.match(INTERNAL_TOOLS.find(t => t.name === "list_schedules").description, /reminder.*only/);
});

test("Postgres timestamp objects retain the booking's local date and time", async () => {
  const db = fixture();
  db.records.bookings[0].starts_at = new Date("2026-09-16T08:00:00Z");
  db.records.bookings[0].ends_at = new Date("2026-10-07T04:00:00Z");
  const r = await overview(db);
  const b = r.sections.bookings.items.find(b => b.id === "hotel");
  assert.equal(b.start_local.local_date, "2026-09-16");
  assert.equal(b.start_local.local_time, "15:00");
  assert.equal(b.end_local.local_date, "2026-10-07");
});

test("overview dates use the departure airport's today when the server is still yesterday", async () => {
  const db = fixture();
  db.records.facts = [row("", { key: "flight-fixture", value: JSON.stringify(flight("XY829", {
    departure: { airport: "KIX", dateTime: "2026-09-13T10:30:00+09:00", tz: "Asia/Tokyo" }
  })) })];
  const r = await overview(db, { now: Date.parse("2026-09-12T21:40:00Z") });
  assert.equal(r.sections.flights.items[0].departure.local_today, "2026-09-13");
  assert.equal(r.sections.flights.items[0].departure.relative_day, "today");
});
