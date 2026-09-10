// lib/bookings.js — upcoming bookings, picked out of mail the way flights are.
//
// Trains, hotels, event tickets, restaurant tables, hire cars: things with a
// booking reference and a time. The scanner reads recent confirmation-shaped
// emails from the cache, asks the internal model for structured details,
// keeps only what the email actually says (a reference that is not in the
// text is dropped, as with flight numbers), and upserts by a dedupe key so a
// second pass over the same email changes nothing. Flights are left to
// lib/flights.js, which tracks them live. Meetings and calls are not
// bookings: the calendar has those, and the dashboard is not a second one.

const { supabase } = require("./db");
const { getInternalClient } = require("./llm");
const { searchCache } = require("./services/data-access");

const KINDS = ["train", "hotel", "event", "restaurant", "car", "ferry", "bus", "other"];
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_SCAN_DELAY_MS = 3 * 60 * 1000;

function dedupeKeyFor(b) {
  const day = String(b.starts_at || "").slice(0, 10);
  const ref = String(b.reference || "").replace(/\s+/g, "").toUpperCase();
  const base = ref || String(b.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  return `${b.kind}:${base}:${day}`;
}

// Emails worth reading: confirmation-shaped, recent, not flights.
async function candidateEmails(userId) {
  const r = await searchCache(userId, {
    query: "booking OR reservation OR confirmation OR ticket OR e-ticket OR tickets OR itinerary OR check-in OR your stay OR your order OR reserved OR your table OR your seats OR your journey",
    days: 120,
    max_results: 40,
    scope: "all",
  });
  const emails = (r && r.results) || [];
  return emails
    .filter((e) => e.id && (e.summary || e.body))
    .filter((e) => !/\b(flight|boarding pass|airline|airways)\b/i.test(String(e.subject || "")))
    .slice(0, 40)
    .map((e, i) => ({ emailIndex: i, id: e.id, subject: e.subject || "", from: e.from || "", date: e.date || "", body: String(e.summary || e.body || "").slice(0, 2200) }));
}

async function extract(userId, emailBodies) {
  if (!emailBodies.length) return [];
  const { client: llm, model } = getInternalClient(userId);
  const year = new Date().getFullYear();
  const resp = await llm.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: "user", content: `Extract confirmed bookings from these ${emailBodies.length} emails. Return ONLY a JSON array, no markdown. One object per booking:
{ "emailIndex": 0, "kind": "train|hotel|event|restaurant|car|ferry|bus|other", "title": "short human title, e.g. 'London Euston to Manchester Piccadilly' or 'The Ritz, 2 nights' or 'Radiohead at the O2'", "provider": "company or venue", "reference": "booking reference COPIED from the email, or null", "starts_at": "ISO 8601 WITH the local UTC offset", "ends_at": "ISO 8601 with offset, or null (hotel check-out, event end, return leg)", "timezone": "IANA zone, e.g. Europe/London", "location": "station, address or venue", "details": { "from": "...", "to": "...", "seat": "...", "room": "...", "guests": 2, "check_in_url": "...", "cancel_by": "ISO or null", "notes": "one line that matters at the door" } }

Rules:
- Only bookings that are CONFIRMED and have a date. Skip marketing, receipts for goods, price alerts, reminders to book, cancellations (return them with "status":"cancelled" only if the email says the booking is cancelled).
- Skip flights entirely; they are handled elsewhere.
- reference must be COPIED from the email text. If the email shows no reference, use null. Never invent one.
- Times in the email are local to the place. starts_at MUST carry that place's UTC offset. The current year is ${year}; if no year is stated use ${year} or the next occurrence.
- A hotel stay is one booking with starts_at = check-in and ends_at = check-out. A return train is two bookings with the same emailIndex.
- emailIndex is the position in the list below.

Emails:
${JSON.stringify(emailBodies)}` }],
  });
  let text = (resp.content && resp.content[0] && resp.content[0].text || "").trim();
  text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    console.error("[bookings] extraction did not parse");
    return [];
  }
}

