// lib/watches.js: routines that wait for something to happen.
//
// A routine set to run "when something happens" was saved, said "Routine
// saved", and was never run: nothing looked at it. Now this checks what the
// sync brings in against every such routine (a watch), once a minute:
//
//   new item synced -> the watch's words in it? (free)  -> no: nothing runs
//                                                       -> yes: the internal
//      model confirms it is the thing itself -> the routine runs with that
//      item in hand -> the item is recorded as told -> a watch for one thing
//      closes ("done")
//
// What a watch can look at is one list, lib/watch-kinds.js: every kind the
// sync stores (email, chat messages, calendar events, bank transactions,
// Notion pages) and bookings. "New" means first stored, not last synced:
// calendar events are saved again on every sync. A kind with a time of its
// own can also be watched at a moment that item sets, an hour before each
// meeting or the day after each stay, through the same words, the same
// model check and the same run. A moment missed while the computer was off
// is skipped, as schedules are. A watch for one thing has an end date; if
// nothing came by then, it ends and says so, so a promise to "let you know"
// is never left hanging. Sign-in codes and password-reset emails are never
// read (otp-guard.js). Pulse leaves alone what a watch is waiting for and
// what anyone has already told the person (told-items.js).

const told = require("./told-items");
const { KINDS, kindOf, describe } = require("./watch-kinds");

// Kept under the names the rest of the code reads.
const SOURCES = KINDS;
const sourceOf = kindOf;

// A watch for one thing ends after this long without it.
const ONCE_DAYS = 30;
const SEEN_KEEP = 500; // ids a watch remembers having judged
const PER_CHECK = 100; // newly synced items looked at per watch per minute
const ASK_AT_MOST = 10; // items one model call is shown

// The words the watch and the model read for an item.
// tz, when given, puts each time where the person is: a message sent at
// 18:42 UTC on Friday was read as Friday's, when in Tokyo it was Saturday.
function itemText(row, tz = null) {
  const d = row.data || {};
  const at = (v, fallback = "") => (v && tz ? require("./timezone").eventWhen(v, tz) : v || fallback);
  if (row.type === "email") {
    const body = require("./readable-text").readable(d.body || d.snippet || "");
    return `Email from ${d.from || "?"} to ${d.to || "?"}, ${at(d.date || row.received_at)}\nSubject: ${d.subject || ""}\n${body.slice(0, 1500)}`;
  }
  if (row.type === "bank_transaction") {
    return `Bank transaction ${d.date || ""} on ${d.account_name || "an account"}${d.institution ? " (" + d.institution + ")" : ""}: ${d.amount} ${d.currency || ""} ${d.payee || ""} ${d.description || ""} ${d.memo || ""}${d.pending ? " (pending)" : ""}`.trim();
  }
  if (row.type === "event") {
    const who = (Array.isArray(d.attendees) ? d.attendees : []).map((x) => (x && (x.displayName || x.email || x.name)) || x).filter((x) => typeof x === "string").slice(0, 8).join(", ");
    const when = tz ? require("./timezone").eventWhen(d.start || d.date, tz) : `${d.start || d.date || "?"} to ${d.end || "?"}`;
    return `Calendar event: ${d.summary || "(no title)"}, ${when}${d.location ? " at " + d.location : ""}${who ? ", with " + who : ""}\n${String(d.description || "").slice(0, 800)}`;
  }
  if (row.type === "page") return `Notion page: ${d.title || "(untitled)"}\n${String(d.content || d.text || "").slice(0, 1500)}`;
  if (row.type === "booking") return `Booking (${d.kind || "booking"}): ${d.title || ""}, from ${at(d.starts_at, "?")} to ${at(d.ends_at, "?")}${d.location ? " at " + d.location : ""}${d.reference ? ", ref " + d.reference : ""}${d.provider ? ", with " + d.provider : ""}`;
  if (row.type === "message") return `Message in ${d.chat_name || d.channel || row.source} from ${d.sender || d.from || "?"}, ${at(d.date)}: ${String(d.text || "").slice(0, 1500)}`;
  return `${row.type} from ${row.source}: ${JSON.stringify(d).slice(0, 1500)}`;
}

