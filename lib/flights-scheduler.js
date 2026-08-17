// lib/flights-scheduler.js — Boot-time flight tracking intervals
// Checks for active flight notes across all users and sets up 15-min status checks.

const ctx = require("./context");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("./storage");
const { sendToPlatform } = require("./messaging");
const { getConversation } = require("./conversation");
const { supabase, UserStore } = require("../user-store");
// Note metadata helpers (notes may be plain strings or {value, created, ...} objects)
function _getNoteValue(note) {
  if (typeof note === "object" && note !== null && note.value !== undefined) return note.value;
  return note;
}
function _setNoteValue(key, jsonStr) {
  const existing = ctx.store.facts[key];
  const now = new Date().toISOString();
  if (existing && typeof existing === "object" && existing.value !== undefined) {
    existing.value = jsonStr;
    existing.lastAccessed = now;
  } else {
    ctx.store.facts[key] = { value: jsonStr, created: now, lastAccessed: now, accessCount: 0 };
  }
}

const {
  scanEmailsForFlights,
  scanCalendarForFlights,
  checkFlightsForUpdates,
  getScheduledFlight,
  buildFlightBriefing,
  sendFlightPin,
  unpinAndCleanup,
  cleanupExpiredFlights,
} = require("./flights");

const FLIGHT_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes (routine window)
const FLIGHT_CHECK_INTERVAL_FAST = 5 * 60 * 1000; // 5 minutes (final 3h pre-departure + final 1h pre-arrival)
const DISCOVERY_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const flightIntervals = {};
const flightIntervalSpeed = {};

function startFlightTracking() {
  if (!process.env.FLIGHTAWARE_API_KEY) {
    console.log("Flights: FLIGHTAWARE_API_KEY not set, skipping flight tracking.");
    return;
  }

  // Load all users with flight notes and start checking
  UserStore.getActiveUsers().then(async (users) => {
    let tracked = 0;

    for (const user of users) {
      try {
        const userStore = await UserStore.load(user.userId);
        const hasFlights = Object.keys(userStore.notes).some(k => k.startsWith("flight-"));
        if (!hasFlights) continue;

        startFlightCheckForUser(user.userId);
        tracked++;
      } catch (e) {
        console.error(`Flights: error checking user ${user.userId}:`, e.message);
      }
    }

    if (tracked > 0) {
      console.log(`Flights: tracking active flights for ${tracked} user(s).`);
    }
  }).catch((err) => {
    console.error("Flights: startup error:", err.message);
  });

  // Discovery pass: catches new bookings for users with no running check loop, and
  // re-activates polling when a far-future flight approaches departure. The check
  // loop previously only started for users who already had flights, so the very
  // scanner that finds a user's FIRST flight could never run for them.
  setInterval(runDiscoveryPass, DISCOVERY_INTERVAL);
  setTimeout(runDiscoveryPass, 5 * 60 * 1000); // first pass shortly after boot

  // Far-flight reconcile: flights beyond the 48h live window get one schedules
  // check per day, catching airline retimings/route changes days or weeks out.
  // One API call per flight per day; the live window handles everything closer in.
  setInterval(reconcileFarFlights, 24 * 3600000);
  setTimeout(reconcileFarFlights, 10 * 60 * 1000);
}

// Flight notifications go ONLY to the apps the user selected in pulse
// settings (multi-select = all of them), WhatsApp included only while
// Meta's 24h customer-service window is open. See lib/proactive.js.
async function deliveryTargets(userId, userStore, chatLinks) {
  const { getProactiveTargets } = require("./proactive");
  return getProactiveTargets(userId, userStore, chatLinks);
}

