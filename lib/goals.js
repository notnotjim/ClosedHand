// lib/goals.js: goals the person is working towards, and what ClosedHand
// does to help them get there.
//
// The shape follows what research shows works, not a to-do list:
//   - their own reason (why), which keeps effort going (self-concordance)
//   - the obstacle most likely to get in the way and an if-then plan for it
//     (mental contrasting with implementation intentions: "if X, then I'll
//     do Y" roughly doubles follow-through, Gollwitzer & Sheeran 2006)
//   - a finish line specific enough to check, rather than "do your best"
//     (Locke & Latham)
//   - near, small steps (Bandura & Schunk)
//   - the habit that gets them there, a repeated action tied to a cue,
//     counted per week with no streak to break (Lally 2010). An outcome paired
//     with the habit behind it beats either alone (Filby et al. 1999); a goal
//     can also be only a habit, ongoing
//   - a reward only if they choose one: rewards handed out can weaken a
//     person's own drive (Deci, Koestner & Ryan 1999), while a treat kept for
//     the habit itself helps (temptation bundling, Milkman 2014)
//   - progress written down and reported at regular check-ins (Harkin et al.
//     2016: monitoring helps most when recorded and reported)
// Everything that happens to a goal is kept in goal_events, its history.

const { supabase } = require("./db");
const { DAYS, DEFAULT_TZ, cleanCheckIn, nextCheckIn, describeCheckIn, weekStart } = require("./goals-time");
const FIELDS = "id, user_id, title, shape, why, obstacle, if_then, target_date, done_when, habit, reward, plan, stage, status, check_in, source, created_at, updated_at, achieved_at";

function mustWrite(result, what) {
  if (result.error) throw new Error(`Could not ${what}. Try again.`);
  return result.data;
}

// A goal named by the id the person or model has: the full id, or its first
// eight characters as shown in ClosedHand's instructions.
async function findGoal(userId, id) {
  const ref = String(id || "").trim().toLowerCase();
  if (!ref) throw new Error("Which goal? Give its id.");
  const rows = mustWrite(await supabase.from("goals").select(FIELDS).eq("user_id", userId), "read your goals");
  const hit = rows.find((g) => g.id === ref) || rows.find((g) => g.id.startsWith(ref));
  if (!hit) throw new Error("No goal with that id.");
  return hit;
}

async function addEvent(goal, kind, text, ref = null) {
  mustWrite(await supabase.from("goal_events").insert({ goal_id: goal.id, user_id: goal.user_id, kind, text: String(text).slice(0, 500), ref }), "record that");
}

function stepId() { return Math.random().toString(36).slice(2, 8); }

function cleanSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice(0, 12).map((s) => {
    const o = typeof s === "string" ? { text: s } : s || {};
    return {
      id: o.id || stepId(),
      text: String(o.text || "").slice(0, 200),
      owner: o.owner === "closedhand" ? "closedhand" : "you",
      due: /^\d{4}-\d{2}-\d{2}$/.test(String(o.due || "")) ? o.due : null,
      status: ["todo", "done", "skipped"].includes(o.status) ? o.status : "todo",
      done_at: o.done_at || null,
    };
  }).filter((s) => s.text);
}

// Creates or updates a goal. Only ever called once the person has agreed to
// it, in chat or on the dashboard.
async function saveGoal(userId, input, { source = "chat", timezone = DEFAULT_TZ } = {}) {
  const now = new Date().toISOString();
  const fields = { updated_at: now };
  if (input.title) fields.title = String(input.title).slice(0, 160);
  if (input.shape === "habit" || input.shape === "milestone") fields.shape = input.shape;
  for (const k of ["why", "obstacle", "if_then", "stage", "done_when", "reward"]) if (input[k] !== undefined) fields[k] = input[k] ? String(input[k]).slice(0, 400) : null;
  if (input.target_date !== undefined) fields.target_date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.target_date || "")) ? input.target_date : null;
  if (input.habit !== undefined) fields.habit = input.habit ? { action: String(input.habit.action || "").slice(0, 160), cue: String(input.habit.cue || "").slice(0, 160), per_week: Math.max(1, Math.min(7, Number(input.habit.per_week) || 7)) } : null;
  if (input.steps !== undefined) fields.plan = cleanSteps(input.steps);
  if (input.check_in !== undefined) {
    fields.check_in = cleanCheckIn(input.check_in, timezone);
    if (fields.check_in) fields.check_in.next_at = nextCheckIn(fields.check_in);
  }
  if (input.id) {
    const goal = await findGoal(userId, input.id);
    const updated = mustWrite(await supabase.from("goals").update(fields).eq("id", goal.id).eq("user_id", userId).select(FIELDS).single(), "update the goal");
    const what = [];
    if (fields.plan) what.push("plan updated");
    if (fields.check_in !== undefined) what.push(fields.check_in ? `check-ins ${describeCheckIn(fields.check_in)}` : "check-ins off");
    if (fields.if_then) what.push(`if-then: ${fields.if_then}`);
    if (fields.stage) what.push(`now: ${fields.stage}`);
    await addEvent(updated, "planned", what.length ? what.join("; ") : "Goal updated");
    return updated;
  }
  if (!fields.title) throw new Error("A new goal needs a title.");
  const goal = mustWrite(await supabase.from("goals").insert({ user_id: userId, source, ...fields }).select(FIELDS).single(), "save the goal");
  await addEvent(goal, "created", "Goal set" + (goal.plan.length ? `, with a plan of ${goal.plan.length} steps` : ""));
  return goal;
}