async function scanBookings(userId) {
  const emails = await candidateEmails(userId);
  if (!emails.length) return { scanned: 0, found: 0, new: 0 };
  let parsed = [];
  try { parsed = await extract(userId, emails); } catch (e) { console.error("[bookings] extraction failed:", e.message); return { scanned: emails.length, found: 0, new: 0, error: e.message }; }

  const rows = [];
  for (const b of parsed) {
    if (!b || !b.kind || !b.title || !b.starts_at) continue;
    const kind = KINDS.includes(String(b.kind).toLowerCase()) ? String(b.kind).toLowerCase() : "other";
    const start = new Date(b.starts_at);
    if (isNaN(start.getTime())) continue;
    if (start.getTime() < Date.now() - 6 * 3600000 && !b.ends_at) continue;
    const src = emails[b.emailIndex];
    const srcText = `${src ? src.subject : ""} ${src ? src.body : ""}`.toUpperCase().replace(/[\s-]+/g, "");
    let reference = b.reference ? String(b.reference).trim() : null;
    if (reference && !srcText.includes(reference.toUpperCase().replace(/[\s-]+/g, ""))) {
      console.log(`[bookings] dropping reference ${reference}: not in the source email`);
      reference = null;
    }
    const row = {
      user_id: userId,
      kind,
      title: String(b.title).slice(0, 160),
      provider: b.provider ? String(b.provider).slice(0, 120) : null,
      reference,
      starts_at: start.toISOString(),
      ends_at: b.ends_at && !isNaN(new Date(b.ends_at).getTime()) ? new Date(b.ends_at).toISOString() : null,
      timezone: b.timezone ? String(b.timezone).slice(0, 64) : null,
      location: b.location ? String(b.location).slice(0, 200) : null,
      details: b.details && typeof b.details === "object" ? b.details : {},
      status: b.status === "cancelled" ? "cancelled" : "confirmed",
      source_email_id: src ? src.id : null,
      updated_at: new Date().toISOString(),
    };
    row.dedupe_key = dedupeKeyFor(row);
    rows.push(row);
  }
  if (!rows.length) return { scanned: emails.length, found: 0, new: 0 };

  const { data: existing } = await supabase.from("bookings").select("dedupe_key").eq("user_id", userId).in("dedupe_key", rows.map((r) => r.dedupe_key));
  const known = new Set((existing || []).map((r) => r.dedupe_key));
  const fresh = rows.filter((r) => !known.has(r.dedupe_key));
  const { error } = await supabase.from("bookings").upsert(rows, { onConflict: "user_id,dedupe_key" });
  if (error) { console.error("[bookings] upsert failed:", error.message); return { scanned: emails.length, found: rows.length, new: 0, error: error.message }; }
  if (fresh.length) console.log(`[bookings] ${fresh.length} new: ${fresh.map((r) => r.kind + " " + r.title).join("; ")}`);
  return { scanned: emails.length, found: rows.length, new: fresh.length, added: fresh.map((r) => ({ kind: r.kind, title: r.title, starts_at: r.starts_at })) };
}

async function listUpcoming(userId, { days = 120, includePast = false } = {}) {
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  let q = supabase.from("bookings").select("*").eq("user_id", userId).lte("starts_at", new Date(Date.now() + days * 86400000).toISOString()).order("starts_at", { ascending: true });
  if (!includePast) q = q.or(`starts_at.gte.${since},ends_at.gte.${since}`);
  const { data, error } = await q;
  if (error) { console.error("[bookings] list failed:", error.message); return []; }
  return data || [];
}

async function removeBooking(userId, id) {
  const { error } = await supabase.from("bookings").delete().eq("user_id", userId).eq("id", id);
  if (error) console.error("[bookings] delete failed:", error.message);
  return !error;
}

// Old bookings drop off after a month so the table does not grow forever.
async function cleanupPast(userId) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const { error } = await supabase.from("bookings").delete().eq("user_id", userId).lt("starts_at", cutoff).or(`ends_at.is.null,ends_at.lt.${cutoff}`);
  if (error) console.error("[bookings] cleanup failed:", error.message);
}

let _timer = null;
function startBookingsDiscovery() {
  if (_timer) return;
  const { UserStore } = require("../user-store");
  const pass = async () => {
    try {
      const users = await UserStore.getActiveUsers();
      for (const u of users) {
        try { await cleanupPast(u.userId); await scanBookings(u.userId); } catch (e) { console.error(`[bookings] pass failed for ${String(u.userId).slice(0, 8)}:`, e.message); }
      }
    } catch (e) { console.error("[bookings] discovery pass failed:", e.message); }
  };
  setTimeout(pass, FIRST_SCAN_DELAY_MS).unref();
  _timer = setInterval(pass, SCAN_INTERVAL_MS);
  _timer.unref();
  console.log("Bookings: discovery every 6h");
}

module.exports = { scanBookings, listUpcoming, removeBooking, cleanupPast, startBookingsDiscovery, KINDS };
