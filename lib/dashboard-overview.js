// Read the same saved sections shown on the Agents page. No scans, writes or
// new background tasks are needed just to open the dashboard or describe it.
const FlightTime = require("./flight-time");

function flightRecord(row) {
  let value = row.value;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof value === "string") value = JSON.parse(value);
    else if (value && typeof value === "object" && value.value !== undefined) value = value.value;
    else break;
  }
  if (!value || typeof value !== "object" || !value.departure?.dateTime) throw new Error("Invalid flight");
  return { ...value, key: row.key };
}
function localPoint(point = {}, actualTime, now = Date.now()) {
  const raw = actualTime || point.dateTime;
  const dateTime = raw instanceof Date ? raw.toISOString() : raw;
  const time = FlightTime.time(dateTime, point);
  return {
    ...point, dateTime,
    local_date: FlightTime.dateKey(dateTime, point),
    local_today: FlightTime.dateKey(new Date(now).toISOString(), point),
    relative_day: FlightTime.daysAway(dateTime, point, new Date(now)),
    local_time: time === "--:--" ? null : time,
  };
}
function oneOff(schedule) {
  if (schedule.run_once !== null && schedule.run_once !== undefined) return schedule.run_once === true;
  const fields = String(schedule.cron_expression || "").trim().split(/\s+/);
  return fields.length >= 5 && /^\d+$/.test(fields[2]) && /^\d+$/.test(fields[3]);
}
function withNextRun(schedule, now) {
  let next_run = null;
  if (schedule.timezone) {
    try {
      next_run = require("cron-parser").parseExpression(schedule.cron_expression, {
        tz: schedule.timezone, currentDate: new Date(now),
      }).next().toDate().toISOString();
    } catch (_) { /* Unknown times stay unknown. */ }
  }
  const point = localPoint({ dateTime: next_run, tz: schedule.timezone });
  return { ...schedule, kind: oneOff(schedule) ? "reminder" : "recurring_task",
    next_run, next_run_local_date: point.local_date, next_run_local_time: point.local_time };
}

async function getDashboardOverview({ db, userId, platform, getUrl, now = Date.now() }) {
  if (!userId) return { error: "Missing user context", dashboard_url: null };
  const since = new Date(now - 86400000).toISOString();
  const jobs = {
    dashboard_url: () => getUrl(platform, "agents"),
    schedules_url: () => getUrl(platform, "schedules"),
    agents: () => db.from("agent_tasks")
      .select("id,title,goal,status,created_at,completed_at,error")
      .eq("user_id", userId).in("status", ["running", "pending", "completed", "failed", "cancelled"])
      .order("created_at", { ascending: false }).limit(20),
    automations: () => db.from("automations")
      .select("id,name,description,status,trigger_type,trigger_human_schedule,trigger_cron")
      .eq("user_id", userId).order("updated_at", { ascending: false }),
    schedules: () => db.from("schedules")
      .select("name,cron_expression,task,enabled,run_once,archived_at,timezone")
      .eq("user_id", userId).eq("enabled", true).order("name"),
    flights: () => db.from("facts").select("key,value").eq("user_id", userId).like("key", "flight-%"),
    bookings: () => db.from("bookings")
      .select("id,kind,title,provider,reference,starts_at,ends_at,timezone,location,status,details")
      .eq("user_id", userId).or("starts_at.gte." + since + ",ends_at.gte." + since)
      .order("starts_at", { ascending: true }).limit(100),
  };
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(names.map(name => Promise.resolve().then(jobs[name])));
  const overview = { checked_at: new Date(now).toISOString(), dashboard_url: null, schedules_url: null, sections: {}, unavailable: [] };
  settled.forEach((result, index) => {
    const name = names[index];
    const isUrl = name.endsWith("_url");
    if (result.status === "rejected" || (!isUrl && result.value?.error)) {
      overview.unavailable.push(name);
      if (!isUrl) overview.sections[name] = { available: false, count: null, items: null };
      return;
    }
    if (isUrl) { overview[name] = result.value || null; return; }
    let items = result.value?.data || [];
    let unreadable = 0;
    if (name === "flights") {
      items = items.flatMap(row => {
        try {
          const f = flightRecord(row);
          if (f.supersededBy || new Date(f.departure.dateTime).getTime() <= now - 86400000) return [];
          if (!Number.isFinite(new Date(f.departure.dateTime).getTime())) throw new Error("Invalid date");
          return [{
            key: f.key, flightNumber: f.flightNumber, airline: f.airline, confirmationCode: f.confirmationCode,
            departure: localPoint(f.departure, f.liveStatus?.departureTime, now),
            arrival: localPoint(f.arrival, f.liveStatus?.arrivalTime, now),
            status: f.landed || f.liveStatus?.landed ? "landed" : f.liveStatus?.status || f.lastStatus || "scheduled",
          }];
        } catch (_) { unreadable++; return []; }
      }).sort((a, b) => new Date(a.departure.dateTime) - new Date(b.departure.dateTime));
    }
    if (name === "bookings") items = items.map(b => ({
      ...b, start_local: localPoint({ dateTime: b.starts_at, tz: b.timezone }),
      end_local: b.ends_at ? localPoint({ dateTime: b.ends_at, tz: b.timezone }) : null,
    }));
    if (name === "schedules") items = items.filter(s => !s.archived_at).map(s => withNextRun(s, now));
    overview.sections[name] = { available: true, count: items.length, items,
      ...(unreadable ? { unreadable_count: unreadable } : {}) };
  });
  const agents = overview.sections.agents;
  if (agents?.available) agents.running_count = agents.items.filter(a => ["running", "pending"].includes(a.status)).length;
  overview.link_note = overview.dashboard_url
    ? "Share this exact Agents page URL. It works even when no agent is running."
    : overview.unavailable.includes("dashboard_url")
      ? "The dashboard address could not be checked. Do not claim phone access is disabled."
      : "Phone access has no configured address. Enable Your phone in dashboard Settings on the computer, then ask again.";
  overview.note = "This is saved dashboard data, not a new search. Summarise flights and hotel/other bookings as well as reminders and agents. Empty schedules do not mean an empty itinerary. A failed section is unknown, never empty. Use the supplied local dates/times for travel; do not convert them to the viewer's timezone. If a local time is null, say it is unconfirmed.";
  return overview;
}
module.exports = { getDashboardOverview, localPoint };
