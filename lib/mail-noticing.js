// lib/mail-noticing.js — a confirmation is noted when it arrives, not on a timer.
//
// A person who books a flight and sees the confirmation land reads it then
// and there and adds the flight to their picture of the trip. The scanners
// used to run on a six-hour timer, and only for someone with no flight in
// the air, so a second booking made during a trip waited hours or was
// missed. This runs right after a sync that brought new mail: the new rows
// are prefiltered with a regex (marketing mail costs nothing), and only
// confirmation-shaped ones go to the flight and booking scanners, which
// are handed those emails directly instead of searching the cache again.

const { supabase } = require("./db");

const CONFIRMATION_RE = /\b(booking|reservation|confirm|itinerar|e-?ticket|boarding|check-?in|your (stay|order|trip|journey|flight|seats|table))\b/i;
const MAX_NEW = 60;

// Reads the emails cached for this user since `sinceMs` and scans the ones
// that look like confirmations. Returns { flights, bookings } counts.
async function noticeNewMail(userId, sinceMs) {
  const { data: rows, error } = await supabase
    .from("data_cache")
    .select("source, data")
    .eq("user_id", userId)
    .eq("type", "email")
    .gte("created_at", new Date(sinceMs).toISOString())
    .order("created_at", { ascending: false })
    .limit(MAX_NEW);
  if (error) { console.error("[noticing] could not read new mail:", error.message); return { flights: 0, bookings: 0 }; }
  const emails = (rows || [])
    .map((r) => ({ ...r.data, source: r.source }))
    .filter((e) => e.id && CONFIRMATION_RE.test(`${e.subject || ""} ${String(e.body || "").slice(0, 1500)}`));
  if (!emails.length) return { flights: 0, bookings: 0 };

  const ctx = require("./context");
  const { UserStore } = require("../user-store");
  const { swapToCloudStore, saveStore, cleanupUserContext } = require("./storage");
  const { acquireUserMutex } = require("./user-mutex");
  let flights = 0, bookings = 0;
  await acquireUserMutex(userId, () => ctx.runWithInheritedContext(async () => {
    const userStore = await UserStore.load(userId);
    swapToCloudStore(userStore, userId, userId);
    try {
      const found = await require("./flights").scanEmailsForFlights(userId, { emails });
      if (found.length) {
        saveStore();
        flights = found.length;
        await require("./flights-scheduler").announceNewFlights(userId, userStore, found);
      }
      const b = await require("./bookings").scanBookings(userId, { emails });
      bookings = b.new || 0;
    } finally {
      cleanupUserContext();
    }
  }));
  if (flights || bookings) console.log(`[noticing] ${String(userId).slice(0, 8)}: ${emails.length} confirmation-shaped mail(s), ${flights} flight(s), ${bookings} booking(s) noted`);
  return { flights, bookings };
}

module.exports = { noticeNewMail, CONFIRMATION_RE };
