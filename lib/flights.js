// lib/flights.js — Flight tracking (Flighty-like)
// Detects flight bookings from email, tracks live status via FlightAware AeroAPI,
// sends proactive updates, delivers boarding passes, and pins flight details.

const ctx = require("./context");
const { getInternalClient } = require("./llm");
const { httpGet } = require("./http");
const { sendToPlatform, sendDocumentToPlatform, pinMessage, unpinMessage } = require("./messaging");
const { saveStore } = require("./storage");
const { isGoogleConnected, googleApiRequest } = require("./services/google");
const { isMicrosoftConnected } = require("./services/microsoft");
const { searchCache } = require("./services/data-access");

const FLIGHTAWARE_BASE = "https://aeroapi.flightaware.com/aeroapi";

// --- Note metadata helpers ---
// Notes may be plain strings (legacy) or metadata objects {value, created, ...}.
// Flight notes store JSON-stringified flight data as the value.

function _getNoteValue(note) {
  if (typeof note === "object" && note !== null && note.value !== undefined) return note.value;
  return note;
}

function _setNoteValue(key, jsonStr) {
  const existing = ctx.store.facts[key];
  const now = new Date().toISOString();
  if (existing && typeof existing === "object" && existing.value !== undefined) {
    // Preserve metadata wrapper
    existing.value = jsonStr;
    existing.lastAccessed = now;
  } else {
    // Create new metadata wrapper
    ctx.store.facts[key] = { value: jsonStr, created: now, lastAccessed: now, accessCount: 0 };
  }
}

// --- FlightAware API helper ---

async function flightAwareGet(path) {
  const apiKey = process.env.FLIGHTAWARE_API_KEY;
  if (!apiKey) return { error: "FLIGHTAWARE_API_KEY not configured" };

  try {
    const url = `${FLIGHTAWARE_BASE}/${path}`;
    const { statusCode, body } = await httpGet(url, { "x-apikey": apiKey });

    if (statusCode === 429) return { error: "FlightAware rate limit exceeded" };
    if (statusCode === 404) return { error: "Flight not found" };
    if (statusCode >= 400) return { error: `FlightAware API error (${statusCode})` };

    return JSON.parse(body);
  } catch (e) {
    console.error("FlightAware API error:", e.message);
    return { error: `FlightAware request failed: ${e.message}` };
  }
}

// --- Email scanning ---

