// lib/sleep-watch.js -- noticing that the machine was asleep.
//
// ClosedHand runs on a laptop. When the lid closes mid-answer the process is
// frozen, not stopped: timers, open requests and the stall watchdog all wake
// together and see a jump in the clock. A tick every few seconds tells the
// difference between a slow step and a sleep, so the watchdog can forgive the
// gap and a request that died on wake can be tried once more.
const TICK_MS = 5000;
const SLEEP_GAP_MS = 30000;
let lastTick = Date.now();
let lastWake = 0;
let lastSleptMs = 0;
const listeners = [];
function tick(now = Date.now()) {
  const gap = now - lastTick;
  lastTick = now;
  if (gap > SLEEP_GAP_MS) {
    lastWake = now; lastSleptMs = gap;
    console.log(`[sleep-watch] the machine was asleep for about ${Math.round(gap / 1000)}s; carrying on`);
    for (const fn of listeners) { try { fn(gap); } catch (_) {} }
    return gap;
  }
  return 0;
}
function start() { const t = setInterval(() => tick(), TICK_MS); if (t.unref) t.unref(); return t; }
function wokeWithin(ms) { return lastWake > 0 && Date.now() - lastWake <= ms; }
function onWake(fn) { listeners.push(fn); }
function isNetworkError(error) {
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|fetch failed|socket hang up|network|aborted|AbortError|timed out|terminated/i.test(String(error?.message || error?.code || error?.name || ""));
}
// One more try, after a short pause, for a call that died as the machine woke.
async function retryAfterWake(error, fn, { within = 90000, pause = 3000 } = {}) {
  if (!isNetworkError(error) || !wokeWithin(within)) throw error;
  console.log(`[sleep-watch] retrying a request that failed on wake: ${String(error.message).slice(0, 80)}`);
  await new Promise((r) => setTimeout(r, pause));
  return fn();
}
module.exports = { start, tick, wokeWithin, onWake, isNetworkError, retryAfterWake, lastSlept: () => lastSleptMs, SLEEP_GAP_MS };
