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
// A watch reads new email, bank transactions and synced chat messages: the
// kinds the sync stores with the time they arrived. A watch for one thing has
// an end date; if nothing came by then, it ends and says so, so a promise to
// "let you know" is never left hanging. Sign-in codes and password-reset
// emails are never read (otp-guard.js). Pulse leaves alone what a watch is
// waiting for and what anyone has already told the person (told-items.js).

const told = require("./told-items");

// What a watch can watch, by the event source it was given. grace: how long
// before the watch began an item may be dated and still count, since the sync
// runs a few minutes behind and bank transactions carry only their day.
const SOURCES = {
  email: { types: ["email"], grace: 10 * 60 * 1000, words: "new email" },
  bank: { types: ["bank_transaction"], grace: 48 * 3600 * 1000, words: "new bank transaction" },
  messages: { types: ["message"], grace: 10 * 60 * 1000, words: "new chat message" },
};
const ALIASES = {
  email: "email", emails: "email", mail: "email", gmail: "email", outlook: "email", inbox: "email",
  bank: "bank", banks: "bank", bank_transaction: "bank", transaction: "bank", transactions: "bank", payment: "bank", payments: "bank",
  messages: "messages", message: "messages", chat: "messages", slack: "messages", whatsapp: "messages",
};
function sourceOf(name) {
  return ALIASES[String(name || "email").trim().toLowerCase()] || null;
}

// A watch for one thing ends after this long without it.
const ONCE_DAYS = 30;
const SEEN_KEEP = 500; // ids a watch remembers having judged
const PER_CHECK = 100; // newly synced items looked at per watch per minute
const ASK_AT_MOST = 10; // items one model call is shown

// The words the watch and the model read for an item.
function itemText(row) {
  const d = row.data || {};
  if (row.type === "email") {
    const body = require("./readable-text").readable(d.body || d.snippet || "");
    return `Email from ${d.from || "?"} to ${d.to || "?"}, ${d.date || row.received_at || ""}\nSubject: ${d.subject || ""}\n${body.slice(0, 1500)}`;
  }
  if (row.type === "bank_transaction") {
    return `Bank transaction ${d.date || ""} on ${d.account_name || "an account"}${d.institution ? " (" + d.institution + ")" : ""}: ${d.amount} ${d.currency || ""} ${d.payee || ""} ${d.description || ""} ${d.memo || ""}${d.pending ? " (pending)" : ""}`.trim();
  }
  return `Message in ${d.chat_name || d.channel || row.source} from ${d.sender || d.from || "?"}, ${d.date || ""}: ${String(d.text || "").slice(0, 1500)}`;
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
  if (!src || !src.types.includes(row.type)) return false;
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
async function confirmMatches(watch, texts, ask) {
  const system = "You check new items for a personal assistant that promised to tell someone when a particular thing arrives. "
    + "Reply ONLY with JSON: {\"matches\": [numbers]}, the numbers of the items that clearly are the thing being waited for, or {\"matches\": []}. "
    + "An item that only mentions the same order, sender or subject without being the thing itself does not count: an order confirmation is not the shipping notice, and an advert is not a reply.";
  const message = `Waiting for: ${watch.trigger_event_condition || watch.description || watch.name}\n\nNew items:\n`
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
  const began = Date.parse(watch.created_at) || now;
  const since = watch.watched_until || watch.created_at;
  const { data: rows, error } = await db.from("data_cache")
    .select("source, type, external_id, data, received_at, synced_at")
    .eq("user_id", watch.user_id).in("type", src.types).gt("synced_at", since)
    .order("synced_at", { ascending: true }).limit(PER_CHECK);
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
  const patch = { watched_until: rows[rows.length - 1].synced_at, watch_seen: judged, updated_at: new Date(now).toISOString() };
  if (fired && watch.run_once) Object.assign(patch, { status: "done", fired_at: new Date(now).toISOString() });
  const { error: saveError } = await db.from("automations").update(patch).eq("id", watch.id).eq("user_id", watch.user_id);
  if (saveError) console.error(`[watches] ${watch.name}: could not save how far it looked:`, saveError.message);
  return { looked: rows.length, fired };
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

module.exports = { checkWatches, checkWatch, claims, openWatches, sourceOf, hasWords, itemText, ignored, SOURCES, ONCE_DAYS, start };
