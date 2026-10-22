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

// Where the person is, as every prompt states it. The saved location is the
// one place this lives: it moves when they share a position, land or their
// phone's clock changes zone, which a pinned fact never did.
function locationLine(location) {
  if (!location) return "No location saved.";
  // A position whose town couldn't be looked up has no name.
  const named = location.name ? `${location.name} ` : "";
  // A place taken from a landing is where the plane came down, not
  // necessarily where they went next.
  const landed = location.source === "flight" && location.landedAt
    ? ` Set when their flight landed at ${location.landedAt}, so they are most likely in that area; ask if a nearer place matters.` : "";
  // Their phone's clock moved to another zone after this was saved.
  const moved = require("./phone-zone").movedZone(location);
  const stale = moved
    ? ` This is probably out of date: their phone's clock changed to ${moved} after it was saved. Use that time zone, and ask where they are before relying on the place (weather, nearby, directions).` : "";
  return `User's current location: ${named}(${location.latitude}, ${location.longitude}). ${stale ? "" : "Use this for all location-aware requests."}${landed}${stale}`;
}

// Remove the keyboard (call after receiving location)
async function removeKeyboard(chatId, text) {
  await ctx.bot.sendMessage(chatId, text, { reply_markup: { remove_keyboard: true } });
}

module.exports = { LOCATION_STALE_MS, isLocationFresh, getLocationOrNull, locationLine, requestLocation, removeKeyboard };
