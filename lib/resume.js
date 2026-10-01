// lib/resume.js — In-flight message ledger + post-deploy resume.
//
// Every deploy restarts the bot and kills whatever it was working on; without
// this, the user's message dies silently behind a "Thinking..." bubble.
// queuedAsk marks each user-facing message in-flight in Supabase and clears it
// on completion. On startup, recent unfinished messages are re-run and the
// user is told what happened.

const { supabase } = require("./db");

const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 2;

async function markInflight(userId, platform, chatId, message, attempts) {
  try {
    const { error } = await supabase.from("facts").upsert({
      user_id: userId,
      key: "_inflight_" + userId,
      value: JSON.stringify({
        platform: platform || "web",
        chatId: chatId || null,
        message: String(message).substring(0, 4000),
        startedAt: new Date().toISOString(),
        attempts: attempts || 1,
      }),
    }, { onConflict: "user_id,key" });
    // Losing this is not visible until a redeploy: the message the user is
    // waiting on simply never resumes, and nothing says why.
    if (error) console.error(`[Resume] could not record in-flight message for ${userId}: ${error.message}. It will not resume if this process dies.`);
  } catch (e) {
    console.error(`[Resume] could not record in-flight message for ${userId}: ${e.message}`);
  }
}

async function clearInflight(userId) {
  try {
    const { error } = await supabase.from("facts").delete().eq("user_id", userId).eq("key", "_inflight_" + userId);
    // A stale marker makes the NEXT boot resend a message already answered.
    if (error) console.error(`[Resume] could not clear the in-flight marker for ${userId}: ${error.message}. It may be answered twice.`);
  } catch (e) {
    console.error(`[Resume] could not clear the in-flight marker for ${userId}: ${e.message}`);
  }
}

async function resumeInterruptedMessages() {
  const { data: rows } = await supabase
    .from("facts").select("user_id, value").like("key", "_inflight_%");
  if (!rows || rows.length === 0) return;
  console.log(`[Resume] Found ${rows.length} interrupted message(s)`);

  const ctx = require("./context");
  const { UserStore } = require("../user-store");
  const { swapToCloudStore, cleanupUserContext } = require("./storage");
  const { sendToPlatform } = require("./messaging");
  const { queuedAsk } = require("./engine");

  const deliver = async (userId, platform, chatId, text) => {
    try {
      if (platform === "web") {
        const { error } = await supabase.from("web_messages").insert({ user_id: userId, direction: "outbound", content: text, status: "complete" });
        if (error) throw new Error(`web delivery write failed: ${error.message}`);
      } else {
        await sendToPlatform(platform, chatId, text);
      }
    } catch (e) {
      // The whole point of resume is that the user gets the answer they were
      // waiting for. Failing to deliver it silently defeats the feature.
      console.error(`[Resume] could not deliver a resumed reply to ${platform}/${chatId}: ${e.message}`);
    }
  };

  for (const row of rows) {
    const userId = row.user_id;
    let info;
    try {
      info = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      if (info && typeof info.value === "string") info = JSON.parse(info.value);
    } catch (_) { await clearInflight(userId); continue; }
    if (!info?.message) { await clearInflight(userId); continue; }

    const age = Date.now() - new Date(info.startedAt || 0).getTime();
    if (isNaN(age) || age > MAX_AGE_MS) { await clearInflight(userId); continue; }

    try {
      if ((info.attempts || 1) >= MAX_ATTEMPTS) {
        await clearInflight(userId);
        await deliver(userId, info.platform, info.chatId,
          "I got interrupted twice while answering your last message, so I've stopped retrying. Please send it again.");
        continue;
      }

      console.log(`[Resume] Re-running interrupted message for ${userId} (${info.platform}, attempt ${(info.attempts || 1) + 1})`);
      // Under the user mutex: gives this task its own context bubble AND
      // serializes against the user's live chat (they may already be messaging
      // again post-deploy; their new message shouldn't interleave with this).
      const { acquireUserMutex } = require("./user-mutex");
      await acquireUserMutex(userId, async () => {
        const userStore = await UserStore.load(userId);
        swapToCloudStore(userStore, userId, info.chatId || userId);
        ctx.activePlatform = info.platform;
        try {
          await deliver(userId, info.platform, info.chatId,
            "Heads up: a system update interrupted me mid-reply. Picking your message back up now.");

          const response = await queuedAsk(userId, info.message, null, info.chatId, { _resumeAttempt: (info.attempts || 1) + 1 });
          if (response) await deliver(userId, info.platform, info.chatId, response);
          await userStore.save().catch(() => {});
        } finally {
          cleanupUserContext();
        }
      });
    } catch (e) {
      console.error(`[Resume] Failed for ${userId}: ${e.message}`);
      await clearInflight(userId);
    }
  }
}

module.exports = { markInflight, clearInflight, resumeInterruptedMessages };
