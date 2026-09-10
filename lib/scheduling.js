// lib/scheduling.js — Cron scheduling engine

const cron = require("node-cron");
const ctx = require("./context");
const { getUserLLMClient } = require("./llm");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("./storage");
const { UserStore } = require("../user-store");
const { isInternalTool, handleInternalTool } = require("./tools/handlers");
const { callMCPTool, warmUserMcp } = require("./mcp");
const { getUserMcpToolDefs } = require("./user-mcp");
const spendGuard = require("./spend-guard");
// Lazy require to avoid circular dep (engine.js → confirmation.js → engine.js)
// These are only called at runtime, not at require time
function _getAllTools() { return require("./engine").getAllTools(); }
function _buildSystemPrompt() { const e = require("./engine"); return e.buildSystemPrompt() + e.buildVolatileSystemTail(); }
// Lazy require for pulse to avoid potential load-order issues
function _startPulseForUser(userId, config) { return require("./pulse").startPulseForUser(userId, config); }

// A cron expression pinned to one day and one month describes a single date,
// because the year it was written for is the only one the author had in mind.
function isDatedOneOff(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length < 5) return false;
  const [, , dom, mon] = f;
  return /^\d+$/.test(dom) && /^\d+$/.test(mon);
}

function registerSchedule(schedule) {
  if (!schedule.enabled) return;
  if (ctx.cronJobs[schedule.name]) {
    ctx.cronJobs[schedule.name].stop();
  }

  console.log(`Registering schedule: ${schedule.name} (${schedule.cron})`);

  // Fire in the timezone the schedule was created in (server runs UTC).
  // Older schedules without a stored timezone keep the historical London behaviour.
  const cronOpts = { timezone: schedule.timezone || "Europe/London" };
  ctx.cronJobs[schedule.name] = cron.schedule(schedule.cron, async () => {
    console.log(`Schedule firing: ${schedule.name}`);
    const targetChatId = schedule._chatId;
    const targetUserId = schedule._userId;
    if (!targetChatId || !targetUserId) {
      console.error(`Schedule ${schedule.name}: missing chat/user ID, skipping`);
      return;
    }
    try {
      // Under the user mutex: own context bubble + serialized against the
      // user's live chat so a firing schedule can't interleave with it.
      const { acquireUserMutex } = require("./user-mutex");
      await acquireUserMutex(targetUserId, async () => {
        const userStore = await UserStore.load(targetUserId);
        swapToCloudStore(userStore, targetUserId, targetChatId);
        // Reply where the schedule was set up. A schedule with no platform
        // recorded used to assume Telegram, which on an install without
        // Telegram meant a crash at delivery; fall back to the user's first
        // linked chat instead.
        let deliverPlatform = schedule._platform;
        if (!deliverPlatform && targetChatId === targetUserId) deliverPlatform = "web";
        if (!deliverPlatform) {
          try {
            const { data: links } = await require("./db").supabase.from("chat_links").select("platform").eq("user_id", targetUserId).limit(1);
            deliverPlatform = (links && links[0] && links[0].platform) || (ctx.bot ? "telegram" : "web");
          } catch { deliverPlatform = ctx.bot ? "telegram" : "web"; }
        }
        try {
          const response = await runScheduledPrompt(schedule.prompt, targetUserId, targetChatId, deliverPlatform);
          // Reply where the schedule was set up, not always on Telegram. The
          // header is a human label, not schedule.name: a message opening with
          // "[hurlands-overgrip-colours-v2]" reads as machinery leaking, which
          // is exactly what got /bug'd (2026-08-13).
          const { sendToPlatform } = require("./messaging");
          await sendToPlatform(deliverPlatform, targetChatId, `[Reminder]\n\n${response}`);

          // Record what was sent, or the conversation has no trace of it and
          // the next thing the user says about this message meets an assistant
          // that does not know it sent anything.
          const { getConversation } = require("./conversation");
          getConversation(targetUserId).push({ role: "assistant", content: `[Scheduled reminder "${schedule.name}" fired] ${response}` });

          // Save any changes made during the scheduled task
          saveStore();

          // Record that it ran. Nothing wrote this before, so a schedule that
          // never fired and one that fired every day looked identical, and
          // there was no way to answer "did that actually happen".
          const { supabase } = require("../user-store");
          await supabase.from("schedules")
            .update({ last_run: new Date().toISOString() })
            .eq("user_id", targetUserId).eq("name", schedule.name);

          // A one-off written as cron is still cron, and cron has no year, so
          // "03:10 on 28 July" quietly means every 28 July for ever. If the
          // date is pinned to a single day and month, it was meant to happen
          // once, so retire it rather than leave it sitting in Upcoming
          // waiting to surprise someone in twelve months.
          // What it was created as, and only guessing for schedules made
          // before the flag existed. Guessing alone would delete a genuine
          // annual reminder after its first year.
          const oneOff = schedule.run_once === true
            || (schedule.run_once == null && isDatedOneOff(schedule.cron));
          if (oneOff) {
            // Archive rather than delete: the user should be able to look
            // back at what ran and when, especially since a schedule acts on
            // their behalf. Registration only loads enabled rows, so an
            // archived one can never fire again or come back on reboot.
            await supabase.from("schedules")
              .update({ enabled: false, archived_at: new Date().toISOString() })
              .eq("user_id", targetUserId).eq("name", schedule.name);
            if (ctx.cronJobs[schedule.name]) { ctx.cronJobs[schedule.name].stop(); delete ctx.cronJobs[schedule.name]; }
            console.log(`Schedule ${schedule.name}: one-off, archived after running`);
          }
        } finally {
          cleanupUserContext();
        }
      });
    } catch (error) {
      console.error(`Schedule error (${schedule.name}):`, error.message, "\n", String(error.stack || "").split("\n").slice(1, 5).join("\n"));
      // Same delivery rule as the success path: the chat the schedule lives
      // in, not always Telegram, and a sentence rather than an internal tag.
      try {
        const { sendToPlatform } = require("./messaging");
        await sendToPlatform(schedule._platform || "telegram", targetChatId, `Your reminder "${schedule.name}" hit an error: ${error.message}`);
      } catch (_) {}
    }
  }, cronOpts);
}

