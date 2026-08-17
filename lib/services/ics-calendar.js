// lib/services/ics-calendar.js — read-only calendar sync from a secret ICS feed.
//
// The zero-project calendar tier: Google Calendar (and most others) publish a
// private "secret address in iCal format". Polling that URL needs no OAuth and
// no Google Cloud project, and events land in the same data_cache/vector
// pipeline as API-synced calendars, so recall, week views and flight detection
// work identically. Read-only by nature: event WRITES stay wizard-tier.

const ical = require("node-ical");
const { isBlockedUrl } = require("../ssrf");

const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 365;
const MAX_OCCURRENCES_PER_EVENT = 100;

function attendeeList(att) {
  if (!att) return [];
  const arr = Array.isArray(att) ? att : [att];
  return arr.map((a) => {
    if (typeof a === "string") return { email: a.replace(/^mailto:/i, ""), name: "", status: "" };
    const val = String(a.val || "").replace(/^mailto:/i, "");
    return { email: val, name: a.params?.CN || "", status: (a.params?.PARTSTAT || "").toLowerCase() };
  }).filter((a) => a.email || a.name);
}

// Map parsed VEVENTs to the exact cached-event shape the calendar pipeline
// expects (see syncGoogleCalendar): readers and the indexer are source-agnostic
// as long as these fields line up.
function eventsFromIcs(parsed, calendarLabel) {
  const now = Date.now();
  const windowStart = new Date(now - WINDOW_PAST_DAYS * 86400000);
  const windowEnd = new Date(now + WINDOW_FUTURE_DAYS * 86400000);
  const items = [];

  for (const key of Object.keys(parsed)) {
    const ev = parsed[key];
    if (!ev || ev.type !== "VEVENT" || !ev.start) continue;

    const durationMs = ev.end ? (new Date(ev.end) - new Date(ev.start)) : 0;
    const base = {
      summary: ev.summary || "(untitled)",
      location: ev.location || "",
      description: (ev.description || "").substring(0, 2000),
      attachments: [],
      attendees: attendeeList(ev.attendee),
      status: (ev.status || "confirmed").toLowerCase(),
      calendar: calendarLabel,
      uid: ev.uid || key,
    };

    if (ev.rrule) {
      // Recurring: expand real occurrences inside the window, honouring
      // exceptions. Each occurrence is its own cache row, like the API sync's
      // singleEvents=true expansion.
      let occurrences = [];
      try { occurrences = ev.rrule.between(windowStart, windowEnd, true).slice(0, MAX_OCCURRENCES_PER_EVENT); } catch (_) {}
      const exdates = new Set(Object.keys(ev.exdate || {}).map((d) => new Date(ev.exdate[d]).toISOString().substring(0, 10)));
      for (const occ of occurrences) {
        const startIso = new Date(occ).toISOString();
        if (exdates.has(startIso.substring(0, 10))) continue;
        // Recurrence overrides (a moved single instance) arrive as separate
        // VEVENTs with their own recurrence-id; node-ical exposes them under
        // ev.recurrences keyed by date.
        const override = ev.recurrences && ev.recurrences[startIso.substring(0, 10)];
        const src = override || ev;
        const s = override ? new Date(override.start) : new Date(occ);
        const e = override && override.end ? new Date(override.end) : new Date(s.getTime() + durationMs);
        items.push({
          ...base,
          summary: src.summary || base.summary,
          location: src.location || base.location,
          status: (src.status || base.status).toLowerCase(),
          external_id: `${base.uid}-${startIso.substring(0, 10)}`,
          id: `${base.uid}-${startIso.substring(0, 10)}`,
          start: s.toISOString(),
          end: e.toISOString(),
          date: s.toISOString(),
        });
      }
      continue;
    }

    const start = new Date(ev.start);
    if (start < windowStart || start > windowEnd) continue;
    const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + durationMs);
    items.push({
      ...base,
      external_id: base.uid,
      id: base.uid,
      start: start.toISOString(),
      end: end.toISOString(),
      date: start.toISOString(),
    });
  }
  return items;
}

async function fetchIcsText(icsUrl) {
  if (!/^https:\/\//i.test(icsUrl)) throw new Error("ICS URL must be https");
  if (isBlockedUrl(icsUrl)) throw new Error("ICS URL points at a private address");
  const res = await fetch(icsUrl, { redirect: "follow", headers: { "User-Agent": "ClosedHand/1.0" } });
  if (!res.ok) throw new Error(`ICS fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("URL did not return an iCalendar feed");
  return text;
}

// Sync one user's ICS calendar connection into data_cache. Mirrors the shape
// of syncGoogleCalendar closely enough that everything downstream is shared.
async function syncIcsCalendar(userId, userStore) {
  const conn = userStore.getConnection("ics_calendar");
  const icsUrl = conn?.tokens?.ics_url;
  if (!icsUrl) return;

  const label = conn.metadata?.label || "Calendar (ICS)";
  const text = await fetchIcsText(icsUrl);
  const parsed = await ical.async.parseICS(text);
  const items = eventsFromIcs(parsed, label);

  const { upsertCacheItems, reconcileDeletedEvents } = require("./data-sync");
  await upsertCacheItems(userId, "ics", "event", items);
  // The feed is the whole calendar, so anything cached but absent was deleted.
  const windowStart = new Date(Date.now() - WINDOW_PAST_DAYS * 86400000);
  const windowEnd = new Date(Date.now() + WINDOW_FUTURE_DAYS * 86400000);
  await reconcileDeletedEvents(userId, "ics", items, windowStart, windowEnd, null);
  console.log(`[data-sync] ICS: synced ${items.length} events for ${userId}`);
  return items.length;
}

module.exports = { syncIcsCalendar, eventsFromIcs, fetchIcsText };
