// lib/context.js — Shared state for the bot with per-task user context.
//
// User-scoped fields (activeUserStore/activeUserId/activeChatId/activeThreadId/
// activePlatform/store/surfacedNodes) are backed by AsyncLocalStorage: every
// mutex-held task runs inside its own context bubble, so concurrent work for
// DIFFERENT users cannot clobber each other's "active user" no matter which of
// the ~320 call sites reads ctx. Bubbles inherit the currently visible values
// at entry (so legacy flows that set globals before acquiring the mutex keep
// working), and all writes inside a bubble stay inside it.
//
// Infra fields (bot clients, queues, pendingConfirmations, MCP, crons) remain
// genuinely global on purpose: they must be shared across tasks.

const { AsyncLocalStorage } = require("async_hooks");
const _als = new AsyncLocalStorage();

// Tripwire: user-scoped ctx touched OUTSIDE any bubble means a code path is
// missing mutex/bubble wrapping and could interleave with other background
// work. Logged (throttled) so stragglers surface in production logs; once
// logs stay quiet, the global fallback can be removed entirely so missed
// paths fail loudly. CTX_STRICT=off disables.
const _strictWarned = new Map();
function _warnUnbubbled(field) {
  if ((process.env.CTX_STRICT || "warn") === "off") return;
  const now = Date.now();
  if (now - (_strictWarned.get(field) || 0) < 600000) return; // 10 min per field
  _strictWarned.set(field, now);
  const stack = new Error().stack.split("\n").slice(2, 5).join("\n");
  console.warn(`[ctx-strict] user-scoped ctx.${field} accessed outside a context bubble:\n${stack}`);
}

let _store = {
  conversations: {},
  schedules: [],
  notes: {},
  summaries: {},
  attachments: {},
  location: null,
  pulse: {
    enabled: false,
    intervalMinutes: 20,
    proactiveLevel: "medium",
    quietStart: 22,
    quietEnd: 7,
    deliveryPlatforms: [],
    lastRun: null,
    lastNotified: null,
  },
};

let _activeUserStore = null;
let _activeUserId = null;
let _activeChatId = null;
let _activeThreadId = null;
let _surfacedNodes = new Set(); // Tracks knowledge node titles already injected in this thread
const _platformByUser = new Map(); // Per-user platform context (prevents cross-user race conditions)

let _bot = null;
let _defaultLLMClient = null;
let _discordClient = null;
let _expressApp = null;

// MCP state
let _mcpClients = {};
let _allMcpTools = [];
let _mcpConfig = null;

// Scheduling & pulse
let _cronJobs = {};
let _pulseIntervals = {};

// Queues
let _userQueues = {};
let _userMessageQueues = {};

// Confirmation & location
let _pendingConfirmations = {};
let _pendingLocationRequests = {};

// Telegram polling errors
let _pollingErrors = 0;

// Per-user chat activity timestamps (userId -> epoch ms)
const _lastChatActivity = new Map();

// Per-user message queue — ensures messages are processed sequentially
// Uses the shared per-user mutex so agents and chat handlers don't corrupt ctx state.
function queueUserMessage(userId, handler) {
  const { acquireUserMutex } = require("./user-mutex");
  // Signal BEFORE acquiring the mutex: an in-flight request for this user
  // checks this counter between tool iterations and yields (parks its work,
  // answers arrive later as a follow-up) so the new message runs sooner.
  if (!module.exports.pendingIncoming) module.exports.pendingIncoming = {};
  module.exports.pendingIncoming[userId] = (module.exports.pendingIncoming[userId] || 0) + 1;
  const wrapped = async () => {
    module.exports.pendingIncoming[userId] = Math.max(0, (module.exports.pendingIncoming[userId] || 1) - 1);
    return handler();
  };
  return acquireUserMutex(userId, wrapped).catch((err) => {
    if (err.message === "Mutex timeout") {
      console.error(`[Queue] Mutex timeout for user ${userId}. Previous request took too long.`);
      // Try to send an apology via the active platform
      try {
        const { sendToPlatform } = require("./messaging");
        const chatId = module.exports.activeChatId;
        const platform = module.exports.activePlatform;
        if (chatId && platform) {
          sendToPlatform(platform, chatId, "Sorry, that request stalled and I had to stop it. Ask me again and I'll take another run at it.").catch(() => {});
        }
      } catch (e) { /* best effort */ }
    }
    throw err;
  });
}

// Enter a fresh per-task context bubble that inherits the currently visible
// user context. All ctx writes inside fn stay inside the bubble; concurrent
// tasks for other users are unaffected. Used by acquireUserMutex so every
// serialized task is automatically isolated.
function runWithInheritedContext(fn) {
  const bubble = {
    userStore: module.exports.activeUserStore,
    userId: module.exports.activeUserId,
    chatId: module.exports.activeChatId,
    threadId: module.exports.activeThreadId,
    platform: module.exports.activePlatform,
    store: module.exports.store,
    surfacedNodes: module.exports.surfacedNodes,
  };
  return _als.run(bubble, fn);
}

