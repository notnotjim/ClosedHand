// lib/location.js — Location helpers

const ctx = require("./context");

const LOCATION_STALE_MS = 4 * 60 * 60 * 1000; // 4 hours — after this, request fresh location

function isLocationFresh() {
  if (!ctx.store.location) return false;
  const age = Date.now() - new Date(ctx.store.location.updated).getTime();
  return age < LOCATION_STALE_MS;
}

function getLocationOrNull() {
  if (ctx.store.location) return ctx.store.location;
  return null;
}

async function requestLocation(chatId, userId, originalMessage) {
  ctx.pendingLocationRequests[userId] = { originalMessage, chatId, timestamp: Date.now() };
  await ctx.bot.sendMessage(chatId, "📍 I need your location for this. Tap the button below:", {
    reply_markup: {
      keyboard: [[{ text: "📍 Share location", request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

// Remove the keyboard (call after receiving location)
async function removeKeyboard(chatId, text) {
  await ctx.bot.sendMessage(chatId, text, { reply_markup: { remove_keyboard: true } });
}

module.exports = { LOCATION_STALE_MS, isLocationFresh, getLocationOrNull, requestLocation, removeKeyboard };
