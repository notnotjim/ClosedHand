// lib/routine-offers.js: Closedhand offers, once, to make a request the
// person keeps making at a steady rhythm into a routine.
//
// Each request that made Closedhand do some work is noted briefly: its words
// and when, in the person's own time then. Deleting a chat deletes its notes
// (asks.thread_id cascades). Once a day the background LLM groups notes that
// ask for the same thing and could be done without the person, and code
// checks the dates really keep a rhythm: three or more, a week, a day or a
// month apart, and still going. The offer then waits for the next time the
// person asks for that thing, and the reply to it asks once whether to make
// it a routine. Yes or no, it is never offered again.

const { supabase } = require("./db");
const { getInternalClient } = require("./llm");
const { responseText } = require("./model-wire");
const { firesOn } = require("./user-skills");

const KEEP_DAYS = 100;
const OFFER_DAYS = 60; // a pending offer whose request never comes back goes
const DAY = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---- Noting requests ----

// "2026-10-20T09:12" in the person's own time.
function localStamp(tz, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// A request worth noting: one that made Closedhand do something, in words
// that say what. Setting up or running a routine is not one.
function worthNoting(request, steps) {
  const text = String(request || "").trim();
  return text.length >= 12 && Array.isArray(steps) && steps.length > 0 && !steps.some((s) => /^automation_/.test(s.tool));
}

async function recordAsk({ userId, store, threadId, request, steps, now = new Date() }) {
  if (!userId || !threadId || !worthNoting(request, steps)) return;
  const tz = require("./time-context").currentTimeContext(store, now).timezone;
  const { error } = await supabase.from("asks").insert({
    user_id: userId, thread_id: threadId, text: String(request).trim().slice(0, 300), at: now.toISOString(), local_at: localStamp(tz, now),
  });
  if (error) console.error("[routines] request not noted:", error.message);
}

// ---- The rhythm ----

function partOfDay(hours) {
  const h = [...hours].sort((a, b) => a - b)[Math.floor(hours.length / 2)];
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

// Whether these times keep a rhythm that is still going, and what it is in
// words. Only the most recent run counts: three a week apart, four a day
// apart (weekdays may skip the weekend), or three a month apart.
function rhythmOf(asks, now = Date.now()) {
  const list = asks.map((a) => ({ at: Date.parse(a.at), local: String(a.local_at) })).filter((a) => a.at && a.local).sort((a, b) => a.at - b.at);
  if (list.length < 3) return null;
  const local = (a) => { const [d, t] = a.local.split("T"); const [y, m, day] = d.split("-").map(Number); return { weekday: new Date(Date.UTC(y, m - 1, day)).getUTCDay(), mday: day, hour: Number(t.slice(0, 2)) }; };
  const tail = (n) => list.slice(-n);
  const gaps = (run) => run.slice(1).map((a, i) => (a.at - run[i].at) / DAY);
  const since = (now - list[list.length - 1].at) / DAY;

  // The day most of them fall on, when most do: a routine needs one.
  const usual = (values) => {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    const [best, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    return count * 3 >= values.length * 2 ? best : null;
  };
  const weekly = tail(3);
  if (gaps(weekly).every((g) => g >= 5.5 && g <= 8.5) && since <= 10.5) {
    const usualDay = usual(list.map((a) => local(a).weekday));
    const day = usualDay === null ? null : WEEKDAYS[usualDay];
    const part = partOfDay(weekly.map((a) => local(a).hour));
    return { every: "week", count: weekly.length, words: day ? `every ${day} ${part}` : `once a week`, times: weekly };
  }
  const daily = tail(4);
  const dailyDays = daily.map((a) => local(a).weekday);
  const weekdaysOnly = dailyDays.every((d) => d >= 1 && d <= 5);
  if (daily.length >= 4 && gaps(daily).every((g, i) => g >= 0.5 && (g <= 1.6 || (weekdaysOnly && g <= 3.6 && dailyDays[i] === 5))) && since <= (weekdaysOnly ? 3.6 : 2.5)) {
    const part = partOfDay(daily.map((a) => local(a).hour));
    return { every: weekdaysOnly ? "weekday" : "day", count: daily.length, words: weekdaysOnly ? `every weekday ${part}` : `every ${part}`, times: daily };
  }
  const monthly = tail(3);
  if (gaps(monthly).every((g) => g >= 25 && g <= 36) && since <= 45) {
    const usualDate = usual(list.map((a) => local(a).mday));
    return { every: "month", count: monthly.length, words: usualDate ? `on the ${ordinal(usualDate)} of every month` : "once a month", times: monthly };
  }
  return null;
}

// ---- Finding them, once a day ----

function findPrompt(asks, routines) {
  return `You look through requests a person made to Closedhand, their personal AI, over recent weeks, to find any they keep making that Closedhand could do for them on a schedule, as a routine, without being asked.

Group requests that ask for the same thing, even in different words. A group counts only when:
- it has 3 or more requests,
- doing it needs nothing new from the person each time (a summary of the week's mail, last month's orders as a spreadsheet, the weather before a run): not a reply to someone, a decision, or anything whose details change each time,
- none of the routines they already have does it.
Leave out one-off tasks, different requests that merely share a word, and requests that chase one particular thing until it is over: one parcel being tracked, one booking, one event coming up. Most of the time there is no group.

ROUTINES THEY HAVE:
${routines.length ? routines.map((r) => `- ${r.name}: ${String(r.task_prompt || r.description || "").slice(0, 160)}`).join("\n") : "none"}

REQUESTS (id | when, in their time | what they asked):
${asks.map((a) => `${a.id} | ${a.local_at.replace("T", " ")} ${WEEKDAYS[new Date(a.local_at.slice(0, 10) + "T12:00:00Z").getUTCDay()].slice(0, 3)} | ${JSON.stringify(a.text)}`).join("\n")}

Return ONLY JSON: {"groups":[{"ids":["the ids of the requests in the group"],"name":"a short name for the routine, under 40 characters","goal":"what the routine does each time, as one instruction to Closedhand","triggers":["2 to 6 short phrases the person uses when asking for this, lowercase, no commas, each naming something specific to it"]}]}
Return {"groups":[]} when none qualify.`;
}

async function askFinder(userId, store, prompt) {
  const { client, model } = getInternalClient(userId, store);
  let timer;
  const resp = await Promise.race([
    client.messages.create({ model, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("routine finder timeout")), 60000); }),
  ]).finally(() => clearTimeout(timer));
  try { return JSON.parse((responseText(resp) || "").match(/\{[\s\S]*\}/)?.[0] || "null"); } catch (_) { return null; }
}

async function findOffers(userId, store, now = Date.now()) {
  const since = new Date(now - KEEP_DAYS * DAY).toISOString();
  const [asksRes, offersRes, routinesRes] = await Promise.all([
    supabase.from("asks").select("id, text, at, local_at").eq("user_id", userId).gte("at", since).order("at", { ascending: true }),
    supabase.from("routine_offers").select("id, ask_ids").eq("user_id", userId),
    supabase.from("automations").select("name, description, task_prompt").eq("user_id", userId),
  ]);
  for (const r of [asksRes, offersRes, routinesRes]) if (r.error) throw new Error(r.error.message);
  // A request already behind an offer is never offered again.
  const taken = new Set((offersRes.data || []).flatMap((o) => o.ask_ids || []));
  const asks = (asksRes.data || []).filter((a) => !taken.has(a.id)).slice(-200);
  if (asks.length < 3) return [];
  const found = await askFinder(userId, store, findPrompt(asks, routinesRes.data || []));
  const byId = new Map(asks.map((a) => [a.id, a]));
  const { specificTrigger } = require("./skill-learning");
  const plain = (s, n) => require("./plain-dashes").noEmDashes(String(s || "").replace(/\s+/g, " ").trim()).slice(0, n);
  const made = [];
  for (const g of Array.isArray(found?.groups) ? found.groups : []) {
    const members = [...new Set(Array.isArray(g.ids) ? g.ids : [])].map((id) => byId.get(id)).filter(Boolean);
    const rhythm = rhythmOf(members, now);
    const triggers = (Array.isArray(g.triggers) ? g.triggers : []).map((t) => plain(t, 40).toLowerCase()).filter(specificTrigger).slice(0, 6);
    const name = plain(g.name, 40), goal = plain(g.goal, 400);
    if (!rhythm || triggers.length < 2 || name.length < 4 || goal.length < 10) {
      console.log(`[routines] not offered: "${name}" (${!rhythm ? "no steady rhythm" : "too vague"})`);
      continue;
    }
    const { error } = await supabase.from("routine_offers").insert({
      user_id: userId, name, goal, schedule: rhythm.words, triggers, ask_ids: members.map((a) => a.id),
    });
    if (error) { console.error("[routines] offer not saved:", error.message); continue; }
    console.log(`[routines] will offer "${name}" ${rhythm.words}`);
    made.push(name);
  }
  return made;
}

// ---- Offering, in the reply to the next such request ----

const _pending = new Map(); // userId -> { at, offers }
const _given = new Map(); // userId -> { message, text } for the turn the offer went into

async function warmOffers(userId) {
  const hit = _pending.get(userId);
  if (hit && Date.now() - hit.at < 60000) return hit.offers;
  const { data, error } = await supabase.from("routine_offers").select("id, name, goal, schedule, triggers, ask_ids").eq("user_id", userId).eq("status", "pending");
  if (error) { console.error("[routines] offers not loaded:", error.message); return hit ? hit.offers : []; }
  // An offer whose requests went with a deleted chat goes too.
  let offers = data || [];
  const ids = [...new Set(offers.flatMap((o) => o.ask_ids || []))];
  if (ids.length) {
    const { data: still, error: e2 } = await supabase.from("asks").select("id").eq("user_id", userId).in("id", ids);
    if (!e2) {
      const kept = new Set((still || []).map((a) => a.id));
      const gone = offers.filter((o) => (o.ask_ids || []).filter((id) => kept.has(id)).length < 3);
      for (const o of gone) {
        const { error: e3 } = await supabase.from("routine_offers").delete().eq("id", o.id).eq("user_id", userId);
        if (e3) console.error("[routines] stale offer not removed:", e3.message);
      }
      offers = offers.filter((o) => !gone.includes(o));
    }
  }
  _pending.set(userId, { at: Date.now(), offers });
  return offers;
}

function example(schedule) {
  if (/^every (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/.test(schedule)) {
    const day = schedule.split(" ")[1];
    return `You've asked me for this the last three ${day}s. Want me to do it ${schedule} as a routine?`;
  }
  if (/month/.test(schedule)) return `You've asked me for this the last three months. Want me to do it ${schedule} as a routine?`;
  return `You've asked me for this most days lately. Want me to do it ${schedule} as a routine?`;
}

// The line that goes into this message's instructions when it is the next
// request of a pending offer. Marked offered at once: whatever the reply
// says, it is never offered again.
function offerFor(userId, message) {
  const given = _given.get(userId);
  if (given && given.message === message) return given.text;
  const offers = _pending.get(userId)?.offers || [];
  const offer = offers.find((o) => firesOn({ triggers: o.triggers }, message));
  if (!offer) return "";
  _pending.set(userId, { at: _pending.get(userId).at, offers: offers.filter((o) => o !== offer) });
  supabase.from("routine_offers").update({ status: "offered", offered_at: new Date().toISOString() }).eq("id", offer.id).eq("user_id", userId)
    .then(({ error }) => { if (error) console.error("[routines] offer not marked:", error.message); })
    .catch(() => {});
  const text = `\nROUTINE TO OFFER: The person has asked for this kind of thing before (${offer.ask_ids.length} times) and it could run on its own ${offer.schedule}. Answer this message as usual. Then, unless this message already sets up a routine or is not really that request, end with one short question offering it as a routine, for example: "${example(offer.schedule)}" Ask it this once and never bring it up again. If they say yes, create it with automation_create: name "${offer.name}", runs ${offer.schedule}, task: ${offer.goal}. If they say no, leave it.\n`;
  _given.set(userId, { message, text });
  return text;
}

// ---- Upkeep ----

async function removeOld(now = Date.now()) {
  const a = await supabase.from("asks").delete().lt("at", new Date(now - KEEP_DAYS * DAY).toISOString());
  const b = await supabase.from("routine_offers").delete().eq("status", "pending").lt("created_at", new Date(now - OFFER_DAYS * DAY).toISOString());
  for (const r of [a, b]) if (r.error) console.error("[routines] upkeep failed:", r.error.message);
}

let _timer = null;
function startRoutineOffers() {
  if (_timer) return;
  const tick = async () => {
    try {
      await removeOld();
      const { data, error } = await supabase.from("profiles").select("id");
      if (error) throw new Error(error.message);
      const { UserStore } = require("../user-store");
      for (const p of data || []) {
        const store = await UserStore.load(p.id);
        await require("./model-jobs").withSettings(p.id, () => findOffers(p.id, store)).catch((e) => console.error("[routines] finder failed:", e.message));
      }
    } catch (e) { console.error("[routines] daily look failed:", e.message); }
  };
  setTimeout(tick, 20 * 60 * 1000).unref?.();
  _timer = setInterval(tick, DAY);
  _timer.unref?.();
}

module.exports = {
  localStamp, worthNoting, recordAsk, rhythmOf, findPrompt, findOffers, warmOffers, offerFor, example, removeOld, startRoutineOffers,
  _reset: () => { _pending.clear(); _given.clear(); },
};
