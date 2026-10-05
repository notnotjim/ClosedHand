// Goals: set up the way research says goals get done (their reason, the
// obstacle and an if-then plan, a finish line, small steps and the habit that
// gets there, a reward only if they chose one, check-ins),
// tracked in a history, checked in on at the time chosen, and shown on their
// own tab. The goals code runs here against a database kept in memory. All
// goals and names invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// Enough of the query builder for lib/goals.js and lib/goal-check-ins.js.
function memoryDb(tables) {
  let seq = 0;
  return {
    from(name) {
      const rows = tables[name] || (tables[name] = []);
      const filters = []; let op = "select", payload = null, one = false, order = null, limit = null;
      const q = {
        select() { return q; }, order(k, o) { order = [k, o]; return q; }, limit(n) { limit = n; return q; },
        insert(p) { op = "insert"; payload = p; return q; }, update(p) { op = "update"; payload = p; return q; }, delete() { op = "delete"; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; }, in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        gte(k, v) { filters.push((r) => String(r[k]) >= v); return q; }, not() { return q; },
        single() { one = true; return q; }, maybeSingle() { one = true; return q; },
        then(done, fail) {
          let data;
          if (op === "insert") {
            const row = { id: `${(++seq).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, at: new Date().toISOString(), plan: [], status: "active", shape: "milestone", ...payload };
            rows.push(row); data = { ...row };
          } else {
            let hit = rows.filter((r) => filters.every((f) => f(r)));
            if (op === "update") hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(payload))));
            if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
            if (order) hit = hit.slice().sort((a, b) => (a[order[0]] > b[order[0]] ? 1 : -1) * (order[1] && order[1].ascending === false ? -1 : 1));
            if (limit) hit = hit.slice(0, limit);
            data = hit.map((r) => ({ ...r }));
          }
          if (one) data = Array.isArray(data) ? data[0] || null : data;
          return Promise.resolve({ data, error: null }).then(done, fail);
        },
      };
      return q;
    },
  };
}

function withModules(stubs, fn) {
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return load.call(this, request, parent, ...rest);
  };
  for (const m of ["../lib/goals", "../lib/goal-check-ins"]) delete require.cache[require.resolve(m)];
  return Promise.resolve().then(fn).finally(() => {
    Module._load = load;
    for (const m of ["../lib/goals", "../lib/goal-check-ins"]) delete require.cache[require.resolve(m)];
  });
}

test("a goal is saved with its reason, if-then plan, steps and check-in, and keeps a history", async () => {
  const tables = {};
  await withModules({ "./db": { supabase: memoryDb(tables) } }, async () => {
    const goals = require("../lib/goals");
    const g = await goals.saveGoal("u1", {
      title: "Run 5k under 30 minutes by 1 March", why: "to feel strong again", obstacle: "tired after work",
      if_then: "If I'm tired after work, then I'll do 10 minutes instead of skipping", target_date: "2027-03-01",
      steps: [{ text: "Pick a 10-week plan", owner: "closedhand" }, { text: "First easy run", due: "2026-10-07" }],
      check_in: { days: ["sunday"], time: "19:00" },
    }, { timezone: "Europe/Lisbon" });
    assert.equal(g.plan.length, 2);
    assert.equal(g.plan[0].owner, "closedhand");
    assert.ok(g.check_in.next_at, "the first check-in time is set straight away");
    assert.deepEqual(tables.goal_events.map((e) => e.kind), ["created"]);

    const updated = await goals.recordProgress("u1", { id: g.id.slice(0, 8), action: "step_done", step: "10-week plan", text: "picked the beginner one" });
    assert.equal(updated.plan[0].status, "done");
    assert.match(tables.goal_events.at(-1).text, /^Done: Pick a 10-week plan\. picked the beginner one$/);
    assert.equal(goals.nextStep(updated).text, "First easy run");

    await assert.rejects(goals.recordProgress("u1", { id: g.id, action: "step_done", step: "swim the channel" }), /No step like that/);
    await assert.rejects(goals.recordProgress("u2", { id: g.id, action: "note", text: "x" }), /No goal with that id/, "another person's goal is out of reach");

    const done = await goals.recordProgress("u1", { id: g.id, action: "achieved", text: "ran 28:40" });
    assert.equal(done.status, "achieved");
    assert.ok(done.achieved_at);

    const lines = goals.promptLines([{ ...updated, this_week: 0 }]);
    assert.match(lines[0], /^- \[goal [0-9a-f]{8}\] Run 5k under 30 minutes by 1 March\. by 2027-03-01\. Why: to feel strong again\. If-then: If I'm tired after work/);
    assert.match(lines[0], /Next: First easy run \(theirs, due 2026-10-07\)/);
  });
});

test("a habit counts this week, with no streak to break", async () => {
  const tables = {};
  await withModules({ "./db": { supabase: memoryDb(tables) } }, async () => {
    const goals = require("../lib/goals");
    const g = await goals.saveGoal("u1", { title: "Spanish most days", shape: "habit", habit: { action: "15 minutes on Duolingo", cue: "after breakfast", per_week: 5 } }, { timezone: "Europe/Lisbon" });
    await goals.recordProgress("u1", { id: g.id, action: "habit_done" });
    await goals.recordProgress("u1", { id: g.id, action: "habit_done" });
    const [active] = await goals.activeGoals("u1", "Europe/Lisbon");
    assert.equal(active.this_week, 2);
    assert.match(goals.promptLines([active])[0], /Habit: after breakfast, 15 minutes on Duolingo, 5x a week; 2 so far this week/);
  });
});

test("a finish line keeps the habit that gets there, and a reward only they chose", async () => {
  const tables = {};
  await withModules({ "./db": { supabase: memoryDb(tables) } }, async () => {
    const goals = require("../lib/goals");
    const g = await goals.saveGoal("u1", {
      title: "Hold a conversation in Portuguese", done_when: "a 20-minute chat with no English", target_date: "2027-06-01",
      habit: { action: "15 minutes of listening", cue: "on the bus", per_week: 5 }, reward: "a weekend in Porto",
      steps: [{ text: "Find a tutor", owner: "closedhand" }],
    }, { timezone: "Europe/Lisbon" });
    assert.equal(g.shape, "milestone", "a goal with a finish line can still have a habit");
    await goals.recordProgress("u1", { id: g.id, action: "habit_done" });
    const [active] = await goals.activeGoals("u1", "Europe/Lisbon");
    assert.equal(active.this_week, 1, "the habit behind a finish line counts too");
    const line = goals.promptLines([active])[0];
    assert.match(line, /Done when: a 20-minute chat with no English\. .*Habit: on the bus, 15 minutes of listening, 5x a week; 1 so far this week\. Next: Find a tutor/);
    assert.match(line, /Reward they chose: a weekend in Porto$/);
    const plain = await goals.saveGoal("u1", { title: "Read more" });
    assert.equal(plain.reward, undefined, "no reward unless one is given");
    const checkIn = require("../lib/goal-check-ins").checkInPrompt({ ...active, user_id: "u1" });
    assert.match(checkIn, /For the habit, how many times this week/);
    assert.match(checkIn, /If they are close to the finish line, say so, and that their reward is near/);
  });
});

test("check-ins come at the chosen time, once, and say where things stand", async () => {
  const now = new Date("2026-10-11T12:00:30Z");
  const sent = [], prompts = [];
  const tables = {
    goals: [
      { id: "aaaaaaaa-due", user_id: "u1", title: "Run 5k", shape: "milestone", status: "active", plan: [{ id: "s1", text: "First easy run", owner: "you", status: "todo" }], check_in: { days: [0], time: "19:00", timezone: "Asia/Ho_Chi_Minh", next_at: "2026-10-11T12:00:00.000Z" } },
      { id: "bbbbbbbb-later", user_id: "u1", title: "Read more", shape: "milestone", status: "active", plan: [], check_in: { days: [3], time: "19:00", timezone: "Asia/Ho_Chi_Minh", next_at: "2026-10-14T12:00:00.000Z" } },
      { id: "cccccccc-stale", user_id: "u1", title: "Stale", shape: "milestone", status: "active", plan: [], check_in: { days: [5], time: "08:00", timezone: "Asia/Ho_Chi_Minh", next_at: "2026-10-09T01:00:00.000Z" } },
      { id: "dddddddd-new", user_id: "u1", title: "New", shape: "milestone", status: "active", plan: [], check_in: { days: [1], time: "07:00", timezone: "Asia/Ho_Chi_Minh", next_at: null } },
    ],
    chat_links: [{ user_id: "u1", platform: "telegram", platform_user_id: "chat-1" }],
  };
  const db = memoryDb(tables);
  await withModules({
    "./db": { supabase: db },
    "../user-store": { UserStore: { load: async () => ({ goals: tables.goals }) } },
    "./storage": { swapToCloudStore() {}, cleanupUserContext() {}, saveStore() {} },
    "./user-mutex": { acquireUserMutex: async (_u, fn) => fn() },
    "./proactive": { getProactiveTargets: async (_u, _s, links) => links },
    "./scheduling": { runScheduledPrompt: async (prompt) => { prompts.push(prompt); return "You're on the plan: next is your first easy run. Did Tuesday's run happen?"; } },
    "./messaging": { sendToPlatform: async (platform, chatId, text) => { sent.push([platform, chatId, text]); } },
    "./conversation": { getConversation: () => [] },
  }, async () => {
    await require("../lib/goal-check-ins").sweep(now);
  });
  assert.equal(prompts.length, 1, "only the goal that is due checks in");
  assert.match(prompts[0], /\[goal aaaaaaaa\] Run 5k\. Next: First easy run/);
  assert.match(prompts[0], /no judgement and no guilt: suggest a smaller next step or a fresh start/);
  assert.deepEqual(sent.map((s) => s.slice(0, 2)), [["telegram", "chat-1"]], "sent where ClosedHand's other updates go");
  const byId = Object.fromEntries(tables.goals.map((g) => [g.id, g]));
  assert.equal(byId["aaaaaaaa-due"].check_in.next_at, "2026-10-18T12:00:00.000Z", "moved to next Sunday before running, so never sent twice");
  assert.equal(byId["bbbbbbbb-later"].check_in.next_at, "2026-10-14T12:00:00.000Z");
  assert.equal(byId["cccccccc-stale"].check_in.next_at, "2026-10-16T01:00:00.000Z", "more than a day late: skipped to the next one, not sent");
  assert.ok(byId["dddddddd-new"].check_in.next_at, "a time set elsewhere gets its next check-in");
  assert.deepEqual((tables.goal_events || []).map((e) => [e.goal_id, e.kind]), [["aaaaaaaa-due", "check_in"]], "the check-in is in the goal's history");
});

test("ClosedHand sets goals up the researched way and records progress from the person's own words", () => {
  const defs = require("../lib/tools/definitions.js");
  const tools = defs.TOOLS || defs.tools || Object.values(defs).find(Array.isArray);
  const set = tools.find((t) => t.name === "goal_set"), progress = tools.find((t) => t.name === "goal_progress");
  assert.ok(set.core && progress.core);
  for (const want of [/why it matters to them/, /what is most likely to get in the way/, /one if-then plan for that obstacle/, /a specific version of the goal with a finish line they can check/, /the habit that gets them there/, /3 to 7 small, dated steps/, /the cue it follows/, /a check-in time/, /Call this only once they agree/, /Never infer a goal/, /Offer a reward, theirs to choose or skip/, /Never set a reward they did not choose/]) assert.match(set.description, want);
  for (const field of ["done_when", "habit", "reward"]) assert.ok(set.input_schema.properties[field], field);
  assert.match(progress.description, /from their own words only/);
  assert.match(progress.description, /a fresh start on a natural new beginning/);
  const save = tools.find((t) => t.name === "save_rule");
  assert.deepEqual(Object.keys(save.input_schema.properties), ["rule"], "preferences are preferences again");
  assert.match(read("lib/engine.js"), /THEIR GOALS \(set by them; help them get there\)/);
  assert.match(set.description, /anything this goal needs that only they know/);
  assert.match(set.description, /No web search, page or background work while setting it up unless they ask/);
  assert.match(read("lib/engine.js"), /promptLines\(userGoals\)\.join\("\\n"\) \+ "\\n";\n  \}\n  prompt \+= "\\n\\nSETTING A GOAL: [^"]*not research\. Ask your questions first[^"]*only say it is on the Goals tab after goal_set succeeds/, "the first goal gets the ask-first rule too, not only people who have goals");
  assert.match(read("migrations/055_goal_plans.sql"), /INSERT INTO goals \(user_id, title, source, created_at\)\n  SELECT user_id, rule, COALESCE\(source, 'chat'\), created_at FROM user_rules WHERE kind = 'goal';/, "goals saved this morning move across");
});

test("goals have their own tab, after Agents, that says how it helps", () => {
  const dashboard = read("webapp/views/dashboard.html");
  assert.match(dashboard, /data-tab="automations"[^\n]*>Agents<\/button>\n\s*<button class="tab" data-tab="goals" onclick="switchTab\('goals'\)">Goals<\/button>/);
  assert.match(dashboard, /ClosedHand helps you reach your goals with methods proven in peer-reviewed research\. Tell it a goal in chat, or add one here\./);
  const tab = read("webapp/public/goals.js");
  for (const label of ['"Done when"', '"Habit"', '"Next"', '"Progress feed"', '`Plan it with ${state.assistant || "ClosedHand"}`']) assert.ok(tab.includes(label), label);
  assert.match(read("migrations/055_goal_plans.sql"), /done_when text,[\s\S]*habit jsonb,[\s\S]*reward text,/);
  assert.match(dashboard, /<script defer src="\/goals\.js"><\/script>/);
  assert.match(dashboard, /<h2>Preferences<\/h2>/, "Settings keeps preferences; goals moved to their tab");
  assert.doesNotMatch(dashboard, /Goals &amp; Preferences|new-goal-input/);
  const server = read("webapp/server.js");
  for (const route of ['app.get("/api/goals"', 'app.post("/api/goals"', 'app.patch("/api/goals/:id"', 'app.post("/api/goals/:id/steps"', 'app.patch("/api/goals/:id/steps/:stepId"', 'app.post("/api/goals/:id/habit"', 'app.delete("/api/goals/:id"', 'app.get("/api/goals/:id/events"']) assert.ok(server.includes(route), route);
  assert.match(server, /\.eq\("id", id\)\.eq\("user_id", userId\)\.maybeSingle\(\)/, "every goal route checks it is the person's own");
  assert.match(read("webapp/views/index.html"), /e\.data\.type === 'chat-prefill' && e\.origin === location\.origin/, "a goal handed to chat only fills the box, from this page only");
  assert.equal(read("lib/goals-time.js"), read("webapp/goals-time.js"), "chat and dashboard share the check-in maths");
});