async function reconcileFarFlights() {
  try {
    const users = await UserStore.getActiveUsers();
    for (const user of users) {
      const userId = user.userId;
      try {
        const userStore = await UserStore.load(userId);
        const flightKeys = Object.keys(userStore.notes || {}).filter(k => k.startsWith("flight-"));
        if (flightKeys.length === 0) continue;

        const { data: chatLinks } = await supabase
          .from("chat_links").select("platform, platform_user_id")
          .eq("user_id", userId).not("platform_user_id", "is", null);
        if (!chatLinks || chatLinks.length === 0) continue;
        const primaryLink = chatLinks.find(l => l.platform === "telegram") || chatLinks[0];
        // Under the user mutex: own context bubble + serialized with live chat
        const { acquireUserMutex } = require("./user-mutex");
        await acquireUserMutex(userId, async () => {
        swapToCloudStore(userStore, userId, primaryLink.platform_user_id);

        let changed = false;
        for (const key of flightKeys) {
          let flight;
          try { flight = JSON.parse(_getNoteValue(ctx.store.facts[key])); } catch { continue; }
          if (!flight || flight.landed) continue;
          const dep = new Date(flight.departure?.dateTime).getTime();
          // Only flights beyond the live window; closer ones are polled anyway
          if (isNaN(dep) || dep - Date.now() <= 48 * 3600000) continue;
          if (flight.lastScheduleCheck && Date.now() - new Date(flight.lastScheduleCheck).getTime() < 20 * 3600000) continue;

          const sched = await getScheduledFlight(flight.flightNumber, flight.departure.dateTime,
            { origin: flight.departure?.airport || null, destination: flight.arrival?.airport || null });
          flight.lastScheduleCheck = new Date().toISOString();
          if (!sched.error) {
            const oldDep = flight.departure?.dateTime;
            const retimed = sched.scheduledOut && oldDep &&
              Math.abs(new Date(sched.scheduledOut) - new Date(oldDep)) > 10 * 60000;
            if (retimed) {
              const { formatTime, getUserTimezone } = require("./timezone");
              const tz = getUserTimezone(ctx.store);
              const msg = `Schedule change: ${flight.flightNumber} now departs ${formatTime(sched.scheduledOut, tz)} on ${new Date(sched.scheduledOut).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz })} (was ${formatTime(oldDep, tz)}).`;
              for (const link of await deliveryTargets(userId, userStore, chatLinks)) {
                try { await sendToPlatform(link.platform, link.platform_user_id, msg); } catch {}
              }
              const conversation = getConversation(userId);
              conversation.push({ role: "assistant", content: `[Flight update] ${msg}` });
            }
            if (sched.scheduledOut) flight.departure.dateTime = sched.scheduledOut;
            if (sched.scheduledIn) { flight.arrival = flight.arrival || {}; flight.arrival.dateTime = sched.scheduledIn; }
            // Airports come from the booking; a status lookup only ever fills a
            // blank, it never overwrites. Destination used to be unconditional
            // here, which is the line that turned KIX->OKA into KIX->KIX.
            if (sched.origin && !flight.departure.airport) flight.departure.airport = sched.origin;
            if (sched.destination && !flight.arrival?.airport) { flight.arrival = flight.arrival || {}; flight.arrival.airport = sched.destination; }
            if (sched.aircraftType) flight.aircraftType = sched.aircraftType;
          }
          _setNoteValue(key, JSON.stringify(flight));
          changed = true;
        }
        if (changed) saveStore();
        cleanupUserContext();
        }); // end acquireUserMutex
      } catch (e) {
        console.error(`Flights: far reconcile error for ${userId}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`Flights: far reconcile failed: ${e.message}`);
  }
}

/**
 * For each user without an active check loop, decide cheaply (no LLM) whether it's
 * worth starting one. The loop's first check then does the email scan (one fast-tier
 * LLM call), notifies about new flights, and stops itself again if nothing's there.
 * LLM cost therefore scales with flight-email arrivals, not with time.
 */
async function runDiscoveryPass() {
  try {
    const users = await UserStore.getActiveUsers();
    for (const user of users) {
      const userId = user.userId;
      if (flightIntervals[userId]) continue; // already actively tracked

      try {
        // Prefilter 1: flight-ish email cached in the last 7 days
        const since = new Date(Date.now() - 7 * 86400000).toISOString();
        const { data: recentFlightEmail } = await supabase
          .from("data_cache")
          .select("id")
          .eq("user_id", userId)
          .eq("type", "email")
          .gte("received_at", since)
          .or("data->>subject.ilike.%flight%,data->>subject.ilike.%booking%,data->>subject.ilike.%itinerary%,data->>subject.ilike.%e-ticket%,data->>subject.ilike.%boarding%")
          .limit(1);

        // Prefilter 2: an already-noted flight approaching its departure window
        let upcomingNoted = false;
        if (!recentFlightEmail || recentFlightEmail.length === 0) {
          const store = await UserStore.load(userId);
          upcomingNoted = Object.keys(store.notes || {}).some(k => {
            if (!k.startsWith("flight-")) return false;
            try {
              const f = JSON.parse(_getNoteValue(store.notes[k]));
              if (f.landed) return false;
              const dep = new Date(f.departure?.dateTime).getTime();
              return dep > Date.now() - 6 * 3600000 && dep < Date.now() + 72 * 3600000;
            } catch { return false; }
          });
        }

        if ((recentFlightEmail && recentFlightEmail.length > 0) || upcomingNoted) {
          console.log(`Flights: discovery starting check loop for ${userId}`);
          startFlightCheckForUser(userId);
        }
      } catch (e) {
        console.error(`Flights: discovery error for ${userId}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`Flights: discovery pass failed: ${e.message}`);
  }
}

function startFlightCheckForUser(userId, _level, intervalMs) {
  if (flightIntervals[userId]) {
    clearInterval(flightIntervals[userId]);
  }

  const ms = intervalMs || FLIGHT_CHECK_INTERVAL;
  flightIntervalSpeed[userId] = ms;
  flightIntervals[userId] = setInterval(() => runFlightCheck(userId), ms);
  // First check after 60s (give other services time to init)
  if (!intervalMs) setTimeout(() => runFlightCheck(userId), 60000);
}

/**
 * Poll faster only when minutes matter:
 * - final 3h before departure (gates assigned late and changed later, delays)
 * - final 1h before estimated arrival (prompt landed detection for the welcome/
 *   location prompt, and arrival delay drift for tight connections)
 * Mid-cruise nothing actionable changes minute-to-minute: stay at 15.
 */
function adjustFlightCadence(userId, activeFlights) {
  const now = Date.now();
  let wantFast = false;
  for (const f of activeFlights) {
    const dep = new Date(f.departure?.dateTime).getTime();
    if (isNaN(dep)) continue;
    const beforeDeparture = dep - now > 0 && dep - now <= 3 * 3600000;
    const arr = new Date(f.liveStatus?.arrivalTime || f.arrival?.dateTime).getTime();
    const nearArrival = f.departed && !f.landed && !isNaN(arr) && arr - now <= 60 * 60000;
    if (beforeDeparture || nearArrival) { wantFast = true; break; }
  }
  const want = wantFast ? FLIGHT_CHECK_INTERVAL_FAST : FLIGHT_CHECK_INTERVAL;
  if (flightIntervals[userId] && flightIntervalSpeed[userId] !== want) {
    console.log(`Flights: cadence for ${userId} -> every ${want / 60000}min`);
    startFlightCheckForUser(userId, null, want);
  }
}

function stopFlightCheckForUser(userId) {
  if (flightIntervals[userId]) {
    clearInterval(flightIntervals[userId]);
    delete flightIntervals[userId];
    delete flightIntervalSpeed[userId];
  }
}

async function runFlightCheck(userId) {
  // Under the user mutex: own context bubble + serialized against live chat
  const { acquireUserMutex } = require("./user-mutex");
  return acquireUserMutex(userId, () => _runFlightCheckInner(userId))
    .catch(e => console.error(`Flights: mutex/check error for ${userId}: ${e.message}`));
}

async function _runFlightCheckInner(userId) {
  try {
    const userStore = await UserStore.load(userId);

    const { data: chatLinks } = await supabase
      .from("chat_links")
      .select("platform, platform_user_id")
      .eq("user_id", userId)
      .not("platform_user_id", "is", null);

    if (!chatLinks || chatLinks.length === 0) return;

    const primaryLink = chatLinks.find(l => l.platform === "telegram") || chatLinks[0];
    swapToCloudStore(userStore, userId, primaryLink.platform_user_id);

    // Clean up expired flights
    cleanupExpiredFlights(userId);

    // Check if any active flights remain
    const now = Date.now();
    const activeFlightKeys = Object.keys(ctx.store.facts).filter(k => {
      if (!k.startsWith("flight-")) return false;
      try {
        const f = JSON.parse(_getNoteValue(ctx.store.facts[k]));
        if (f.landed) return false;
        const dep = new Date(f.departure?.dateTime).getTime();
        return dep > now - 6 * 3600000 && dep < now + 48 * 3600000;
      } catch { return false; }
    });

    if (activeFlightKeys.length === 0) {
      // No active flights — stop checking, try a scan for new bookings.
      // Calendar first (free, ground truth), then email extraction (LLM).
      const calFlights = await scanCalendarForFlights(userId).catch(() => []);
      const emailFlights = await scanEmailsForFlights(userId);
      const newFlights = [...calFlights, ...emailFlights];
      if (newFlights.length > 0) {
        // Notify about newly detected flights
        const targets = await deliveryTargets(userId, userStore, chatLinks);

        const WEBAPP_URL = process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000";
        for (const flight of newFlights) {
          const msg = `Found your ${flight.flightNumber} to ${flight.arrival?.airport || "destination"} on ${new Date(flight.departure?.dateTime).toLocaleDateString("en-GB")}. I'll keep you posted.`;
          for (const link of targets) {
            try {
              if (link.platform === "telegram" && ctx.bot) {
                await ctx.bot.sendMessage(link.platform_user_id, msg, {
                  reply_markup: { inline_keyboard: [[
                    { text: "View flights", web_app: { url: `${WEBAPP_URL}/dashboard#schedules` } }
                  ]] }
                });
              } else {
                await sendToPlatform(link.platform, link.platform_user_id, msg);
              }
            } catch {}
          }
        }
      } else {
        stopFlightCheckForUser(userId);
      }
      saveStore();
      cleanupUserContext();
      return;
    }

    // Tighten or relax polling based on how close the nearest departure is
    const activeFlights = activeFlightKeys.map(k => {
      try { return JSON.parse(_getNoteValue(ctx.store.facts[k])); } catch { return null; }
    }).filter(Boolean);
    adjustFlightCadence(userId, activeFlights);

    // Send standalone flight updates
    const updates = await checkFlightsForUpdates(userId);
    const targets = await deliveryTargets(userId, userStore, chatLinks);

    for (const update of updates) {
      const changeText = update.changes.map(c => {
        switch (c.type) {
          case "gate": return `Gate changed to ${c.to}`;
          case "delay": return c.to > 0 ? `Delayed by ${c.to} minutes` : "Back on schedule";
          case "cancelled": return "CANCELLED";
          case "diverted": return "DIVERTED";
          case "departed": return "Departed";
          case "landed": return "Landed";
          default: return c.type;
        }
      }).join(", ");

      const briefing = buildFlightBriefing(update.flight);
      let msg = `${changeText}\n\n${briefing}`;

      // Landing in a new place: offer to move the user's location/timezone there.
      // Quiet hours, reminders, and all displayed times follow the saved location.
      if (update.changes.some(c => c.type === "landed")) {
        const arrAirport = update.flight.arrival?.airport;
        if (arrAirport) {
          msg += `\n\nWelcome in! If you're staying a while, just say "update my location to ${arrAirport}" (or the city) and I'll switch your clock over: timezone, quiet hours, and reminders all follow it.`;
        }
      }

      // Add to conversation history for context
      const conversation = getConversation(userId);
      conversation.push({ role: "assistant", content: `[Flight update] ${msg}` });

      for (const link of targets) {
        try { await sendToPlatform(link.platform, link.platform_user_id, msg); } catch {}
      }
    }

    await handlePinAndUnpin(userId, chatLinks, userStore);
    saveStore();
  } catch (e) {
    console.error(`Flights: check error for user ${userId}:`, e.message);
  } finally {
    cleanupUserContext();
  }
}

async function handlePinAndUnpin(userId, chatLinks, userStore) {
  const now = Date.now();
  // Pinned briefings follow the same selected-apps rule as all proactive
  // messages (this previously sent to every linked chat, bypassing settings)
  const targets = await deliveryTargets(userId, userStore, chatLinks);

  for (const [key, value] of Object.entries(ctx.store.facts)) {
    if (!key.startsWith("flight-")) continue;
    let flight;
    try { flight = JSON.parse(_getNoteValue(value)); } catch { continue; }

    const depTime = new Date(flight.departure?.dateTime).getTime();

    // ~3h before departure: send pin if not already pinned
    if (!flight.pinSent && depTime - now < 3 * 3600000 && depTime > now && !flight.landed) {
      await sendFlightPin(userId, key, flight, chatLinks, targets);
      flight.pinSent = true;
      _setNoteValue(key, JSON.stringify(flight));
    }

    // After landing + 2h: unpin and cleanup
    if (flight.landed && flight.pinSent) {
      const landTime = flight.liveStatus?.actualIn
        ? new Date(flight.liveStatus.actualIn).getTime()
        : depTime + 3600000; // fallback: 1h after departure
      if (now - landTime > 2 * 3600000) {
        await unpinAndCleanup(userId, key, flight);
      }
    }
  }
}

module.exports = { startFlightTracking, startFlightCheckForUser, stopFlightCheckForUser };