// What happened, in the person's own words: a step done, a habit done today,
// where things stand, or the goal paused, finished or dropped.
async function recordProgress(userId, input) {
  const goal = await findGoal(userId, input.id);
  const now = new Date().toISOString();
  const plan = Array.isArray(goal.plan) ? goal.plan.map((s) => ({ ...s })) : [];
  const matchStep = () => {
    const ref = String(input.step || "").toLowerCase().trim();
    return plan.find((s) => s.id === ref) || plan.find((s) => ref && s.text.toLowerCase().includes(ref)) || null;
  };
  const say = String(input.text || "").trim();
  const patch = { updated_at: now };
  let kind, text;
  switch (input.action) {
    case "step_done":
    case "step_skipped": {
      const step = matchStep();
      if (!step) throw new Error("No step like that in this goal's plan.");
      step.status = input.action === "step_done" ? "done" : "skipped"; step.done_at = now;
      patch.plan = plan; kind = input.action; text = (input.action === "step_done" ? "Done: " : "Skipped: ") + step.text + (say ? `. ${say}` : "");
      break;
    }
    case "step_added": {
      const [step] = cleanSteps([{ text: input.step || say, owner: input.owner, due: input.due }]);
      if (!step) throw new Error("What is the step?");
      plan.push(step); patch.plan = plan; kind = "step_added"; text = "New step: " + step.text;
      break;
    }
    case "habit_done": kind = "habit_done"; text = say || "Done today"; break;
    case "stage": patch.stage = say.slice(0, 400); kind = "stage"; text = say; break;
    case "note": kind = "note"; text = say; break;
    case "pause": patch.status = "paused"; kind = "paused"; text = say || "Paused"; break;
    case "resume": patch.status = "active"; kind = "resumed"; text = say || "Picked up again"; break;
    case "achieved": patch.status = "achieved"; patch.achieved_at = now; kind = "achieved"; text = say || "Achieved"; break;
    case "drop": patch.status = "dropped"; kind = "dropped"; text = say || "Let go"; break;
    default: throw new Error("Unknown progress.");
  }
  if (!text) throw new Error("Say what happened.");
  const updated = mustWrite(await supabase.from("goals").update(patch).eq("id", goal.id).eq("user_id", userId).select(FIELDS).single(), "update the goal");
  await addEvent(updated, kind, text);
  return updated;
}

function nextStep(goal) {
  return (goal.plan || []).find((s) => s.status === "todo") || null;
}

// Active and paused goals with what ClosedHand needs to hold in mind.
async function activeGoals(userId, tz = DEFAULT_TZ) {
  const rows = mustWrite(await supabase.from("goals").select(FIELDS).eq("user_id", userId).in("status", ["active", "paused"]), "read your goals");
  if (!rows.length) return [];
  const since = weekStart(tz).toISOString();
  const habits = rows.filter((g) => g.habit).map((g) => g.id);
  let done = [];
  if (habits.length) done = mustWrite(await supabase.from("goal_events").select("goal_id, at").eq("kind", "habit_done").in("goal_id", habits).gte("at", since), "read your goals");
  return rows.map((g) => ({ ...g, this_week: done.filter((e) => e.goal_id === g.id).length }));
}

// The lines in ClosedHand's instructions, one goal each, with what is needed
// to help: the finish line, their reason, the if-then plan, the habit and the
// next step.
function promptLines(goals) {
  return goals.map((g) => {
    const bits = [`[goal ${g.id.slice(0, 8)}${g.shape === "habit" ? ", ongoing habit" : ""}${g.status === "paused" ? ", paused" : ""}] ${g.title}`];
    if (g.target_date) bits.push(`by ${g.target_date instanceof Date ? g.target_date.toISOString().slice(0, 10) : String(g.target_date).slice(0, 10)}`);
    if (g.done_when) bits.push(`Done when: ${g.done_when}`);
    if (g.why) bits.push(`Why: ${g.why}`);
    if (g.if_then) bits.push(`If-then: ${g.if_then}`);
    if (g.habit) bits.push(`Habit: ${g.habit.cue ? g.habit.cue + ", " : ""}${g.habit.action}, ${g.habit.per_week}x a week; ${g.this_week || 0} so far this week`);
    const next = nextStep(g);
    if (next) bits.push(`Next: ${next.text} (${next.owner === "closedhand" ? "yours to do" : "theirs"}${next.due ? ", due " + next.due : ""})`);
    if (g.stage) bits.push(`Now: ${g.stage}`);
    if (g.reward) bits.push(`Reward they chose: ${g.reward}`);
    return "- " + bits.join(". ");
  });
}

module.exports = { saveGoal, recordProgress, activeGoals, promptLines, nextStep, nextCheckIn, cleanCheckIn, describeCheckIn, weekStart, findGoal, addEvent, DAYS };
