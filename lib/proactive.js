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
// them). Only Pulse used to keep them; notices could arrive in the night.
function quietNow(userStore, at = new Date()) {
  const settings = userStore?.profile?.settings || {};
  const ps = settings.pulse_settings || {};
  if (ps.quietEnabled === false) return false;
  // Numbers, whatever wrote them: "22" > "7" is false as text.
  const start = Number(ps.quietStart ?? settings.pulse_quiet_start ?? settings.quietStart ?? 22);
  const end = Number(ps.quietEnd ?? settings.pulse_quiet_end ?? settings.quietEnd ?? 7);
  // Where they are now: after a landing, quiet hours follow the new place.
  const hour = require("./timezone").userHour(require("./time-context").personZone(userStore, at), at);
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
}

/**
 * Returns the chat_links rows proactive messages may be sent to right now.
 * @param {string} userId
 * @param {object} userStore - loaded UserStore (for settings)
 * @param {Array} chatLinks - rows from chat_links (platform, platform_user_id)
 */
async function getProactiveTargets(userId, userStore, chatLinks) {
  const settings = userStore?.profile?.settings || {};
  const ps = settings.pulse_settings || {};
  const selected = ps.deliveryPlatforms || settings.pulse_platforms || settings.deliveryPlatforms || [];
  if (!selected.length) return []; // nothing chosen = nothing sent, matching the UI

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

// An unprompted message, to each chat app the person chose: sent now, or in
// quiet hours held (held_messages) and sent when they end, so nothing raised
// in the night is lost and nothing arrives in it. textFor(link) writes it for
// that place. True when it went or is held, false when there is nowhere to
// send it (no chat app chosen), so the caller can try again later.
async function deliverUnprompted(userId, userStore, chatLinks, textFor) {
  const targets = await getProactiveTargets(userId, userStore, chatLinks);
  if (!targets.length) return false;
  const quiet = quietNow(userStore);
  const { sendToPlatform } = require("./messaging");
  let reached = false;
  for (const t of targets) {
    const text = await textFor(t);
    if (quiet) {
      const { error } = await supabase.from("held_messages").insert({ user_id: userId, platform: t.platform, platform_user_id: t.platform_user_id, text });
      if (error) console.error(`[proactive] ${userId}: could not hold a message for ${t.platform}: ${error.message}`);
      else reached = true;
      continue;
    }
    try { await sendToPlatform(t.platform, t.platform_user_id, text); reached = true; }
    catch (e) { console.error(`[proactive] ${userId}: send via ${t.platform} failed: ${e.message}`); }
  }
  if (quiet && reached) console.log(`[proactive] ${userId}: quiet hours, a message is held until they end`);
  return reached;
}

// Messages held in quiet hours go once they end, oldest first. One that
// cannot be sent for a day is dropped rather than tried for ever.
async function sendHeld(userId, loadStore) {
  const { data: held } = await supabase.from("held_messages").select("id, platform, platform_user_id, text, created_at")
    .eq("user_id", userId).order("created_at", { ascending: true });
  if (!held?.length) return 0;
  if (quietNow(await loadStore())) return 0;
  const { sendToPlatform } = require("./messaging");
  let sent = 0;
  for (const h of held) {
    let gone = false;
    try { await sendToPlatform(h.platform, h.platform_user_id, h.text); gone = true; sent++; }
    catch (e) { console.error(`[proactive] ${userId}: held message via ${h.platform} failed: ${e.message}`); }
    if (!gone && Date.now() - Date.parse(h.created_at) < 86400000) continue;
    const { error } = await supabase.from("held_messages").delete().eq("id", h.id);
    if (error) console.error(`[proactive] ${userId}: could not clear a held message: ${error.message}`);
  }
  return sent;
}

// Every five minutes, anything held whose quiet hours are over.
function start() {
  const run = async () => {
    try {
      const userId = require("./admin").getAdminUserId();
      await sendHeld(userId, () => require("../user-store").UserStore.load(userId));
    } catch (e) { console.error("[proactive] held messages:", e.message); }
  };
  setInterval(run, 5 * 60 * 1000).unref?.();
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

module.exports = { getProactiveTargets, deliverUnprompted, sendHeld, start, quietNow, isWhatsAppWindowOpen, markWhatsAppInbound, WA_WINDOW_MS };