// Items a watch never acts on: what the person sent or drafted, their own
// chat messages, and sign-in codes or reset links.
function ignored(row) {
  const d = row.data || {};
  if (row.type === "email") {
    if (d.is_draft || (Array.isArray(d.labels) && d.labels.includes("SENT"))) return true;
    return !!require("./otp-guard").isSensitive(d.subject, d.body || d.snippet);
  }
  if (row.type === "message") return d.sender === "me";
  if (row.type === "event") {
    if (d.status === "cancelled") return true;
    const me = (Array.isArray(d.attendees) ? d.attendees : []).find((x) => x && x.self);
    return !!(me && me.responseStatus === "declined");
  }
  if (row.type === "booking") return d.status === "cancelled";
  return false;
}

// The free check: an item carries at least one of the watch's words. A watch
// with no words passes everything on to the model.
function hasWords(watch, text) {
  const words = (watch.watch_words || []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  if (!words.length) return true;
  const hay = String(text || "").toLowerCase();
  return words.some((w) => hay.includes(w));
}

// Whether an open watch is waiting for this item: Pulse leaves such an item to
// the watch. Only a watch with words claims anything, so one with none never
// silences Pulse.
function claims(watch, row) {
  if (!(watch.watch_words || []).length) return false;
  const src = SOURCES[sourceOf(watch.trigger_event_source)];
  if (!src || !src.types || !src.types.includes(row.type) || (watch.trigger_when && watch.trigger_when !== "arrives")) return false;
  return hasWords(watch, itemText(row));
}

async function openWatches(db, userId) {
  let q = db.from("automations").select("*").eq("trigger_type", "event").eq("status", "active");
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) { console.error("[watches] could not read watches:", error.message); return []; }
  return data || [];
}

// The model's yes or no. Returns the numbers of the items that are the thing
// itself, [] for none, or null when it could not be asked (tried next minute).
async function confirmMatches(watch, texts, ask, timed = false) {
  const system = timed
    ? "You check items for a personal assistant's routine that runs at a set time around each item of a kind. "
      + "Reply ONLY with JSON: {\"matches\": [numbers]}, the numbers of the items the routine is for, or {\"matches\": []}."
    : "You check new items for a personal assistant that promised to tell someone when a particular thing arrives. "
      + "Reply ONLY with JSON: {\"matches\": [numbers]}, the numbers of the items that clearly are the thing being waited for, or {\"matches\": []}. "
      + "An item that only mentions the same order, sender or subject without being the thing itself does not count: an order confirmation is not the shipping notice, and an advert is not a reply.";
  const message = `${timed ? "The routine is for" : "Waiting for"}: ${watch.trigger_event_condition || watch.description || watch.name}\n\n${timed ? "Items" : "New items"}:\n`
    + texts.map((t, i) => `[${i + 1}] ${t.replace(/\s+/g, " ").slice(0, 900)}`).join("\n");
  const raw = await ask(watch.user_id, system, message, 120);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] || "{}");
    return (Array.isArray(parsed.matches) ? parsed.matches : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= texts.length);
  } catch (_) { return []; }
}

function endDate(iso, tz) {
  try { return new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz || "UTC" }); }
  catch (_) { return new Date(iso).toDateString(); }
}

// One watch, one look at what arrived since the last.
async function checkWatch(watch, deps) {
  const { db, now, ask, run, say } = deps;
  if (watch.expires_at && Date.parse(watch.expires_at) <= now) {
    // Ended first, said second: a note sent before the end was saved would be
    // sent again every minute the save kept failing.
    const { error: endError } = await db.from("automations").update({ status: "expired", updated_at: new Date(now).toISOString() }).eq("id", watch.id).eq("user_id", watch.user_id);
    if (endError) { console.error(`[watches] ${watch.name}: could not end it:`, endError.message); return { error: true }; }
    const what = watch.trigger_event_condition || watch.description || watch.name;
    await say(watch, `Nothing came for "${what}" by ${endDate(watch.expires_at, watch.trigger_timezone)}, so I've stopped watching for it. Ask me if you'd like me to keep looking.`);
    return { expired: true };
  }
  const src = SOURCES[sourceOf(watch.trigger_event_source)];
  if (!src) return { skipped: "source" };
  if (watch.trigger_when === "before" || watch.trigger_when === "after") return checkTimedWatch(watch, src, deps);
  const began = Date.parse(watch.created_at) || now;
  const since = watch.watched_until || watch.created_at;
  const { rows, error } = await newItems(db, watch.user_id, src, since);
  if (error) { console.error(`[watches] ${watch.name}: could not read new items:`, error.message); return { error: true }; }
  if (!rows || !rows.length) return { looked: 0 };

  const seen = new Set(watch.watch_seen || []);
  const fresh = rows.filter((r) => !seen.has(r.external_id)
    && (!r.received_at || Date.parse(r.received_at) >= began - src.grace) && !ignored(r));
  const candidates = fresh.filter((r) => hasWords(watch, itemText(r))).slice(0, ASK_AT_MOST);

  let fired = 0;
  if (candidates.length) {
    const matches = await confirmMatches(watch, candidates.map(itemText), ask);
    if (matches === null) return { looked: rows.length, waiting: "model" }; // nothing marked: asked again next minute
    for (const n of (watch.run_once ? matches.slice(0, 1) : matches.slice(0, 3))) {
      const row = candidates[n - 1];
      await run(watch, `This arrived, and it is what this routine was waiting for:\n${itemText(row)}`);
      await told.recordTold(db, watch.user_id, [row], `watch:${watch.name}`);
      fired++;
    }
  }

  const judged = [...(watch.watch_seen || []), ...fresh.map((r) => r.external_id)].slice(-SEEN_KEEP);
  const patch = { watched_until: rows[rows.length - 1].created_at, watch_seen: judged, updated_at: new Date(now).toISOString() };
  if (fired && watch.run_once) Object.assign(patch, { status: "done", fired_at: new Date(now).toISOString() });
  const { error: saveError } = await db.from("automations").update(patch).eq("id", watch.id).eq("user_id", watch.user_id);
  if (saveError) console.error(`[watches] ${watch.name}: could not save how far it looked:`, saveError.message);
  return { looked: rows.length, fired };
}

