// lib/services/caldav.js — generic CalDAV calendar client (iCloud, Fastmail,
// Nextcloud, Radicale, ...). Bridge-free calendar for self-hosters: point
// CALDAV_URL at the server (defaults to iCloud), authenticate with the
// account's app-specific password, and the calendar tools light up. tsdav
// does the DAV work; this file speaks just enough ICS for single events.

const { createDAVClient } = require("tsdav");

const CALDAV_URL = process.env.CALDAV_URL || "https://caldav.icloud.com";
const CALDAV_USERNAME = process.env.CALDAV_USERNAME;
const CALDAV_PASSWORD = process.env.CALDAV_PASSWORD;
const CALDAV_CALENDAR = process.env.CALDAV_CALENDAR; // optional display-name filter

// Google speaks CalDAV at this legacy path with an app password (verified
// 2026-08-16: the apidata.googleusercontent.com endpoint answers 401 and only
// takes OAuth; this one answers 207). That matters because it makes ONE app
// password cover mail AND a read-write calendar, so the no-console tier needs
// a single credential rather than a mailbox password plus a scraped iCal URL
// that Google deliberately keeps copy-only.
const GOOGLE_DAV = "https://www.google.com/calendar/dav";

function googleDomain(email) {
  const d = String(email || "").split("@")[1] || "";
  return /(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i.test(d);
}

// Credentials come from env when an operator set them, else from the mailbox
// connection: same account, same app password, one thing for the user to make.
function credentials(userStore) {
  if (CALDAV_USERNAME && CALDAV_PASSWORD) {
    return { url: CALDAV_URL, username: CALDAV_USERNAME, password: CALDAV_PASSWORD };
  }
  const store = userStore || require("../context").activeUserStore;
  const conn = store?.connections?.imap;
  const email = conn?.metadata?.email;
  const password = conn?.tokens?.app_password;
  if (!email || !password) return null;
  const url = conn.config?.caldav_url || (googleDomain(email) ? `${GOOGLE_DAV}/${encodeURIComponent(email)}/user` : null);
  if (!url) return null;
  return { url, username: email, password };
}

function isCalDAVConnected(userStore) {
  return !!credentials(userStore);
}

let _client = null;
let _clientKey = null;
async function getClient(userStore) {
  const creds = credentials(userStore);
  if (!creds) throw new Error("No calendar credentials. Connect a mailbox with an app password, or set CALDAV_USERNAME and CALDAV_PASSWORD.");
  // Re-create the client when the account changes, or a reconnect would keep
  // talking to the previous one.
  const key = `${creds.url}|${creds.username}`;
  if (!_client || _clientKey !== key) {
    _client = await createDAVClient({
      serverUrl: creds.url,
      credentials: { username: creds.username, password: creds.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    _clientKey = key;
    _calendar = null;
  }
  return _client;
}

let _calendar = null;
async function getCalendar(userStore) {
  if (_calendar) return _calendar;
  const dav = await getClient(userStore);
  const calendars = await dav.fetchCalendars();
  // Only event calendars (iCloud also advertises reminder/task collections).
  const usable = calendars.filter((c) => {
    const comps = c.components || [];
    return comps.length === 0 || comps.includes("VEVENT");
  });
  if (!usable.length) throw new Error("No event calendars found on the CalDAV server");
  const named = CALDAV_CALENDAR
    ? usable.find((c) => String(c.displayName || "").toLowerCase() === CALDAV_CALENDAR.toLowerCase())
    : null;
  if (CALDAV_CALENDAR && !named) {
    throw new Error(`Calendar "${CALDAV_CALENDAR}" not found. Available: ${usable.map((c) => c.displayName).filter(Boolean).join(", ")}`);
  }
  _calendar = named || usable[0];
  return _calendar;
}

// --- Minimal ICS handling (single VEVENTs; recurring events show their master) ---

function escapeICS(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function unescapeICS(text) {
  return String(text).replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function toICSDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Parse one field out of unfolded ICS text: "SUMMARY:x", "DTSTART;TZID=...:x".
function icsField(text, name) {
  const m = text.match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

// ICS datetimes come as UTC (…Z), floating, or TZID-qualified; date-only for
// all-day events. Normalise to something ISO-ish without dragging in a
// timezone database: Z passes through, date-only stays a date, anything else
// is returned as written (the model reads it fine).
function icsDateToDisplay(v) {
  if (!v) return null;
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  const m = v.match(/^(\d{8})T(\d{6})(Z?)$/);
  if (m) return `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}${m[3]}`;
  return v;
}

function parseEvent(obj) {
  // Unfold RFC5545 line continuations (CRLF followed by space/tab).
  const text = String(obj.data || "").replace(/\r?\n[ \t]/g, "");
  const vevent = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/);
  if (!vevent) return null;
  const e = vevent[0];
  return {
    summary: unescapeICS(icsField(e, "SUMMARY") || "(no title)"),
    start: icsDateToDisplay(icsField(e, "DTSTART")),
    end: icsDateToDisplay(icsField(e, "DTEND")),
    location: icsField(e, "LOCATION") ? unescapeICS(icsField(e, "LOCATION")) : undefined,
    description: icsField(e, "DESCRIPTION") ? unescapeICS(icsField(e, "DESCRIPTION")).substring(0, 300) : undefined,
    uid: icsField(e, "UID"),
    event_url: obj.url,
  };
}

// --- The four operations the tools use ---

async function listEvents(fromISO, toISO) {
  const dav = await getClient();
  const calendar = await getCalendar();
  const objects = await dav.fetchCalendarObjects({
    calendar,
    timeRange: { start: new Date(fromISO).toISOString(), end: new Date(toISO).toISOString() },
  });
  return objects
    .map(parseEvent)
    .filter(Boolean)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

async function createEvent({ summary, start, end, description, location }) {
  const dav = await getClient();
  const calendar = await getCalendar();
  const uid = `closedhand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ClosedHand//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toICSDate(new Date().toISOString())}`,
    `DTSTART:${toICSDate(start)}`,
    `DTEND:${toICSDate(end)}`,
    `SUMMARY:${escapeICS(summary || "")}`,
    description ? `DESCRIPTION:${escapeICS(description)}` : "",
    location ? `LOCATION:${escapeICS(location)}` : "",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
  await dav.createCalendarObject({ calendar, filename: `${uid}.ics`, iCalString: ics });
  return { uid, calendar: calendar.displayName };
}

async function updateEvent({ event_url, summary, start, end, description, location }) {
  const dav = await getClient();
  const calendar = await getCalendar();
  // tsdav needs the calendar even for a by-url fetch (the old apple.js call
  // omitted it, which is why updates never worked there).
  const objects = await dav.fetchCalendarObjects({ calendar, objectUrls: [event_url] });
  if (!objects.length || !objects[0].data) throw new Error("Event not found");
  let data = String(objects[0].data);
  if (summary) data = data.replace(/^SUMMARY(?:;[^:\r\n]*)?:.*$/m, `SUMMARY:${escapeICS(summary)}`);
  if (start) data = data.replace(/^DTSTART(?:;[^:\r\n]*)?:.*$/m, `DTSTART:${toICSDate(start)}`);
  if (end) data = data.replace(/^DTEND(?:;[^:\r\n]*)?:.*$/m, `DTEND:${toICSDate(end)}`);
  if (description) data = data.replace(/^DESCRIPTION(?:;[^:\r\n]*)?:.*$/m, `DESCRIPTION:${escapeICS(description)}`);
  if (location) data = data.replace(/^LOCATION(?:;[^:\r\n]*)?:.*$/m, `LOCATION:${escapeICS(location)}`);
  await dav.updateCalendarObject({ calendarObject: { url: event_url, data, etag: objects[0].etag } });
  return { updated: true };
}

async function deleteEvent({ event_url }) {
  const dav = await getClient();
  await dav.deleteCalendarObject({ calendarObject: { url: event_url } });
  return { deleted: true };
}

// --- Sync into the shared calendar cache ---
// Events land in the same data_cache shape the Google API sync writes, so
// recall, week views and flight detection treat a CalDAV calendar exactly
// like an API-synced one.
const SYNC_PAST_DAYS = 30;
const SYNC_FUTURE_DAYS = 365;

async function syncCalDAVCalendar(userId, userStore) {
  if (!isCalDAVConnected(userStore)) return;
  const from = new Date(Date.now() - SYNC_PAST_DAYS * 86400000);
  const to = new Date(Date.now() + SYNC_FUTURE_DAYS * 86400000);

  const dav = await getClient(userStore);
  const calendar = await getCalendar(userStore);
  const objects = await dav.fetchCalendarObjects({
    calendar,
    timeRange: { start: from.toISOString(), end: to.toISOString() },
  });

  const label = calendar.displayName || "Calendar";
  const items = [];
  for (const obj of objects) {
    const e = parseEvent(obj);
    if (!e || !e.start) continue;
    const uid = e.uid || e.id || obj.url;
    items.push({
      external_id: String(uid),
      id: String(uid),
      summary: e.summary || "(untitled)",
      start: e.start,
      end: e.end || e.start,
      location: e.location || "",
      description: String(e.description || "").substring(0, 2000),
      attachments: [],
      attendees: [],
      status: (e.status || "confirmed").toLowerCase(),
      calendar: label,
      uid: String(uid),
      date: e.start,
    });
  }

  const { upsertCacheItems, reconcileDeletedEvents } = require("./data-sync");
  await upsertCacheItems(userId, "caldav", "event", items);
  await reconcileDeletedEvents(userId, "caldav", items, from, to, null);
  console.log(`[data-sync] CalDAV(${label}): synced ${items.length} events for ${userId}`);
  return items.length;
}

module.exports = { isCalDAVConnected, listEvents, createEvent, updateEvent, deleteEvent, syncCalDAVCalendar };