module.exports = {
  queueUserMessage,
  runWithInheritedContext,
  // Store — getter/setter because swapToCloudStore reassigns it
  get store() { const b = _als.getStore(); return b ? b.store : _store; },
  set store(v) { const b = _als.getStore(); if (b) b.store = v; else _store = v; },

  get activeUserStore() { const b = _als.getStore(); if (b) return b.userStore; if (_activeUserStore) _warnUnbubbled("activeUserStore"); return _activeUserStore; },
  set activeUserStore(v) { const b = _als.getStore(); if (b) { b.userStore = v; } else { if (v) _warnUnbubbled("activeUserStore(write)"); _activeUserStore = v; } },

  get activeUserId() { const b = _als.getStore(); if (b) return b.userId; if (_activeUserId) _warnUnbubbled("activeUserId"); return _activeUserId; },
  set activeUserId(v) { const b = _als.getStore(); if (b) { b.userId = v; } else { if (v) _warnUnbubbled("activeUserId(write)"); _activeUserId = v; } },

  get activeChatId() { const b = _als.getStore(); return b ? b.chatId : _activeChatId; },
  set activeChatId(v) { const b = _als.getStore(); if (b) b.chatId = v; else _activeChatId = v; },

  get activeThreadId() { const b = _als.getStore(); return b ? b.threadId : _activeThreadId; },
  set activeThreadId(v) { const b = _als.getStore(); if (b) b.threadId = v; else _activeThreadId = v; },

  get surfacedNodes() { const b = _als.getStore(); return b ? b.surfacedNodes : _surfacedNodes; },
  resetSurfacedNodes() {
    const b = _als.getStore();
    if (b) b.surfacedNodes = new Set();
    else _surfacedNodes = new Set();
  },

  get activePlatform() {
    const b = _als.getStore();
    if (b) return b.platform || null;
    return _platformByUser.get(_activeUserId) || null;
  },
  set activePlatform(v) {
    const b = _als.getStore();
    if (b) { b.platform = v || null; return; }
    if (_activeUserId) {
      if (v) _platformByUser.set(_activeUserId, v);
      else _platformByUser.delete(_activeUserId);
    }
  },
  // Direct cleanup for use by cleanupUserContext (needs userId param since _activeUserId gets cleared first)
  clearPlatformForUser(userId) {
    const b = _als.getStore();
    if (b) b.platform = null;
    _platformByUser.delete(userId);
  },

  get bot() { return _bot; },
  set bot(v) { _bot = v; },

  get defaultLLMClient() { return _defaultLLMClient; },
  set defaultLLMClient(v) { _defaultLLMClient = v; },
  // Backward-compat alias
  get anthropic() { return _defaultLLMClient; },
  set anthropic(v) { _defaultLLMClient = v; },

  get discordClient() { return _discordClient; },
  set discordClient(v) { _discordClient = v; },

  get expressApp() { return _expressApp; },
  set expressApp(v) { _expressApp = v; },

  get mcpClients() { return _mcpClients; },
  set mcpClients(v) { _mcpClients = v; },

  get allMcpTools() { return _allMcpTools; },
  set allMcpTools(v) { _allMcpTools = v; },

  get mcpConfig() { return _mcpConfig; },
  set mcpConfig(v) { _mcpConfig = v; },

  get cronJobs() { return _cronJobs; },
  set cronJobs(v) { _cronJobs = v; },

  get pulseIntervals() { return _pulseIntervals; },
  set pulseIntervals(v) { _pulseIntervals = v; },

  get userQueues() { return _userQueues; },
  set userQueues(v) { _userQueues = v; },

  get userMessageQueues() { return _userMessageQueues; },
  set userMessageQueues(v) { _userMessageQueues = v; },

  get pendingConfirmations() { return _pendingConfirmations; },
  set pendingConfirmations(v) { _pendingConfirmations = v; },

  get pendingLocationRequests() { return _pendingLocationRequests; },
  set pendingLocationRequests(v) { _pendingLocationRequests = v; },

  get pollingErrors() { return _pollingErrors; },
  set pollingErrors(v) { _pollingErrors = v; },

  // Chat activity tracking for enrichment yielding
  markChatActive(userId) { _lastChatActivity.set(userId, Date.now()); },
  isChatIdle(userId, graceMs = 30000) {
    const last = _lastChatActivity.get(userId);
    return !last || (Date.now() - last > graceMs);
  },

  // Default store shape (for resetting)
  DEFAULT_STORE: {
    conversations: {},
    schedules: [],
    notes: {},
    summaries: {},
    attachments: {},
    location: null,
    pulse: {
      enabled: false,
      intervalMinutes: 20,
      proactiveLevel: "medium",
      quietStart: 22,
      quietEnd: 7,
      deliveryPlatforms: [],
      lastRun: null,
      lastNotified: null,
    },
  },
};
