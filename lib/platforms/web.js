// lib/platforms/web.js - Web chat platform handler
// Picks up inbound messages from web_messages table (inserted by webapp)
// Processes through askClaude and writes responses back

const ctx = require("../context");
const { UserStore } = require("../../user-store");
const { saveStore, swapToCloudStore } = require("../storage");
const { queuedAsk } = require("../engine");
const { supabase } = require("../db");

let realtimeChannel = null;

function setup() {
  // WebSocket chat (web-chat-ws.js) is now the primary path.
  // This Supabase handler is DISABLED to prevent duplicate processing
  // and mutex deadlocks. Kept for reference only.
  //
  // If WebSocket is down, messages sent via POST /api/chat/send will
  // still be inserted into web_messages but won't be processed until
  // the bot restarts or the WebSocket reconnects.

  // Clean up any old stuck pending messages on startup
  supabase.from("web_messages")
    .update({ status: "error" })
    .eq("direction", "inbound")
    .in("status", ["pending", "processing"])
    .then(() => console.log("[Web] Cleaned up stale pending messages"))
    .catch(() => {});

  console.log("[Web] Platform handler ready (Supabase polling disabled, WebSocket is primary)");
}

async function pollPendingMessages() {
  try {
    const { data: pending } = await supabase
      .from("web_messages")
      .select("*")
      .eq("direction", "inbound")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(10);

    if (!pending || pending.length === 0) return;

    for (const msg of pending) {
      await handleWebMessage(msg).catch((err) => {
        console.error("[Web] Poll handler error:", err.message);
      });
    }
  } catch (err) {
    // Silently ignore polling errors (table might not exist yet)
  }
}

async function handleWebMessage(msg) {
  const userId = msg.user_id;
  if (!userId || !msg.content) return;

  // Mark as processing to avoid duplicate handling
  const { error: updateErr } = await supabase
    .from("web_messages")
    .update({ status: "processing" })
    .eq("id", msg.id)
    .eq("status", "pending");

  // If update affected 0 rows, another instance already grabbed it
  if (updateErr) return;

  const { queueUserMessage } = ctx;

  queueUserMessage(userId, async () => {
    const userStore = await UserStore.load(userId);
    // For web, chatId is the userId itself (no separate platform chat ID)
    swapToCloudStore(userStore, userId, userId);
    ctx.activePlatform = "web";
    require("../workspace-cache").maybeRefreshOnSessionStart(userStore, userId);

    try {
      // Pending confirmations are intercepted inside queuedAsk (single chokepoint)
      const response = await queuedAsk(userId, msg.content, null, userId);

      // Null response = request yielded to a newer message (answer follows later)
      if (response) await sendWebMessage(userId, response);

      // Mark inbound message as complete
      await supabase
        .from("web_messages")
        .update({ status: "complete" })
        .eq("id", msg.id);

      await userStore.save();
    } catch (err) {
      console.error("[Web] ask error:", err.message);

      // Write error response
      await sendWebMessage(userId, "Sorry, something went wrong. Please try again.");

      await supabase
        .from("web_messages")
        .update({ status: "error" })
        .eq("id", msg.id);
    }
  });
}

async function sendWebMessage(userId, text) {
  const { error } = await supabase.from("web_messages").insert({
    user_id: userId,
    direction: "outbound",
    content: text,
    status: "complete",
  });

  if (error) {
    console.error("[Web] Failed to send message:", error.message);
  }
}

module.exports = { setup, sendWebMessage };
