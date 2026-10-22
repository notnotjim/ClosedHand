// A request the person keeps making at a steady rhythm is offered once, in
// the reply to the next such request, as a routine (lib/routine-offers.js).
// The LLM only groups requests that mean the same thing; code decides the
// rhythm is real (three a week apart, four a day apart, three a month
// apart, still going), the offer is said once, and deleting the chat
// deletes the requests and the offer built on them.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const db = { asks: [], routine_offers: [], automations: [], profiles: [], log: [] };
function query(table) {
  const filters = [];
  let op = "select", patch = null, order = null;
  const match = (r) => filters.every(([k, how, v]) => how === "eq" ? r[k] === v : how === "gte" ? r[k] >= v : how === "lt" ? r[k] < v : how === "in" ? v.includes(r[k]) : true);
  const q = {
    select() { return q; },
    eq(k, v) { filters.push([k, "eq", v]); return q; },
    gte(k, v) { filters.push([k, "gte", v]); return q; },
    lt(k, v) { filters.push([k, "lt", v]); return q; },
    in(k, v) { filters.push([k, "in", v]); return q; },
    order(k, o) { order = [k, o?.ascending !== false]; return q; },
    update(p) { op = "update"; patch = p; return q; },
    delete() { op = "delete"; return q; },
    insert(row) { db[table].push({ id: `${table}-${db[table].length + 1}`, created_at: new Date().toISOString(), status: "pending", ...row }); db.log.push(["insert", table]); return Promise.resolve({ error: null }); },
    then(resolve, reject) {
      let hit = db[table].filter(match);
      if (order) hit = hit.slice().sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : 1) * (order[1] ? 1 : -1));
      if (op === "update") for (const r of hit) Object.assign(r, patch);
      if (op === "delete") db[table] = db[table].filter((r) => !hit.includes(r));
      if (op !== "select") db.log.push([op, table, hit.length]);
      return Promise.resolve({ data: op === "select" ? hit : null, error: null }).then(resolve, reject);
    },
  };
  return q;
}
const llm = { answers: [], prompts: [] };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub("../lib/db", { supabase: { from: query } });
stub("../lib/llm", { getInternalClient: () => ({ model: "m", client: { messages: { create: async (req) => { llm.prompts.push(req.messages[0].content); return { content: [{ type: "text", text: JSON.stringify(llm.answers.shift() || { groups: [] }) }] }; } } } }) });
const offers = require("../lib/routine-offers");

const DAY = 86400000;
const NOW = Date.parse("2026-10-27T01:00:00Z"); // Tuesday 27 Oct, 10:00 in Tokyo
// A request at a day and hour, local time in Tokyo (UTC+9).
const ask = (id, localDay, hour, text = "export last month's shopify orders to a spreadsheet") => {
  const at = new Date(Date.parse(`${localDay}T${String(hour).padStart(2, "0")}:15:00+09:00`)).toISOString();
  return { id, user_id: "u1", thread_id: "t1", text, at, local_at: `${localDay}T${String(hour).padStart(2, "0")}:15` };
};
function fresh() {
  for (const k of Object.keys(db)) db[k] = [];
  llm.answers = []; llm.prompts = [];
  offers._reset();
}

test("a request is noted only when it made Closedhand do something, with the person's own time", () => {
  assert.equal(offers.localStamp("Asia/Tokyo", new Date("2026-10-26T00:15:00Z")), "2026-10-26T09:15");
  assert.equal(offers.worthNoting("export last month's orders", [{ tool: "api_request", ok: true }]), true);
  assert.equal(offers.worthNoting("export last month's orders", []), false, "chat alone is not a task");
  assert.equal(offers.worthNoting("thanks!", [{ tool: "x" }]), false);
  assert.equal(offers.worthNoting("make that a routine every Monday", [{ tool: "automation_create" }]), false, "setting up a routine is not a request to offer one for");
});

test("code decides the rhythm is real and still going, and says it in words", () => {
  const mondays = [ask("a", "2026-10-05", 9), ask("b", "2026-10-12", 9), ask("c", "2026-10-19", 10), ask("d", "2026-10-26", 9)];
  assert.deepEqual(offers.rhythmOf(mondays, NOW).words, "every Monday morning");
  assert.equal(offers.rhythmOf(mondays.slice(0, 2), NOW), null, "two is not a rhythm");
  assert.equal(offers.rhythmOf([ask("a", "2026-09-07", 9), ask("b", "2026-09-14", 9), ask("c", "2026-09-21", 9)], NOW), null, "stopped a month ago");
  assert.equal(offers.rhythmOf([ask("a", "2026-10-05", 9), ask("b", "2026-10-08", 20), ask("c", "2026-10-26", 9)], NOW), null, "the same thing at odd times is not a rhythm");
  const weekdays = [ask("a", "2026-10-21", 8), ask("b", "2026-10-22", 8), ask("c", "2026-10-23", 8), ask("d", "2026-10-26", 8)];
  assert.equal(offers.rhythmOf(weekdays, NOW).words, "every weekday morning", "Friday to Monday skips the weekend");
  const monthly = [ask("a", "2026-08-01", 19), ask("b", "2026-09-01", 19), ask("c", "2026-09-30", 20)];
  assert.equal(offers.rhythmOf(monthly, NOW).words, "on the 1st of every month", "the date most of them fall on");
  const mostlyFridays = [ask("a", "2026-10-02", 9), ask("b", "2026-10-09", 9), ask("c", "2026-10-16", 9), ask("d", "2026-10-22", 9)];
  assert.equal(offers.rhythmOf(mostlyFridays, NOW).words, "every Friday morning", "one Thursday does not lose the day");
});