// Text of one PDF attachment, read-only (no attachments-store write, unlike
// fetch_attachment). Same account walk as fetchAttachmentFn: the message only
// exists on the account that holds it, the source tag is often the primary,
// and the wrong account fails fast.
async function pdfAttachmentText(email, att) {
  try {
    if (email.source === "imap") {
      const { fetchImapAttachment } = require("./services/imap-mail");
      const { buffer } = await fetchImapAttachment(ctx.activeUserStore, email.id, att.attachmentId);
      const parsed = await require("pdf-parse")(buffer, { max: 5 });
      return (parsed.text || "").replace(/\s+/g, " ").trim().substring(0, 3000);
    }
    if (!/^gmail(_|$)/.test(email.source || "")) return "";
    const { serviceKeyForSourceTag, listGoogleAccounts } = require("./services/google");
    const firstKey = serviceKeyForSourceTag(email.source);
    const keys = [firstKey, ...listGoogleAccounts(ctx.activeUserStore).map(a => a.serviceKey).filter(k => k !== firstKey)];
    for (const key of keys) {
      try {
        const attData = await googleApiRequest("GET",
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${email.id}/attachments/${att.attachmentId}`,
          null, null, key);
        if (attData?.data) {
          const parsed = await require("pdf-parse")(Buffer.from(attData.data, "base64url"), { max: 5 });
          return (parsed.text || "").replace(/\s+/g, " ").trim().substring(0, 3000);
        }
      } catch (_) { /* wrong account or bad PDF: try the next account */ }
    }
  } catch (e) {
    console.log(`Flight scan: PDF read failed for ${att.filename || att.attachmentId}: ${e.message}`);
  }
  return "";
}

async function scanEmailsForFlights(userId) {
  // Use Sentinel to search across all connected email sources
  const { isImapConnected } = require("./services/imap-mail");
  // IMAP was missing here, so a self-hosted install with an app password
  // returned no flights at all: not a worse scan, no scan.
  const hasAnySources = isGoogleConnected() || isMicrosoftConnected() || !!ctx.bridgeConnected || isImapConnected();
  if (!hasAnySources) return [];

  const searchResult = await searchCache(userId, {
    query: "booking OR confirmation OR itinerary OR e-ticket OR boarding OR reservation OR flight OR trip",
    days: 180,
    max_results: 30,
    scope: "all",
  });

  const emails = searchResult.results || [];
  if (emails.length === 0) return [];

  // Gather existing flight note keys for dedup
  const existingKeys = new Set(
    Object.keys(ctx.store.facts).filter(k => k.startsWith("flight-"))
  );

  // Collect email bodies for batch extraction
  const flightEmails = emails.filter(e => e.id && (e.summary || e.body));
  const emailBodies = flightEmails.map((e, idx) => ({
    emailIndex: idx,
    id: e.id,
    subject: e.subject || "",
    body: (e.summary || e.body || "").substring(0, 2000),
  }));

  if (emailBodies.length === 0) return [];

  // Agency bookings (Mytrip, 2026-08-12) often put the flight numbers ONLY in
  // the attached receipt or e-ticket PDF: the body names route and times but
  // no flight, and an extractor forced to fill the field invents a plausible
  // number instead. When the text carries nothing that looks like one, read
  // the email's PDFs so extraction works from what the booking actually says.
  // Bounded: this scan runs at most every 6h and only with no tracked flight,
  // and PDFs are fetched only for number-less emails, two per email, 5MB cap.
  const FLIGHT_NUM_RE = /\b(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{2,4}\b/;
  for (const eb of emailBodies) {
    if (FLIGHT_NUM_RE.test(`${eb.subject} ${eb.body}`)) continue;
    const src = flightEmails[eb.emailIndex];
    const pdfs = (src.attachments || [])
      .filter(a => !a.inline && (/pdf/i.test(a.mimeType || "") || /\.pdf$/i.test(a.filename || "")) && (a.size || 0) < 5 * 1024 * 1024)
      .slice(0, 2);
    for (const att of pdfs) {
      const text = await pdfAttachmentText(src, att);
      if (text) eb.body += ` [attached ${att.filename || "PDF"}]: ${text}`;
    }
  }

  // ONE batched Haiku call instead of per-email calls
  const currentYear = new Date().getFullYear();
  let allParsedFlights = [];
  try {
    const { client: llm, model: fastModel } = getInternalClient(userId);
    const extraction = await llm.messages.create({
      model: fastModel,
      max_tokens: 4096,
      messages: [{ role: "user", content: `Extract flight booking details from these ${emailBodies.length} emails. For each email that contains flight details, return a JSON object. Return a JSON array of results. Skip emails with no flight details. Do NOT invent or guess. Return ONLY valid JSON, no markdown, no code fences.\n\nFormat per flight: { "emailIndex": 0, "airline": "...", "flightNumber": "...", "departure": { "airport": "IATA code", "dateTime": "ISO 8601 WITH the airport's UTC offset" }, "arrival": { "airport": "IATA code", "dateTime": "ISO 8601 WITH the airport's UTC offset" }, "confirmationCode": "...", "passengerName": "..." }\n\nIMPORTANT:\n- The current year is ${currentYear}. If an email does not state a year, use ${currentYear}.\n- Airport fields must be 3-letter IATA codes (LHR, JFK, PVG), not city names.
- flightNumber and airline must be COPIED from the email text. Many booking emails (agencies like Mytrip) state routes and times but no flight number: for those return "flightNumber": null. NEVER supply a plausible flight number the email does not contain; a wrong one corrupts live tracking.\n- Times in emails are LOCAL to the airport. dateTime MUST carry the airport's UTC offset (e.g. a 01:25 departure from Singapore is "2026-07-28T01:25:00+08:00", never "2026-07-28T01:25:00" or with Z). Work out the offset from the airport.\n- If one email has multiple flights (outbound + return), return separate objects with the same emailIndex.\n- emailIndex corresponds to the position in the array below.\n\nEmails:\n${JSON.stringify(emailBodies)}` }],
    });

    let text = extraction.content[0]?.text?.trim();
    if (text) {
      text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
      try {
        allParsedFlights = JSON.parse(text);
        if (!Array.isArray(allParsedFlights)) allParsedFlights = [allParsedFlights];
      } catch {
        console.error("Flight scan: failed to parse batch Haiku response");
        allParsedFlights = [];
      }
    }
  } catch (e) {
    console.error("Flight scan: batch Haiku call failed:", e.message);
  }

  const newFlights = [];
  for (const flight of allParsedFlights) {
    if (!flight || !flight.flightNumber || !flight.departure?.dateTime) continue;

    const depDate = new Date(flight.departure.dateTime);
    if (isNaN(depDate.getTime())) continue;

    // Never track/announce flights that already departed (6h grace for in-air).
    // Without this, cleanupExpiredFlights deletes the note and the next scan
    // re-detects the same old email: endless duplicate notifications (2026-07-19).
    if (depDate.getTime() < Date.now() - 6 * 3600000) continue;

    const dateStr = depDate.toISOString().split("T")[0];
    const flightNum = flight.flightNumber.replace(/\s+/g, "");
    const noteKey = `flight-${flightNum}-${dateStr}`;

    // Trust nothing the email cannot back up: an extractor asked for a
    // flightNumber field will invent a plausible one when the email has none
    // (MM774 for a Mytrip KIX-OKA booking, 2026-08-12), and every later
    // FlightAware lookup then tracks someone else's flight. The number must
    // literally appear in the email it was read from.
    const srcEmail = emailBodies[flight.emailIndex];
    const srcText = `${srcEmail?.subject || ""} ${srcEmail?.body || ""}`.toUpperCase().replace(/[\s-]+/g, "");
    if (!srcText.includes(flightNum.toUpperCase())) {
      console.log(`Flight scan: dropping ${flightNum} — number not present in source email ${srcEmail?.id || "?"}`);
      continue;
    }

    if (existingKeys.has(noteKey)) continue;
    // Same flight can compute to a neighbouring date (timezone offsets, red-eyes):
    // dedup by flight number within +/-1 day, matching the calendar scanner
    const nearDupe = [...existingKeys].some(k => {
      const parts = k.split("-");
      if (parts[1] !== flightNum) return false;
      const kDate = new Date(parts.slice(2).join("-"));
      return !isNaN(kDate.getTime()) && Math.abs(kDate - depDate) < 2 * 86400000;
    });
    if (nearDupe) continue;

    // Map emailIndex back to email ID
    const emailId = emailBodies[flight.emailIndex]?.id || "";

    const noteData = {
      airline: flight.airline || "",
      flightNumber: flight.flightNumber,
      departure: flight.departure,
      arrival: flight.arrival || {},
      confirmationCode: flight.confirmationCode || "",
      passengerName: flight.passengerName || "",
      emailId,
      detected: new Date().toISOString(),
      landed: false,
      lastStatus: null,
      lastGate: null,
      lastDelay: null,
      pinMessageIds: {},
    };

    _setNoteValue(noteKey, JSON.stringify(noteData));
    existingKeys.add(noteKey);
    newFlights.push({ key: noteKey, ...noteData });
  }

  if (newFlights.length > 0) saveStore();
  return newFlights;
}

/**
 * Detect flights from calendar events, zero LLM. Events titled like
 * "Flight to Dubai (EK 36)" carry the flight number and departure time directly;
 * the email scanner misses bookings whose confirmation emails are old or vague,
 * but the calendar is ground truth for what the user is actually flying.
 */
async function scanCalendarForFlights(userId) {
  const { supabase } = require("../user-store");
  const horizon = new Date(Date.now() + 60 * 86400000).toISOString();
  const { data: events } = await supabase
    .from("data_cache")
    .select("received_at, data->>summary")
    .eq("user_id", userId)
    .eq("type", "event")
    .gte("received_at", new Date(Date.now() - 6 * 3600000).toISOString())
    .lte("received_at", horizon)
    .limit(100);

  const existingKeys = Object.keys(ctx.store.facts).filter(k => k.startsWith("flight-"));
  const newFlights = [];

  for (const ev of (events || [])) {
    const title = ev.summary || "";
    // "Flight to Osaka (MM 774)" -> airline code + number; require "flight" in the title
    const m = /flight/i.test(title) && title.match(/\(([A-Z][A-Z0-9])\s*(\d{1,4})\)/);
    if (!m) continue;
    const flightNumber = `${m[1]}${m[2]}`;
    const depDate = new Date(ev.received_at);
    if (isNaN(depDate.getTime())) continue;
    const dateStr = depDate.toISOString().split("T")[0];
    const noteKey = `flight-${flightNumber}-${dateStr}`;

    // Dedup by flight number within +/-1 day: the email scanner may date the same
    // flight a day off (timezones/red-eyes), and double-tracking means double alerts
    const dupe = existingKeys.some(k => {
      const parts = k.split("-");
      if (parts[1] !== flightNumber) return false;
      const kDate = new Date(parts.slice(2).join("-"));
      return !isNaN(kDate.getTime()) && Math.abs(kDate - depDate) < 2 * 86400000;
    });
    if (dupe) continue;

    const destMatch = title.match(/flight to ([^(]+)\(/i);
    const noteData = {
      airline: "",
      flightNumber,
      departure: { airport: "", dateTime: depDate.toISOString() },
      arrival: { airport: (destMatch ? destMatch[1].trim() : "") },
      confirmationCode: "",
      passengerName: "",
      emailId: "",
      detected: new Date().toISOString(),
      source: "calendar",
      landed: false,
      lastStatus: null,
      lastGate: null,
      lastDelay: null,
      pinMessageIds: {},
    };

    // One FlightAware call per NEW flight: the calendar title lacks origin
    // airport and precise times; the API knows both from the flight number
    try {
      let st = await getFlightStatus(flightNumber, depDate.toISOString());
      if (st.error) st = await getScheduledFlight(flightNumber, depDate.toISOString());
      if (!st.error) {
        if (st.origin) noteData.departure.airport = st.origin;
        if (st.destination) noteData.arrival.airport = st.destination;
        if (st.scheduledOut) noteData.departure.dateTime = st.scheduledOut;
        if (st.scheduledIn) noteData.arrival.dateTime = st.scheduledIn;
        if (st.aircraftType) noteData.aircraftType = st.aircraftType;
      }
    } catch (_) {}

    // Calendar events carry no booking reference: dig the original booking
    // email for this specific flight number (one small extraction call)
    try {
      const extra = await _digEmailForFlight(userId, flightNumber);
      if (extra) {
        if (extra.confirmationCode) noteData.confirmationCode = extra.confirmationCode;
        if (extra.passengerName) noteData.passengerName = extra.passengerName;
        if (extra.airline && !noteData.airline) noteData.airline = extra.airline;
      }
    } catch (_) {}

    _setNoteValue(noteKey, JSON.stringify(noteData));
    existingKeys.push(noteKey);
    newFlights.push({ key: noteKey, ...noteData });
  }

  if (newFlights.length > 0) saveStore();
  return newFlights;
}

function _extractPlainBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  for (const part of (payload.parts || [])) {
    const r = _extractPlainBody(part);
    if (r) return r;
  }
  return "";
}

/** Targeted email search for one flight's booking details. Returns {confirmationCode, passengerName, airline} or null. */
async function _digEmailForFlight(userId, flightNumber) {
  const searchResult = await searchCache(userId, {
    query: `${flightNumber} OR booking confirmation ${flightNumber}`,
    days: 365,
    max_results: 5,
    scope: "all",
  }).catch(() => null);
  let emails = (searchResult?.results || []).filter(e => e.summary || e.body).slice(0, 3);

  // The cache only holds the most recent ~500 inbox messages; older booking
  // emails need a live Gmail search (free API, sees the whole mailbox).
  // Checks every connected Google account, bookings often land in a second inbox.
  // IMAP SEARCH is server-side too, so the same "look past the window" trick
  // works without a Google project.
  if (emails.length === 0) {
    try {
      const { searchImapMailbox, isImapConnected } = require("./services/imap-mail");
      if (isImapConnected()) {
        const live = await searchImapMailbox(ctx.activeUserStore, flightNumber, { limit: 3 });
        if (live.length) emails = live;
      }
    } catch (e) { console.log(`Flight dig: IMAP search failed: ${e.message}`); }
  }

  if (emails.length === 0 && isGoogleConnected()) {
    const { listGoogleAccounts } = require("./services/google");
    for (const acct of listGoogleAccounts(ctx.activeUserStore)) {
      if (emails.length > 0) break;
      try {
        const list = await googleApiRequest("GET",
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=3&q=${encodeURIComponent(flightNumber)}`,
          null, null, acct.serviceKey);
        for (const m of (list.messages || []).slice(0, 3)) {
          const msg = await googleApiRequest("GET",
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
            null, null, acct.serviceKey);
          const headers = msg.payload?.headers || [];
          const subject = (headers.find(h => h.name === "Subject") || {}).value || "";
          emails.push({ subject, body: (msg.snippet || "") + "\n" + _extractPlainBody(msg.payload).substring(0, 3000) });
        }
      } catch (e) {
        console.log(`Flights: live Gmail dig failed for ${flightNumber} (${acct.serviceKey}): ${e.message}`);
      }
    }
  }

  // Same live fallback for Outlook mailboxes
  if (emails.length === 0 && isMicrosoftConnected()) {
    try {
      const { microsoftApiRequest } = require("./services/microsoft");
      const list = await microsoftApiRequest("GET",
        `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(flightNumber)}"&$top=3&$select=subject,bodyPreview,body`);
      for (const msg of (list.value || []).slice(0, 3)) {
        const bodyText = (msg.body?.contentType === "text" ? msg.body.content : (msg.bodyPreview || "")) || "";
        emails.push({ subject: msg.subject || "", body: bodyText.substring(0, 3000) });
      }
    } catch (e) {
      console.log(`Flights: live Outlook dig failed for ${flightNumber}: ${e.message}`);
    }
  }
  if (emails.length === 0) return null;
  try {
    const { client: llm, model: fastModel } = getInternalClient(userId);
    const resp = await llm.messages.create({
      model: fastModel,
      max_tokens: 200,
      messages: [{ role: "user", content: `From these emails, extract booking details for flight ${flightNumber} ONLY. Return ONLY JSON: {"confirmationCode":"...","passengerName":"...","airline":"..."}. Use null for unknown fields. Do not guess.\n\n${emails.map(e => (e.subject || "") + "\n" + (e.summary || e.body || "").substring(0, 1500)).join("\n---\n")}` }],
    });
    const text = resp.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

// Airport IANA timezone lookup, cached per process. Flight times must display
// airport-local (what's on the boarding pass), never the user's home timezone.
const _airportTzCache = {};
async function getAirportTz(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().substring(0, 4);
  if (_airportTzCache[c]) return _airportTzCache[c];
  try {
    const data = await flightAwareGet(`airports/${c}`);
    if (data?.timezone) { _airportTzCache[c] = data.timezone; return data.timezone; }
  } catch (_) {}
  return null;
}

/**
 * Published-schedule lookup: works months ahead (the live flights endpoint
 * only sees ~2 days out). Same per-call cost, no LLM.
 */
async function getScheduledFlight(flightIdent, departureDate, expectedRoute = {}) {
  const ident = flightIdent.replace(/\s+/g, "");
  const m = ident.match(/^([A-Z][A-Z0-9]{0,2}?)(\d{1,4})$/);
  if (!m) return { error: "Unparseable flight number" };
  const d = new Date(departureDate);
  if (isNaN(d.getTime())) return { error: "Bad date" };
  const start = new Date(d.getTime() - 86400000).toISOString().split("T")[0];
  const end = new Date(d.getTime() + 86400000).toISOString().split("T")[0];
  const data = await flightAwareGet(`schedules/${start}/${end}?airline=${m[1]}&flight_number=${m[2]}`);
  if (data.error) return data;
  // A flight number can fly multiple segments per day (plus codeshares):
  // match the exact ident and pick the segment closest to the expected departure
  const target = d.getTime();
  let candidates = (data.scheduled || []).filter(f => (f.ident_iata || f.ident) === ident);
  // When the caller knows the leg's airports, only a segment flying that route
  // is a retiming of THIS leg. A nearest-time match on number alone can be a
  // different segment of the rotation, or a different flight entirely when the
  // number was extracted wrong, and its data stamped over the note is how a
  // KIX->OKA leg became KIX->KIX. No route match -> refuse, never guess.
  if (expectedRoute.origin) candidates = candidates.filter(f => (f.origin_iata || f.origin) === expectedRoute.origin);
  if (expectedRoute.destination) candidates = candidates.filter(f => (f.destination_iata || f.destination) === expectedRoute.destination);
  candidates.sort((a, b) =>
    Math.abs(new Date(a.scheduled_out).getTime() - target) - Math.abs(new Date(b.scheduled_out).getTime() - target));
  const f = candidates[0];
  if (!f) return { error: "No schedule found" };
  // A segment hours away from the expected departure is almost certainly a
  // different rotation or a wrong flight number, not a retiming: airlines
  // moving a flight more than a few hours send a rebooking email, which the
  // scanner picks up on its own. Refusing beats corrupting the note.
  if (Math.abs(new Date(f.scheduled_out).getTime() - target) > 6 * 3600000) {
    return { error: "No schedule found near expected departure time" };
  }
  return {
    origin: f.origin_iata || null,
    destination: f.destination_iata || null,
    scheduledOut: f.scheduled_out || null,
    scheduledIn: f.scheduled_in || null,
    aircraftType: f.aircraft_type || null,
  };
}

// --- Live status ---

async function getFlightStatus(flightIdent, departureDate) {
  const ident = flightIdent.replace(/\s+/g, "");
  const date = new Date(departureDate);
  const start = date.toISOString().split("T")[0] + "T00:00:00Z";
  const nextDay = new Date(date.getTime() + 86400000);
  const end = nextDay.toISOString().split("T")[0] + "T00:00:00Z";

  const data = await flightAwareGet(`flights/${ident}?start=${start}&end=${end}`);
  if (data.error) return data;

  const fl = data.flights?.[0];
  if (!fl) return { error: "No flight data found for this date" };

  return {
    status: fl.status || "unknown",
    origin: fl.origin?.code_iata || fl.origin?.code || null,
    destination: fl.destination?.code_iata || fl.destination?.code || null,
    aircraftType: fl.aircraft_type || null,
    departureTime: fl.estimated_out || fl.scheduled_out,
    arrivalTime: fl.estimated_in || fl.scheduled_in,
    gate: fl.gate_origin || null,
    gateDestination: fl.gate_destination || null,
    terminal: fl.terminal_origin || null,
    terminalDestination: fl.terminal_destination || null,
    delay: calcDelay(fl.scheduled_out, fl.estimated_out),
    departed: !!fl.actual_out,
    landed: !!fl.actual_in,
    scheduledOut: fl.scheduled_out,
    estimatedOut: fl.estimated_out,
    actualOut: fl.actual_out,
    scheduledIn: fl.scheduled_in,
    estimatedIn: fl.estimated_in,
    actualIn: fl.actual_in,
  };
}

function calcDelay(scheduled, estimated) {
  if (!scheduled || !estimated) return 0;
  const diff = new Date(estimated).getTime() - new Date(scheduled).getTime();
  return Math.round(diff / 60000); // minutes
}

// --- Check for updates ---

async function checkFlightsForUpdates(userId) {
  const now = Date.now();
  const updates = [];

  for (const [key, value] of Object.entries(ctx.store.facts)) {
    if (!key.startsWith("flight-")) continue;

    let flight;
    try { flight = JSON.parse(_getNoteValue(value)); } catch { continue; }
    if (flight.landed) continue;

    const depTime = new Date(flight.departure?.dateTime).getTime();
    // Only check flights within 48h window (before departure) or up to 6h after departure
    if (depTime > now + 48 * 3600000 || depTime < now - 6 * 3600000) continue;

    const status = await getFlightStatus(flight.flightNumber, flight.departure.dateTime);
    if (status.error) continue;

    // Backfill airports for calendar-detected flights: FlightAware can't answer
    // more than ~2 days ahead, so this is the first chance to learn the origin
    if (status.origin && !flight.departure?.airport) {
      flight.departure = flight.departure || {};
      flight.departure.airport = status.origin;
    }
    if (status.destination && (!flight.arrival?.airport || flight.arrival.airport.length !== 3)) {
      flight.arrival = flight.arrival || {};
      flight.arrival.airport = status.destination;
    }
    if (status.aircraftType && !flight.aircraftType) flight.aircraftType = status.aircraftType;
    // Airport timezones so flight times display airport-local, not user-local
    try {
      if (flight.departure?.airport && !flight.departure.tz) flight.departure.tz = await getAirportTz(flight.departure.airport);
      if (flight.arrival?.airport && !flight.arrival.tz) flight.arrival.tz = await getAirportTz(flight.arrival.airport);
    } catch (_) {}
    if (!flight.confirmationCode && !flight.digTried) {
      flight.digTried = true;
      try {
        const extra = await _digEmailForFlight(userId, flight.flightNumber);
        if (extra?.confirmationCode) flight.confirmationCode = extra.confirmationCode;
        if (extra?.passengerName && !flight.passengerName) flight.passengerName = extra.passengerName;
      } catch (_) {}
    }

    const changes = [];

    if (status.gate && status.gate !== flight.lastGate) {
      changes.push({ type: "gate", from: flight.lastGate, to: status.gate });
      flight.lastGate = status.gate;
    }

    if (status.delay !== flight.lastDelay) {
      if (Math.abs((status.delay || 0) - (flight.lastDelay || 0)) >= 5) {
        changes.push({ type: "delay", from: flight.lastDelay, to: status.delay });
        flight.lastDelay = status.delay;
      }
    }

    if (status.status && status.status !== flight.lastStatus) {
      const s = status.status.toLowerCase();
      if (s.includes("cancel")) changes.push({ type: "cancelled" });
      else if (s.includes("divert")) changes.push({ type: "diverted" });
      flight.lastStatus = status.status;
    }

    if (status.departed && !flight.departed) {
      changes.push({ type: "departed" });
      flight.departed = true;
    }

    if (status.landed && !flight.landed) {
      changes.push({ type: "landed" });
      flight.landed = true;
    }

    // Update stored status
    flight.liveStatus = status;
    _setNoteValue(key, JSON.stringify(flight));

    if (changes.length > 0) {
      updates.push({ key, flight, changes, status });
    }
  }

  if (updates.length > 0) saveStore();
  return updates;
}

// --- Briefing ---

function buildFlightBriefing(flight) {
  const dep = flight.departure || {};
  const arr = flight.arrival || {};
  const live = flight.liveStatus || {};

  // Times display AIRPORT-LOCAL (what's on the boarding pass and departure
  // boards), falling back to the user's timezone if airport tz is unknown
  const { getUserTimezone, formatTime } = require("./timezone");
  const userTz = getUserTimezone(ctx.store);
  const depTz = dep.tz || userTz;
  const arrTz = arr.tz || userTz;

  const depTime = live.departureTime
    ? formatTime(live.departureTime, depTz)
    : dep.dateTime
      ? formatTime(dep.dateTime, depTz)
      : "TBC";

  const arrTime = live.arrivalTime
    ? formatTime(live.arrivalTime, arrTz)
    : arr.dateTime
      ? formatTime(arr.dateTime, arrTz)
      : "TBC";

  let lines = [`${flight.flightNumber} - ${dep.airport || "?"} to ${arr.airport || "?"}`];

  const terminalGate = [
    live.terminal ? `Terminal ${live.terminal}` : null,
    live.gate ? `Gate ${live.gate}` : null,
  ].filter(Boolean).join(", ");

  lines.push(`Departs ${depTime}${dep.tz ? ` (${dep.airport} local)` : ""}${terminalGate ? ` from ${terminalGate}` : ""}`);
  lines.push(`Arrives ${arrTime}${arr.tz ? ` (${arr.airport} local)` : ` (your timezone: ${userTz})`}`);

  if (live.delay && live.delay > 0) {
    lines.push(`Delayed by ${live.delay} minutes`);
  }

  if (flight.confirmationCode) {
    lines.push(`Booking ref: ${flight.confirmationCode}`);
  }

  if (live.status) {
    lines.push(`Status: ${live.status}`);
  }

  return lines.join("\n");
}

// --- Pin flight to platforms ---

async function sendFlightPin(userId, noteKey, flight, chatLinks, targets) {
  const briefing = buildFlightBriefing(flight);
  const WEBAPP_URL = process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000";

  for (const link of targets) {
    try {
      let msgId;
      if (link.platform === "telegram" && ctx.bot) {
        const result = await ctx.bot.sendMessage(link.platform_user_id, briefing, {
          reply_markup: { inline_keyboard: [[
            { text: "View flights", web_app: { url: `${WEBAPP_URL}/dashboard#schedules` } }
          ]] }
        });
        msgId = result?.message_id || null;
      } else {
        msgId = await sendToPlatform(link.platform, link.platform_user_id, briefing);
      }

      if (msgId) {
        await pinMessage(link.platform, link.platform_user_id, msgId);
        flight.pinMessageIds[`${link.platform}:${link.platform_user_id}`] = msgId;
      }
    } catch (e) {
      console.error(`Flight pin failed for ${link.platform}:`, e.message);
    }
  }

  // Check for boarding pass attachment in original email
  if (flight.emailId && isGoogleConnected()) {
    try {
      const detail = await googleApiRequest("GET",
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${flight.emailId}?format=full`
      );
      const attachments = [];
      function findAttachments(payload) {
        if (payload.filename && payload.body?.attachmentId) {
          attachments.push({ id: payload.body.attachmentId, filename: payload.filename, mimeType: payload.mimeType });
        }
        if (payload.parts) payload.parts.forEach(findAttachments);
      }
      if (detail?.payload) findAttachments(detail.payload);
      if (attachments.length > 0) {
        const boardingPass = attachments.find(att =>
          /boarding|pass|ticket/i.test(att.filename) &&
          /pdf|pkpass|image/i.test(att.mimeType)
        );
        if (boardingPass) {
          const attData = await googleApiRequest("GET",
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${flight.emailId}/attachments/${boardingPass.id}`
          );
          if (attData?.data) {
            const buffer = Buffer.from(attData.data, "base64url");
            for (const link of targets) {
              try {
                await sendDocumentToPlatform(link.platform, link.platform_user_id, buffer, boardingPass.filename, boardingPass.mimeType);
              } catch (e) {
                console.error(`Boarding pass delivery failed for ${link.platform}:`, e.message);
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("Boarding pass fetch error:", e.message);
    }
  }

  _setNoteValue(noteKey, JSON.stringify(flight));
  saveStore();
}

// --- Cleanup ---

async function unpinAndCleanup(userId, noteKey, flight) {
  for (const [platformChat, msgId] of Object.entries(flight.pinMessageIds || {})) {
    const [platform, chatId] = platformChat.split(":");
    try {
      await unpinMessage(platform, chatId, msgId);
    } catch (e) {
      console.error(`Unpin failed for ${platform}:`, e.message);
    }
  }

  flight.landed = true;
  flight.pinMessageIds = {};
  _setNoteValue(noteKey, JSON.stringify(flight));
  saveStore();
}

function cleanupExpiredFlights(userId) {
  const now = Date.now();
  const toDelete = [];

  for (const [key, value] of Object.entries(ctx.store.facts)) {
    if (!key.startsWith("flight-")) continue;
    try {
      const flight = JSON.parse(_getNoteValue(value));
      const arrTime = new Date(flight.arrival?.dateTime || flight.departure?.dateTime).getTime();
      if (arrTime && now - arrTime > 48 * 3600000) {
        toDelete.push(key);
      }
    } catch { /* skip malformed */ }
  }

  for (const key of toDelete) {
    delete ctx.store.facts[key];
    // saveStore only upserts, so dropping the key in memory left the row in
    // Supabase for good: a flight that departed on the 20th was still a stored
    // fact five days later, and the next load read it straight back in.
    if (ctx.activeUserStore) {
      ctx.activeUserStore.deleteFact(key).catch((e) => console.error(`[Flights] Could not delete ${key}: ${e.message}`));
    }
  }

  if (toDelete.length > 0) {
    saveStore();
    console.log(`Flights: cleaned up ${toDelete.length} expired flight notes for user ${userId}`);
  }
}

module.exports = {
  flightAwareGet,
  scanEmailsForFlights,
  scanCalendarForFlights,
  getScheduledFlight,
  getFlightStatus,
  checkFlightsForUpdates,
  buildFlightBriefing,
  sendFlightPin,
  unpinAndCleanup,
  cleanupExpiredFlights,
};