function registerAllSchedules() {
  // In cloud mode, load all users with active schedules/pulse from Supabase
  UserStore.getActiveUsers().then((users) => {
    let schedCount = 0;

    for (const user of users) {
      for (const schedule of user.schedules) {
        registerSchedule(schedule);
        schedCount++;
      }
    }

    console.log(`Startup: registered ${schedCount} schedules across ${users.length} users.`);
  }).catch((err) => {
    console.error("Failed to load active users on startup:", err.message);
  });
}

async function runScheduledPrompt(prompt, userId, chatId = null, platform = null) {
  // The framing matters: without it a task prompt like "Remind James
  // (WhatsApp) to ..." reads as an instruction to go and operate WhatsApp,
  // and the model burns its iterations on raw graph.facebook.com calls
  // instead of writing the reminder (2026-08-13).
  const messages = [{ role: "user", content: `[Scheduled task firing. Whatever you write as your final reply is delivered straight to the user's chat by the scheduler itself: never use a send tool or a raw API to reach them.]\n\n${prompt}` }];
  await warmUserMcp(userId);
  const tools = [..._getAllTools(), ...getUserMcpToolDefs(userId)];
  // On-demand tools (the cloud browser among them) are listed by name in
  // the prompt and unlocked by get_tool_details; the chat engine adds the
  // unlocked schema to its next call, and this loop has to do the same or a
  // scheduled task can see a tool and never call it.
  const { INTERNAL_TOOLS } = require("./tools/definitions");
  const unlockTool = (name) => {
    if (tools.find((t) => t.name === name)) return;
    const def = INTERNAL_TOOLS.find((t) => t.name === name);
    if (def) tools.push({ name: def.name, description: def.description, input_schema: def.input_schema });
    else { const m = getUserMcpToolDefs(userId).find((t) => t.name === name); if (m) tools.push(m); }
  };
  const { client: llm, model: defaultModel } = getUserLLMClient(userId);

  let maxIterations = 10;
  while (maxIterations > 0) {
    maxIterations--;

    const apiParams = {
      model: defaultModel,
      max_tokens: 4096,
      system: _buildSystemPrompt(),
      messages: messages,
    };
    if (tools.length > 0) apiParams.tools = tools;

    const response = await llm.messages.create(apiParams);

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          let result;
          if (isInternalTool(block.name)) {
            // Same identity injection as every other tool-executing path
            // (engine, agents, automations). Without it search_cache ran with
            // userId=undefined here, every lookup failed, and the model
            // flailed until the iteration cap (2026-08-13).
            const schedInput = { ...block.input, _userId: userId, _chatId: chatId, _platform: platform };
            const schedIntent = spendGuard.spendIntent(block.name, schedInput);
            if (schedIntent) {
              // Money: ask the user in chat and carry on; yes runs the held call.
              const page = block.name === "sandbox_browse" ? await spendGuard.readCheckout(userId, schedIntent.at) : spendGuard.lastPage(userId);
              const verdict = await spendGuard.assess({ userId, userStore: ctx.activeUserStore, toolName: block.name, source: "scheduled", intent: schedIntent, page });
              if (verdict.action === "refuse") result = { error: verdict.message };
              else if (verdict.action === "allow") {
                result = await handleInternalTool(block.name, schedInput);
                await spendGuard.ledgerUpdate(verdict.ledgerId, { status: result && result.error ? "failed" : "completed" });
              } else {
                result = await spendGuard.holdForUser({ userId, platform, chatId, toolName: block.name, toolInput: schedInput, verdict, source: "scheduled", label: "A scheduled task" });
              }
            } else {
              result = await handleInternalTool(block.name, schedInput);
            }
            if (result && result.error) console.log(`[tool-error] scheduled ${block.name}: ${String(result.error).substring(0, 200)}`);
            if (block.name === "get_tool_details" && result && !result.error && result.name) unlockTool(result.name);
          } else {
            console.log(`  [scheduled] Calling tool: ${block.name}`);
            result = await callMCPTool(block.name, block.input);
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result.content || result),
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    let finalText = "";
    for (const block of response.content) {
      if (block.type === "text") finalText += block.text;
    }
    return finalText;
  }

  // Out of iterations mid-tool-chatter. What reaches the user must still be
  // the content of their reminder, never a status line about tool loops, so
  // ask for the wrap-up from what was already gathered, tools ignored.
  try {
    const wrap = "You are out of tool budget. Do not call any more tools. Write the final message for the user now from what you already have; if something could not be verified, say so briefly inside the message.";
    const last = messages[messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text: wrap });
    else messages.push({ role: "user", content: wrap });
    const finalResp = await llm.messages.create({
      model: defaultModel, max_tokens: 4096, system: _buildSystemPrompt(), messages,
      ...(tools.length > 0 ? { tools } : {}),
    });
    let text = "";
    for (const block of finalResp.content) if (block.type === "text") text += block.text;
    if (text.trim()) return text.trim();
  } catch (e) {
    console.error(`Scheduled wrap-up call failed: ${e.message}`);
  }
  // Even the wrap-up failed: the task text itself is the least the user
  // should get, since for a reminder it IS the reminder.
  return `I had trouble putting this reminder together, so here it is as it was written:\n\n${prompt.substring(0, 600)}`;
}

module.exports = { registerSchedule, registerAllSchedules, runScheduledPrompt, isDatedOneOff };