test("once a day the LLM groups requests, and only a real rhythm with clear triggers becomes an offer", async () => {
  fresh();
  db.asks.push(ask("a", "2026-10-05", 9), ask("b", "2026-10-12", 9), ask("c", "2026-10-19", 10),
    ask("x", "2026-10-06", 14, "what's the weather in Osaka"), ask("y", "2026-10-15", 9, "weather for my run"), ask("z", "2026-10-25", 21, "weather tomorrow"));
  db.automations.push({ user_id: "u1", name: "Morning mail summary", task_prompt: "Summarise new mail" });
  llm.answers.push({ groups: [
    { ids: ["a", "b", "c"], name: "Monthly Shopify export", goal: "Export last month's Shopify orders to a spreadsheet and send it.", triggers: ["shopify orders", "export orders", "orders"] },
    { ids: ["x", "y", "z"], name: "Weather", goal: "Tell the person the weather.", triggers: ["weather tomorrow", "weather for my run"] },
  ] });
  const made = await offers.findOffers("u1", {}, NOW);
  assert.deepEqual(made, ["Monthly Shopify export"], "the weather requests keep no rhythm");
  const o = db.routine_offers[0];
  assert.equal(o.schedule, "every Monday morning");
  assert.deepEqual(o.triggers, ["shopify orders", "export orders"], "a lone everyday word is dropped");
  assert.match(llm.prompts[0], /ROUTINES THEY HAVE:\n- Morning mail summary: Summarise new mail/);
  assert.match(llm.prompts[0], /a \| 2026-10-05 09:15 Mon \| "export last month's shopify orders to a spreadsheet"/);
  // The next day: requests already behind an offer are not shown again.
  llm.answers.push({ groups: [] });
  await offers.findOffers("u1", {}, NOW);
  assert.doesNotMatch(llm.prompts[1], /\na \| /);
});

test("the offer goes into the reply to the next such request, once", async () => {
  fresh();
  db.asks.push(ask("a", "2026-10-05", 9), ask("b", "2026-10-12", 9), ask("c", "2026-10-19", 10));
  db.routine_offers.push({ id: "o1", user_id: "u1", status: "pending", name: "Shopify export", goal: "Export last month's Shopify orders to a spreadsheet.", schedule: "every Monday morning", triggers: ["shopify orders", "export orders"], ask_ids: ["a", "b", "c"] });
  await offers.warmOffers("u1");
  assert.equal(offers.offerFor("u1", "how's the weather"), "");
  const line = offers.offerFor("u1", "can you export Shopify orders for last month");
  assert.match(line, /ROUTINE TO OFFER: .*every Monday morning\. Answer this message as usual\./);
  assert.match(line, /"You've asked me for this the last three Mondays\. Want me to do it every Monday morning as a routine\?"/);
  assert.match(line, /create it with automation_create: name "Shopify export", runs every Monday morning, task: Export last month's Shopify orders/);
  assert.equal(offers.offerFor("u1", "can you export Shopify orders for last month"), line, "the same message keeps the same line");
  await new Promise((r) => setImmediate(r));
  assert.equal(db.routine_offers[0].status, "offered", "marked at once, whatever the answer");
  assert.equal(offers.offerFor("u1", "export shopify orders again"), "", "never offered twice");
});

test("deleting the chat takes the offer built on its requests with it", async () => {
  fresh();
  db.asks.push(ask("a", "2026-10-05", 9));
  db.routine_offers.push({ id: "o1", user_id: "u1", status: "pending", name: "n", goal: "g", schedule: "every Monday morning", triggers: ["shopify orders", "export orders"], ask_ids: ["a", "b", "c"] });
  assert.deepEqual(await offers.warmOffers("u1"), []);
  assert.equal(db.routine_offers.length, 0);
  assert.match(read("migrations/066_routine_offers.sql"), /thread_id  uuid REFERENCES conversation_threads\(id\) ON DELETE CASCADE/);
  assert.match(read("migrations/066_routine_offers.sql"), /user_id    uuid NOT NULL REFERENCES profiles\(id\) ON DELETE CASCADE/);
});

test("old requests and offers whose request never came back are removed", async () => {
  fresh();
  db.asks.push({ id: "old", at: new Date(Date.now() - 101 * DAY).toISOString() }, { id: "new", at: new Date().toISOString() });
  db.routine_offers.push({ id: "p", status: "pending", created_at: new Date(Date.now() - 61 * DAY).toISOString() }, { id: "q", status: "offered", created_at: new Date(Date.now() - 61 * DAY).toISOString() });
  await offers.removeOld();
  assert.deepEqual(db.asks.map((a) => a.id), ["new"]);
  assert.deepEqual(db.routine_offers.map((o) => o.id), ["q"], "an offer already made stays, so it is never made again");
});

test("it is noted after every reply that did work, offered from the message's own instructions, and looked for daily", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /require\("\.\/routine-offers"\)\.recordAsk\(\{ userId, store, threadId, request: userMessage, steps: turnSteps \}\)/);
  assert.match(engine, /\+ \(require\("\.\/routine-offers"\)\.offerFor\(ctx\.activeUserId, lastUserMessage\) \|\| ""\);/);
  assert.match(engine, /await require\("\.\/routine-offers"\)\.warmOffers\(userId\)/);
  assert.match(read("index.js"), /require\("\.\/lib\/routine-offers"\)\.startRoutineOffers\(\);/);
});
