// lib/proactive.js — Resolve where a user's proactive messages (pulse, flight
// updates, pinned briefings) may be delivered.
//
// Rule: proactive messages go ONLY to the chat apps the user selected in
// pulse settings (multi-select delivers to all of them). No fallback to
// unselected apps.
//
// WhatsApp special case: WhatsApp Business API only accepts free-form
// business messages within 24h of the user's last inbound WhatsApp message
// (the customer service window). We track that timestamp and include
// WhatsApp only while the window is open; when closed, delivery continues
// to the user's other selected apps.

const { supabase } = require("../user-store");

const WA_WINDOW_MS = 23 * 60 * 60 * 1000; // 23h: safety margin inside Meta's 24h

async function isWhatsAppWindowOpen(userId) {
  try {
    const { data } = await supabase.from("facts").select("value")
      .eq("user_id", userId).eq("key", "_wa_last_inbound").single();
    if (!data?.value) return false;
    const ts = new Date(String(data.value).replace(/^"|"$/g, "")).getTime();
    return !isNaN(ts) && Date.now() - ts < WA_WINDOW_MS;
  } catch (_) { return false; }
}

// Quiet hours, in the person's own time zone (22 to 7 unless they changed
// them), for every message Closedhand sends unprompted. Only Pulse used to
// keep them; notices and the rest could arrive in the night.
function quietNow(userStore, at = new Date()) {
  const settings = userStore?.profile?.settings || {};
  const ps = settings.pulse_settings || {};
  if (ps.quietEnabled === false) return false;
  const start = ps.quietStart ?? settings.pulse_quiet_start ?? settings.quietStart ?? 22;
  const end = ps.quietEnd ?? settings.pulse_quiet_end ?? settings.quietEnd ?? 7;
  const { getUserTimezone, userHour } = require("./timezone");
  const hour = userHour(getUserTimezone({ location: userStore?.location, profile: userStore?.profile }), at);
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
}

/**
 * Returns the chat_links rows proactive messages may be sent to right now:
 * none in quiet hours, except for a message due at a set moment (anyHour: a
 * flight about to board, a check-in at the time the person chose). A caller
 * that gets none tries again later rather than marking anything told.
 * @param {string} userId
 * @param {object} userStore - loaded UserStore (for settings)
 * @param {Array} chatLinks - rows from chat_links (platform, platform_user_id)
 */
async function getProactiveTargets(userId, userStore, chatLinks, { anyHour = false } = {}) {
  const settings = userStore?.profile?.settings || {};
  const ps = settings.pulse_settings || {};
  const selected = ps.deliveryPlatforms || settings.pulse_platforms || settings.deliveryPlatforms || [];
  if (!selected.length) return []; // nothing chosen = nothing sent, matching the UI
  if (!anyHour && quietNow(userStore)) { console.log(`[proactive] ${userId}: quiet hours, held for later`); return []; }

  const targets = [];
  for (const link of (chatLinks || [])) {
    if (!selected.includes(link.platform)) continue;
    if (link.platform === "whatsapp") {
      if (await isWhatsAppWindowOpen(userId)) targets.push(link);
      else console.log(`[proactive] ${userId}: WhatsApp selected but 24h window closed, skipping WA delivery`);
      continue;
    }
    targets.push(link);
  }
  return targets;
}

// Called by the WhatsApp inbound handler; throttled to one write per 10 min.
const _lastMark = new Map();
async function markWhatsAppInbound(userId) {
  const now = Date.now();
  if (now - (_lastMark.get(userId) || 0) < 600000) return;
  _lastMark.set(userId, now);
  try {
    await supabase.from("facts").upsert({
      user_id: userId, key: "_wa_last_inbound", value: new Date(now).toISOString(),
    }, { onConflict: "user_id,key" });
  } catch (_) {}
}

module.exports = { getProactiveTargets, quietNow, isWhatsAppWindowOpen, markWhatsAppInbound, WA_WINDOW_MS };
