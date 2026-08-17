// lib/storage.js — Store management, cloud adapter, user context lifecycle

const ctx = require("./context");

function saveStore() {
  if (ctx.activeUserStore) {
    syncAdapterBack();
    ctx.activeUserStore.save().catch(err => console.error("Cloud save error:", err.message));
  }
}

function swapToCloudStore(userStore, userId, chatId) {
  ctx.activeUserStore = userStore;
  ctx.activeUserId = userId;
  ctx.activeChatId = chatId;

  ctx.store = {
    conversations: { [userId]: userStore.conversations },
    facts: userStore.facts || {},
    schedules: userStore.schedules,
    attachments: { [userId]: userStore.attachments },
    location: userStore.location,
    pulse: userStore.pulse,
    userRules: userStore.userRules || [],
  };
  ctx.bridgeConnected = userStore.bridgeConnected || false;
  ctx.activeThreadId = userStore.activeThreadId || null;
}

function syncAdapterBack() {
  if (!ctx.activeUserStore || !ctx.activeUserId) return;
  const uid = ctx.activeUserId;
  ctx.activeUserStore.conversations = ctx.store.conversations[uid] || [];
  ctx.activeUserStore.facts = ctx.store.facts;
  ctx.activeUserStore.schedules = ctx.store.schedules;
  ctx.activeUserStore.attachments = ctx.store.attachments[uid] || [];
  ctx.activeUserStore.location = ctx.store.location;
  ctx.activeUserStore.pulse = ctx.store.pulse;
  ctx.activeUserStore.activeThreadId = ctx.activeThreadId;
  ctx.activeUserStore.markDirty("conversations");
  ctx.activeUserStore.markDirty("facts");
  ctx.activeUserStore.markDirty("pulse");
  ctx.activeUserStore.markDirty("location");
}

function cleanupUserContext() {
  // Clear per-user platform Map entry before nulling userId
  if (ctx.activeUserId) ctx.clearPlatformForUser(ctx.activeUserId);
  ctx.activeUserStore = null;
  ctx.activeUserId = null;
  ctx.activeChatId = null;
  ctx.activeThreadId = null;
  // Reset store to empty defaults
  ctx.store = {
    conversations: {}, schedules: [], facts: {},
    attachments: {}, location: null,
    pulse: { enabled: false, intervalMinutes: 20, proactiveLevel: "medium", quietStart: 22, quietEnd: 7, deliveryPlatforms: [], lastRun: null, lastNotified: null },
    userRules: [],
  };
}

module.exports = { saveStore, swapToCloudStore, syncAdapterBack, cleanupUserContext };
