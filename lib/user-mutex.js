// lib/user-mutex.js — Per-user mutex shared by chat handlers and background agents
// Serializes access to the global ctx singleton at per-user granularity.
// Chat holds the mutex for its full handler. Agents hold it per-tool-call only.
//
// Timeout is liveness-based, not a flat duration cap: a request that keeps
// making progress (engine touches per tool-loop iteration) can run as long as
// it needs; only a request with NO progress for IDLE_TIMEOUT_MS is killed.
// The engine's own 300s wall-clock wrap-up handles "working but too long"
// gracefully, which a flat cap here used to pre-empt (killing answers that
// were seconds from completion and wasting the tokens already spent).

const queues = {};
const progress = {}; // userId -> timestamp of last observed progress

const IDLE_TIMEOUT_MS = 240_000;

function touchMutexProgress(userId) {
  progress[userId] = Date.now();
}

function acquireUserMutex(userId, fn) {
  if (!queues[userId]) queues[userId] = Promise.resolve();

  return new Promise((resolve, reject) => {
    queues[userId] = queues[userId].then(async () => {
      progress[userId] = Date.now();
      let done = false;
      let timer = null;
      const idleWatch = new Promise((_, rej) => {
        timer = setInterval(() => {
          if (done) { clearInterval(timer); return; }
          if (Date.now() - (progress[userId] || 0) > IDLE_TIMEOUT_MS) {
            clearInterval(timer);
            rej(new Error("Mutex timeout"));
          }
        }, 15_000);
      });
      try {
        // Every mutex-held task runs in its own async context bubble: all ctx
        // reads/writes in its call tree are isolated from concurrent tasks
        // for other users (see lib/context.js runWithInheritedContext).
        const { runWithInheritedContext } = require("./context");
        resolve(await Promise.race([
          runWithInheritedContext(() => fn()).finally(() => { done = true; if (timer) clearInterval(timer); }),
          idleWatch,
        ]));
      } catch (e) {
        console.error(`[Mutex] User ${userId} timed out or errored: ${e.message}`);
        reject(e);
      }
    }).catch(() => {
      // Previous task failed/timed out - clear the queue so next message isn't blocked
      queues[userId] = Promise.resolve();
    });
  });
}

module.exports = { acquireUserMutex, touchMutexProgress };