// What arrived since the last look, oldest first, by when it was first
// stored: a kind the sync stores, or bookings (detected from mail).
async function newItems(db, userId, src, since) {
  if (src.table === "bookings") {
    const { data, error } = await db.from("bookings").select("*").eq("user_id", userId).gt("detected_at", since)
      .order("detected_at", { ascending: true }).limit(PER_CHECK);
    return { error, rows: (data || []).map(asBooking) };
  }
  const { data, error } = await db.from("data_cache")
    .select("source, type, external_id, data, received_at, synced_at, created_at")
    .eq("user_id", userId).in("type", src.types).gt("created_at", since)
    .order("created_at", { ascending: true }).limit(PER_CHECK);
  return { error, rows: data || [] };
}

function asBooking(b) {
  return { source: "bookings", type: "booking", external_id: String(b.id), data: b, received_at: b.detected_at, created_at: b.detected_at };
}

// ---- Watches at a moment an item sets ----

// A moment missed by more than this, while the computer was off, is skipped.
const LATE_MS = 15 * 60 * 1000;

function zoneOffsetMs(at, tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at.getTime();
  } catch (_) { return 0; }
}

// A time as an item gives it; an all-day date is midnight where the person is.
function timeOf(value, tz) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const utc = Date.parse(text + "T00:00:00Z");
    return utc - zoneOffsetMs(new Date(utc), tz || "UTC");
  }
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : null;
}

// Items with a time near now: calendar events and bookings, with when each starts and ends.
async function timedItems(db, userId, src, now, offsetMs, tz) {
  const pad = offsetMs + 2 * 86400000;
  const from = new Date(now - pad).toISOString(), to = new Date(now + pad).toISOString();
  if (src.table === "bookings") {
    const { data, error } = await db.from("bookings").select("*").eq("user_id", userId).gte("starts_at", from).lte("starts_at", to);
    return { error, items: (data || []).map((b) => ({ row: asBooking(b), start: timeOf(b.starts_at, tz), end: timeOf(b.ends_at, tz) })) };
  }
  const { data, error } = await db.from("data_cache").select("source, type, external_id, data, received_at, synced_at, created_at")
    .eq("user_id", userId).in("type", src.types).gte("data->>start", from.slice(0, 10)).lte("data->>start", to.slice(0, 10) + "~");
  return { error, items: (data || []).map((r) => ({ row: r, start: timeOf(r.data && (r.data.start || r.data.date), tz), end: timeOf(r.data && r.data.end, tz) })) };
}

