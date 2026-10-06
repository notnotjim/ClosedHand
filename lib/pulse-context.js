// What Pulse is told besides the new items: what ClosedHand has already done
// for the person, and which reminders are already set. Without the first,
// Pulse read a stale booking and told the person a table ClosedHand had moved
// to 7pm was "still booked for 6:30"; without the second, it sent a dentist
// nudge at 06:00, an hour and a half before the reminder they had set.

const DAY = 24 * 3600000;

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// Background jobs finished in the last day and a half, newest first: the
// title and the opening of the answer, which says what was done.
async function recentActions(db, userId, now = Date.now()) {
  const { data, error } = await db.from("agent_tasks")
    .select("title, goal, result, status, completed_at")
    .eq("user_id", userId).in("status", ["completed", "partial"])
    .gte("completed_at", new Date(now - 1.5 * DAY).toISOString())
    .order("completed_at", { ascending: false }).limit(6);
  if (error || !data) return [];
  return data.filter((t) => t.result).map((t) => `${clip(t.title || t.goal, 60)}: ${clip(t.result.replace(/\[\[next\]\]/g, " "), 260)}`);
}

// When a reminder fires next. A one-off is a fixed day and time in its own
// zone ("30 7 6 10 *"), worked out directly; a repeating one goes to
// cron-parser, which only the running app has installed.
function nextFire(schedule, now) {
  const f = String(schedule.cron_expression || "").trim().split(/\s+/);
  const tz = schedule.timezone || "UTC";
  if (f.length >= 5 && f.slice(0, 4).every((x) => /^\d+$/.test(x))) {
    const pad = (n) => String(n).padStart(2, "0");
    const { zonedToUtc } = require("./timezone");
    const year = new Date(now).getUTCFullYear();
    for (const y of [year, year + 1]) {
      const at = zonedToUtc(`${y}-${pad(f[3])}-${pad(f[2])}T${pad(f[1])}:${pad(f[0])}:00`, tz);
      if (at.getTime() > now) return at;
    }
    return null;
  }
  try {
    return require("cron-parser").parseExpression(schedule.cron_expression, { tz, currentDate: new Date(now) }).next().toDate();
  } catch (_) { return null; }
}

// Reminders that will fire in the next day: { name, at, eventAt }.
async function remindersAhead(db, userId, now = Date.now()) {
  const { data, error } = await db.from("schedules")
    .select("name, cron_expression, timezone, run_once, enabled, archived_at, event_at")
    .eq("user_id", userId).eq("enabled", true);
  if (error || !data) return [];
  const out = [];
  for (const s of data) {
    if (s.archived_at) continue;
    const at = nextFire(s, now);
    if (!at || at.getTime() - now > DAY + 2 * 3600000) continue;
    out.push({ name: s.name, at, eventAt: s.event_at ? new Date(s.event_at) : null });
  }
  return out.sort((a, b) => a.at - b.at);
}

// A calendar event a reminder already covers: same moment, within half an hour.
function coveredByReminder(eventStart, reminders) {
  const t = Date.parse(eventStart);
  if (isNaN(t)) return false;
  return reminders.some((r) => r.eventAt && Math.abs(r.eventAt.getTime() - t) <= 30 * 60000);
}

function reminderLines(reminders, tz) {
  const { formatTime } = require("./timezone");
  return reminders.map((r) => `${r.name}: reminder at ${formatTime(r.at, tz)}${r.eventAt ? `, for ${formatTime(r.eventAt, tz)}` : ""}`);
}

module.exports = { recentActions, remindersAhead, coveredByReminder, reminderLines, nextFire };
