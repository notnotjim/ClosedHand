// lib/goal-check-ins.js: the check-in a goal asked for, at the time it chose.
//
// Each goal keeps its own check-in time (goals.check_in), so the chat and the
// dashboard change it the same way: by editing the goal. Every few minutes
// this looks for check-ins that are due, writes one with the goal in view,
// sends it where the person gets ClosedHand's other updates (the apps chosen
// in Settings, as Pulse uses), records it in the goal's history and sets the
// next time. A check-in reports where they stand and asks one thing; after a
// miss it re-plans without judgement (research: progress that is recorded and
// reported helps most; a lapse handled kindly does not undo a habit).

const { supabase } = require("./db");
const goals = require("./goals");

const EVERY_MS = 5 * 60 * 1000;
let _timer = null;
let _running = false;

function checkInPrompt(goal) {
  const lines = goals.promptLines([goal]).join("\n");
  return `[Goal check-in. Whatever you write as your final reply is sent to the user as the check-in. Write it to them directly.]
Their goal, as they set it:
${lines}

Check in like a friend who wants this for them, in 2 to 4 short sentences:
- Say where they stand in plain words: what is done, what is next.${goal.habit ? " For the habit, how many times this week so far against what they aimed for." : ""}
- If they are close to the finish line, say so${goal.reward ? ", and that their reward is near if it is one for the finish" : ""}: people speed up when the end is in sight.
- Ask one specific question they can answer in a word or two, about the next step or this week.
- If they have fallen behind, no judgement and no guilt: suggest a smaller next step or a fresh start on a natural new beginning (Monday, the first of the month), and remind them of their own reason or their if-then plan if it helps.
Do not list the whole plan. Do not use send tools. Use tools only if a fact you need is missing.`;
}

// Where ClosedHand's other updates go: the chat apps chosen in Settings,
// else the web chat.
async function targetsFor(userId, store) {
  const { data: links } = await supabase.from("chat_links").select("platform, platform_user_id").eq("user_id", userId).not("platform_user_id", "is", null);
  const chosen = await require("./proactive").getProactiveTargets(userId, store, links || []);
  return chosen.length ? chosen : [{ platform: "web", platform_user_id: userId }];
}

async function runCheckIn(goal) {
  const { UserStore } = require("../user-store");
  const { swapToCloudStore, cleanupUserContext } = require("./storage");
  const { acquireUserMutex } = require("./user-mutex");
  const userId = goal.user_id;
  await acquireUserMutex(userId, async () => {
    const store = await UserStore.load(userId);
    const targets = await targetsFor(userId, store);
    swapToCloudStore(store, userId, targets[0].platform_user_id);
    try {
      const fresh = (store.goals || []).find((g) => g.id === goal.id) || goal;
      const { runScheduledPrompt } = require("./scheduling");
      const message = await runScheduledPrompt(checkInPrompt(fresh), userId, targets[0].platform_user_id, targets[0].platform);
      if (!message) return;
      const { sendToPlatform } = require("./messaging");
      for (const t of targets) await sendToPlatform(t.platform, t.platform_user_id, message);
      // The conversation knows it asked, so the answer lands in context.
      require("./conversation").getConversation(userId).push({ role: "assistant", content: `[Check-in on goal ${goal.id.slice(0, 8)}, ${goal.title}] ${message}` });
      require("./storage").saveStore();
      await goals.addEvent(goal, "check_in", message);
    } finally {
      cleanupUserContext();
    }
  });
}

async function sweep(now = new Date()) {
  if (_running) return;
  _running = true;
  try {
    const { data, error } = await supabase.from("goals").select("id, user_id, title, shape, why, obstacle, if_then, target_date, done_when, habit, reward, plan, stage, status, check_in").eq("status", "active");
    if (error) { console.error("[goal-check-ins] could not read goals:", error.message); return; }
    for (const goal of data || []) {
      const c = goal.check_in;
      if (!c || !c.days || !c.time) continue;
      // A check-in time set or changed elsewhere has no next time yet.
      if (!c.next_at) {
        const next = goals.nextCheckIn(c, now);
        const { error: e } = await supabase.from("goals").update({ check_in: { ...c, next_at: next } }).eq("id", goal.id);
        if (e) console.error("[goal-check-ins] could not set the next check-in:", e.message);
        continue;
      }
      if (Date.parse(c.next_at) > now.getTime()) continue;
      // Move the next time on first, so a slow or failing check-in is never sent twice.
      const { error: e } = await supabase.from("goals").update({ check_in: { ...c, next_at: goals.nextCheckIn(c, now) } }).eq("id", goal.id);
      if (e) { console.error("[goal-check-ins] could not move the check-in on:", e.message); continue; }
      // More than a day late (the computer was asleep): skip to the next one
      // rather than check in about a day that has passed.
      if (now.getTime() - Date.parse(c.next_at) > 24 * 3600000) continue;
      try { await runCheckIn(goal); }
      catch (err) { console.error(`[goal-check-ins] check-in for ${goal.id.slice(0, 8)} failed:`, err.message); }
    }
  } finally {
    _running = false;
  }
}

function startGoalCheckIns() {
  if (_timer) return;
  _timer = setInterval(() => sweep().catch((e) => console.error("[goal-check-ins]", e.message)), EVERY_MS);
  setTimeout(() => sweep().catch(() => {}), 60 * 1000).unref?.();
}

module.exports = { startGoalCheckIns, sweep, checkInPrompt, _test: { targetsFor } };