// The moments that came since the last look: an offset before each item
// starts, or after it ends. Each is judged once, in the minute it comes.
async function checkTimedWatch(watch, src, deps) {
  const { db, now, ask, run } = deps;
  const offsetMs = Math.max(0, Number(watch.trigger_offset_minutes) || 0) * 60000;
  const before = watch.trigger_when === "before";
  const tz = watch.trigger_timezone || "UTC";
  const cursor = Math.max(Date.parse(watch.watched_until || watch.created_at) || now, now - LATE_MS);
  const { items, error } = await timedItems(db, watch.user_id, src, now, offsetMs, tz);
  if (error) { console.error(`[watches] ${watch.name}: could not read upcoming items:`, error.message); return { error: true }; }
  const seen = new Set(watch.watch_seen || []);
  const due = [];
  for (const it of items) {
    const anchor = before ? it.start : (it.end || it.start);
    if (anchor == null) continue;
    const moment = before ? anchor - offsetMs : anchor + offsetMs;
    const key = `${it.row.external_id}@${new Date(moment).toISOString()}`;
    if (moment > cursor && moment <= now && !seen.has(key) && !ignored(it.row)) due.push({ ...it, key });
  }
  const candidates = due.filter((d) => hasWords(watch, itemText(d.row))).slice(0, ASK_AT_MOST);
  let fired = 0;
  if (candidates.length) {
    const matches = await confirmMatches(watch, candidates.map((d) => itemText(d.row)), ask, true);
    if (matches === null) return { looked: due.length, waiting: "model" };
    const when = describe(sourceOf(watch.trigger_event_source), watch.trigger_when, watch.trigger_offset_minutes);
    for (const n of (watch.run_once ? matches.slice(0, 1) : matches.slice(0, 3))) {
      await run(watch, `This routine runs ${when}, and it is that time now for this one:\n${itemText(candidates[n - 1].row)}`);
      fired++;
    }
  }
  const patch = { watched_until: new Date(now).toISOString(), watch_seen: [...(watch.watch_seen || []), ...due.map((d) => d.key)].slice(-SEEN_KEEP), updated_at: new Date(now).toISOString() };
  if (fired && watch.run_once) Object.assign(patch, { status: "done", fired_at: new Date(now).toISOString() });
  const { error: saveError } = await db.from("automations").update(patch).eq("id", watch.id).eq("user_id", watch.user_id);
  if (saveError) console.error(`[watches] ${watch.name}: could not save how far it looked:`, saveError.message);
  return { looked: due.length, fired };
}

// The routine runs the way any routine does, its result delivered to the chat
// it was asked in (automations.js).
function defaultRun(watch, inputContext) {
  return require("./automations").executeAutomationRun(watch.id, watch.user_id, {
    triggered_by: "event", input_context: inputContext,
    platform: watch.platform || "dashboard", chatId: watch.chat_id || "dashboard",
  });
}

// A note from the watch itself (it ended): to the chat it was set up in. One
// set up on the dashboard shows there that it ended.
async function defaultSay(watch, text) {
  if (!watch.platform || watch.platform === "dashboard" || !watch.chat_id) return;
  try { await require("./messaging").sendToPlatform(watch.platform, watch.chat_id, text); }
  catch (e) { console.error(`[watches] ${watch.name}: could not send the end note:`, e.message); }
}

// The cheap model answers first. It declines when no summary model is set or
// its daily budget is spent; a watch must still be judged, so the person's
// chat model answers then.
async function defaultAsk(userId, system, message, tokens) {
  const cheap = await require("./services/usi").cheapChat(userId, system, message, tokens).catch(() => null);
  if (cheap != null) return cheap;
  try {
    const store = await require("../user-store").UserStore.load(userId);
    const { client, model } = require("./llm").getUserLLMClient(userId, store);
    const resp = await client.messages.create({ model, max_tokens: tokens, system, messages: [{ role: "user", content: message }] });
    return require("./model-wire").responseText(resp);
  } catch (e) {
    console.error("[watches] no model could judge a new item:", e.message);
    return null;
  }
}

let _checking = false;
async function checkWatches(deps = {}) {
  if (_checking) return;
  _checking = true;
  try {
    const db = deps.db || require("./db").supabase;
    const full = {
      db, now: deps.now || Date.now(),
      ask: deps.ask || defaultAsk,
      run: deps.run || defaultRun,
      say: deps.say || defaultSay,
    };
    for (const watch of await openWatches(db)) {
      try { await checkWatch(watch, full); }
      catch (e) { console.error(`[watches] ${watch.name} failed:`, e.message); }
    }
  } finally {
    _checking = false;
  }
}

function start(everyMs = 60 * 1000) {
  const timer = setInterval(() => { void checkWatches(); }, everyMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { checkWatches, checkWatch, claims, openWatches, sourceOf, hasWords, itemText, ignored, timeOf, SOURCES, ONCE_DAYS, start };
