// lib/pulse.js — Proactive assistant (Pulse)
// Pulse runs as a background worker with full tool access.
// It checks everything the user has connected and messages them
// only when there's something genuinely worth knowing.

const cron = require("node-cron");
const ctx = require("./context");
const { acquireUserMutex } = require("./user-mutex");
const { UserStore } = require("../user-store");
const { swapToCloudStore, syncAdapterBack, cleanupUserContext } = require("./storage");
const { isInternalTool, handleInternalTool } = require("./tools/handlers");
const { callMCPTool } = require("./mcp");
const { INTERNAL_TOOLS } = require("./tools/definitions");
const { sendToPlatform } = require("./messaging");
const { getConversation } = require("./conversation");
const { getSkillsForPrompt } = require("./skills");

let pulseJobs = {};

const EXCLUDED_TOOLS = new Set([
  "agent_start", "agent_status", "agent_cancel",
  "disconnect_service", "connect_service",
  "pulse_toggle",
  "automation_create", "automation_pause", "automation_resume",
  "automation_run",
]);

const MAX_PULSE_ITERATIONS = 15;
const PULSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max

const LEVEL_PROMPTS = {
  low: `THRESHOLD: Life-or-death, serious financial impact, or something that will go wrong in the next hour if they don't know about it NOW. Almost nothing meets this bar. If in doubt, [NO_PULSE].
Examples that qualify: flight cancelled, meeting in 20 minutes they might miss, email from their boss marked urgent, severe weather warning for their location.
Examples that do NOT qualify: normal emails, routine calendar events, mild weather, general news, price movements under 10%.`,

  medium: `THRESHOLD: Something the user would genuinely thank you for flagging. Not routine, not obvious, not something they'd find out anyway. Think: "would they be glad I told them this, or would they think 'why are you telling me this?'"
Examples that qualify: an important email that needs a response today, a calendar clash they haven't noticed, notably bad weather before an outdoor commitment, a meaningful price move on something they're tracking.
Examples that do NOT qualify: regular emails, meetings they already know about, normal weather, generic news, anything routine or predictable.`,

  high: `THRESHOLD: Something with real value. Even at the highest setting, every message must earn its place. Cross-reference what you find: don't just report facts, connect them. Bad weather + outdoor event = worth saying. Normal weather + indoor meeting = not worth saying.
Examples that qualify: useful connections between calendar and weather, email that needs action before a deadline, something relevant to their interests that's actually new or surprising, a pattern across their data worth pointing out.
Examples that do NOT qualify: weather on its own (unless extreme), calendar events on their own (they know their own schedule), emails that aren't time-sensitive, news that isn't directly relevant to something they care about.`,
};

// IMPORTANT: All levels check at the same frequency. The level controls
// the quality bar, not the scan frequency. Even "high" should favour
// silence over noise. The user should never feel spammed.

function getPulseTools(userStore) {

  const mcpToolDefs = ctx.allMcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.inputSchema || { type: "object", properties: {} },
  }));

  const filteredInternal = INTERNAL_TOOLS.filter((tool) => {
    if (EXCLUDED_TOOLS.has(tool.name)) return false;
    return true;
  }).map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.input_schema || { type: "object", properties: {} },
  }));

  return [...filteredInternal, ...mcpToolDefs];
}

async function runPulseForUser(userId) {
  try {
    const store = await UserStore.load(userId);
    if (!store) { console.log(`Pulse: no store for ${userId}`); return; }

    const settings = store.profile?.settings || {};
    const ps = settings.pulse_settings || {};
    const level = ps.proactiveLevel || settings.pulse_level || settings.proactiveLevel || "off";
    const deliveryPlatformsConfig = ps.deliveryPlatforms || settings.pulse_platforms || settings.deliveryPlatforms || [];
    console.log(`Pulse: checking ${userId}, level=${level}, platforms=${JSON.stringify(deliveryPlatformsConfig)}`);
    if (level === "off") { console.log(`Pulse: ${userId} is off, skipping`); return; }

    // Check quiet hours IN THE USER'S TIMEZONE (server runs UTC)
    const { getUserTimezone, userHour: tzHour } = require("./timezone");
    const userTz = getUserTimezone({ location: store.location, profile: store.profile });
    if (ps.quietEnabled !== false) {
      const qStart = ps.quietStart ?? settings.pulse_quiet_start ?? settings.quietStart ?? 22;
      const qEnd = ps.quietEnd ?? settings.pulse_quiet_end ?? settings.quietEnd ?? 7;
      const hour = tzHour(userTz);
      if (qStart > qEnd) {
        if (hour >= qStart || hour < qEnd) { console.log(`Pulse: ${userId} quiet hours (${hour}h, quiet ${qStart}-${qEnd})`); return; }
      } else {
        if (hour >= qStart && hour < qEnd) { console.log(`Pulse: ${userId} quiet hours (${hour}h, quiet ${qStart}-${qEnd})`); return; }
      }
    }

    // Find delivery platform
    const platforms = ps.deliveryPlatforms || settings.pulse_platforms || settings.deliveryPlatforms || [];

    const { supabase } = require("./db");
    const { data: links } = await supabase
      .from("chat_links")
      .select("platform, platform_user_id")
      .eq("user_id", userId);

    // Proactive messages go ONLY to the apps the user selected in settings
    // (multi-select = all of them). WhatsApp is included only while Meta's
    // 24h customer-service window is open. See lib/proactive.js.
    const { getProactiveTargets } = require("./proactive");
    const targets = await getProactiveTargets(userId, store, links || []);
    if (!targets.length) { console.log(`Pulse: ${userId} no selected delivery platform available, skipping`); return; }
    const deliveryLink = targets[0]; // primary context for tool execution

    const userName = settings.preferred_name || store.profile?.display_name || "there";

    // ---- STAGE 1: novelty gate (free) ----
    // Only wake the LLMs if something actually arrived since the last check.
    const { data: pulseRow } = await supabase.from("pulse_config")
      .select("last_run").eq("user_id", userId).maybeSingle();
    const lastRun = pulseRow?.last_run ? new Date(pulseRow.last_run) : new Date(Date.now() - 24 * 3600000);
    const lookback = new Date(Math.max(lastRun.getTime(), Date.now() - 24 * 3600000)).toISOString();
    const markChecked = () => supabase.from("pulse_config")
      .upsert({ user_id: userId, last_run: new Date().toISOString() }, { onConflict: "user_id" })
      .then(() => {}).catch(() => {});

    const { data: newEmails } = await supabase.from("data_cache")
      .select("external_id, data->>from, data->>subject")
      .eq("user_id", userId).eq("type", "email")
      .gt("received_at", lookback)
      .order("received_at", { ascending: false }).limit(40);

    const soon = new Date(Date.now() + 3 * 3600000).toISOString();
    const { data: upcomingEvents } = await supabase.from("data_cache")
      .select("data->>summary, received_at")
      .eq("user_id", userId).eq("type", "event")
      .gte("received_at", new Date().toISOString()).lte("received_at", soon).limit(10);

    // ---- STAGE 2: junk-strip (free) ----
    // Scripts can't rank importance, but they know what definitely isn't important.
    const JUNK_SENDER = /no-?reply|donotreply|newsletter|notifications?@|updates?@|marketing@|mailer|noreply/i;
    const realEmails = (newEmails || []).filter(e => !JUNK_SENDER.test(e.from || ""));

    if (realEmails.length === 0 && (upcomingEvents || []).length === 0) {
      console.log(`Pulse: ${userId} nothing new since ${lookback}, skipping (no LLM)`);
      await markChecked();
      return;
    }

    // ---- STAGE 3: cheap triage over already-paid-for enrichment summaries ----
    const { cheapChat } = require("./services/usi");
    let summaryById = {};
    if (realEmails.length > 0) {
      const ids = realEmails.map(e => e.external_id);
      const { data: vecs } = await supabase.from("data_vectors")
        .select("external_id, content").eq("user_id", userId).in("external_id", ids);
      for (const v of (vecs || [])) summaryById[v.external_id] = v.content;
    }
    const triageItems = [
      ...realEmails.map(e => `EMAIL from ${e.from || "?"}: ${e.subject || ""} — ${(summaryById[e.external_id] || "").substring(0, 200)}`),
      ...(upcomingEvents || []).map(ev => `EVENT starting within 3h: ${ev.summary || "untitled"} at ${ev.received_at}`),
    ];
    const TRIAGE_BARS = {
      low: "Only flag genuinely urgent things: same-day deadlines, imminent travel, money leaving the account, direct personal requests.",
      medium: "Flag things a busy person would want a nudge about: deadlines, travel, payments, personal messages needing replies, imminent events.",
      high: "Flag anything plausibly useful to mention: the above plus notable updates, confirmations, and changes.",
    };
    const verdictRaw = await cheapChat(userId,
      `You triage new items for a proactive assistant. ${TRIAGE_BARS[level] || TRIAGE_BARS.medium} Respond ONLY with JSON: {"pulse": true/false, "flagged": ["one-line reason per flagged item"]}`,
      `New items since last check:\n${triageItems.join("\n")}`,
      300);
    let verdict = { pulse: false, flagged: [] };
    try { verdict = JSON.parse((verdictRaw || "").match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch {}
    if (!verdict.pulse || !Array.isArray(verdict.flagged) || verdict.flagged.length === 0) {
      console.log(`Pulse: ${userId} triage says nothing pulse-worthy (${triageItems.length} new items screened)`);
      await markChecked();
      return;
    }
    console.log(`Pulse: ${userId} triage flagged ${verdict.flagged.length} item(s), running composer`);

    // ---- STAGE 4: full composer (platform chat model) ----
    const tools = getPulseTools(store);

    const systemPrompt = `You are a proactive feature of ClosedHand (${userName}'s personal AI assistant).
Your job: check what's happening and decide if there's anything NEW worth telling ${userName} about.

${LEVEL_PROMPTS[level] || LEVEL_PROMPTS.medium}

${require("./timezone").nowStamp({ location: store.location, profile: store.profile })} ALL times you mention must be in the user's timezone.

STEP 1 - ALWAYS DO THIS FIRST:
Read the _pulse_last pinned fact to see what you told the user last time.

STEP 2 - CHECK FOR NEW INFORMATION:
- Check calendar and email for anything that has CHANGED since your last pulse
- Only flag things the user doesn't already know about
- An event you mentioned last hour is NOT new. A NEW email about that event IS new.

STEP 3 - DECIDE:
Ask yourself: "Is there anything here that ${userName} does NOT already know from my last message?"
- If NO: respond with exactly [NO_PULSE]
- If YES: tell them ONLY the new information. Do not repeat what you said before.

STEP 4 - SAVE:
Save a brief note via pin_fact("_pulse_last", <what you told them>) so you don't repeat next time.

RULES:
- [NO_PULSE] is the RIGHT answer most of the time. Only message when something genuinely changed.
- 2-4 sentences max. Conversational. No preamble.
- Never say "I'm Pulse" or explain what you are.
- If the only thing to say is a reminder about something you already told them, that's [NO_PULSE].
- ATTACHMENTS: If an upcoming event (next 24h) has a useful attachment (ticket, boarding pass, QR code, agenda), use fetch_attachment to fetch and send it WITH your message. But check _pulse_last first. If you already sent that attachment in a previous pulse, don't send it again.
- FLIGHTS: If the user has flights tracked (check flight_scan), upcoming departures within 24h are always worth a pulse with gate/terminal/time info.`;

    // Inject skills
    const skillsBlock = getSkillsForPrompt(store, "pulse check email calendar weather");
    const fullPrompt = systemPrompt + (skillsBlock ? "\n" + skillsBlock : "");

    // Run the tool loop (same pattern as agents.js), focused on what triage flagged
    let messages = [{ role: "user", content: `Triage flagged these new items as potentially worth a nudge:\n${verdict.flagged.map(f => "- " + f).join("\n")}\n\nVerify with your tools, check _pulse_last so you don't repeat yourself, and decide whether to message me. [NO_PULSE] is still the right answer if these turn out to be stale or already known.` }];
    let iteration = 0;
    const startTime = Date.now();
    const toolsUsed = new Set();

    while (iteration < MAX_PULSE_ITERATIONS) {
      iteration++;

      if (Date.now() - startTime > PULSE_TIMEOUT_MS) {
        console.log(`Pulse timeout for ${userName}`);
        return;
      }

      // Fast tier: pulse is a background scan that runs up to 72x/day per user.
      // It writes short nudges, so the cheap model is the right one (cost incident 2026-07-19).
      const { getInternalClient } = require("./llm");
      const { client: llm, model: pulseModel } = getInternalClient(userId, store);
      const response = await llm.messages.create({
        model: pulseModel,
        max_tokens: 2000,
        system: fullPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      if (response.stop_reason !== "tool_use") {
        // Done. Extract final text.
        let finalText = "";
        for (const block of response.content) {
          if (block.type === "text") finalText += block.text;
        }

        if (!finalText || finalText.includes("[NO_PULSE]")) {
          console.log(`Pulse: nothing to report for ${userName} (${toolsUsed.size} tools checked)`);
          await markChecked();
          return;
        }

        // Send the message
        for (const t of targets) {
          try { await sendToPlatform(t.platform, t.platform_user_id, finalText.trim()); } catch (e) { console.error(`Pulse send failed via ${t.platform}: ${e.message}`); }
        }
        console.log(`Pulse sent to ${userName} via ${targets.map(t => t.platform).join("+")} (${toolsUsed.size} tools used)`);
        await markChecked();

        // Save Pulse message to conversation so user can reply with context
        try {
          const conversation = getConversation(userId);
          conversation.push({ role: "assistant", content: finalText.trim() });
        } catch (e) { console.error("Pulse: failed to save to conversation:", e.message); }
        return;
      }

      // Tool use. Execute each tool inside the user mutex.
      messages.push({ role: "assistant", content: response.content });
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        toolsUsed.add(block.name);

        const result = await acquireUserMutex(userId, async () => {
          const freshStore = await UserStore.load(userId);
          swapToCloudStore(freshStore, userId, deliveryLink.platform_user_id);
          ctx.activePlatform = deliveryLink.platform;

          let toolResult;
          try {
            if (isInternalTool(block.name)) {
              const input = { ...block.input, _userId: userId, _chatId: deliveryLink.platform_user_id };
              toolResult = await handleInternalTool(block.name, input);

              if (toolResult?._contentType === "image" || toolResult?._contentType === "pdf") {
                toolResult = { description: toolResult.description, note: "Binary content handled" };
              } else if (toolResult?._contentType === "text") {
                toolResult = { fileName: toolResult.fileName, content: toolResult.textContent };
              }
              if (toolResult?._needs_location) {
                toolResult = { error: "Location not available in Pulse context." };
              }
            } else {
              toolResult = await callMCPTool(block.name, block.input);
              toolResult = toolResult.content || toolResult;
            }
          } catch (e) {
            toolResult = { error: "Tool error: " + e.message };
          }

          syncAdapterBack();
          ctx.activeUserStore?.save().catch(() => {});
          cleanupUserContext();

          return toolResult;
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    console.log(`Pulse hit max iterations for ${userName}`);
  } catch (e) {
    console.error(`Pulse error for user ${userId}:`, e.message);
  }

}

// Source of truth: profiles.settings.pulse_settings.proactiveLevel.
// Reconciles running cron jobs against it, at boot and every 10 minutes, so changes
// made from the dashboard (separate service) or chat tool apply without a redeploy.
async function reconcilePulseJobs() {
  try {
    const { supabase } = require("../user-store");
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, settings")
      .not("settings", "is", null);

    const desired = new Set();
    for (const profile of (profiles || [])) {
      const ps = profile.settings?.pulse_settings || {};
      const level = ps.proactiveLevel || profile.settings?.pulse_level || profile.settings?.proactiveLevel || "off";
      if (level !== "off") desired.add(profile.id);
    }

    for (const userId of Object.keys(pulseJobs)) {
      if (!desired.has(userId)) {
        console.log(`Pulse: stopping for ${userId} (switched off)`);
        stopPulseForUser(userId);
      }
    }
    for (const userId of desired) {
      if (!pulseJobs[userId]) {
        console.log(`Pulse: starting for ${userId}`);
        startPulseForUser(userId);
      }
    }
  } catch (e) {
    console.error("Pulse reconcile error:", e.message);
  }
}

async function startPulse() {
  await reconcilePulseJobs();
  setInterval(() => reconcilePulseJobs(), 10 * 60 * 1000);
  console.log(`Pulse: running for ${Object.keys(pulseJobs).length} user(s), reconciling every 10min.`);
}

/** Apply a level change immediately in-process (called by the chat pulse_toggle tool). */
function applyPulseLevel(userId, level) {
  if (!level || level === "off") stopPulseForUser(userId);
  else startPulseForUser(userId, level);
}

function startPulseForUser(userId, level) {
  stopPulseForUser(userId);

  // Same frequency for all levels. The level controls the quality bar,
  // not how often we check. We check every hour regardless.
  const cronExpr = "0 * * * *";

  pulseJobs[userId] = cron.schedule(cronExpr, () => {
    runPulseForUser(userId).catch(e => console.error(`Pulse cron error (${userId}):`, e.message));
  });
}

function stopPulse() {
  for (const userId of Object.keys(pulseJobs)) {
    stopPulseForUser(userId);
  }
}

function stopPulseForUser(userId) {
  if (pulseJobs[userId]) {
    pulseJobs[userId].stop();
    delete pulseJobs[userId];
  }
}

function isQuietHours(settings, store) {
  const { getUserTimezone, userHour: tzHour } = require("./timezone");
  const ps = settings?.pulse_settings || {};
  const qStart = ps.quietStart ?? settings?.pulse_quiet_start ?? settings?.quietStart ?? 22;
  const qEnd = ps.quietEnd ?? settings?.pulse_quiet_end ?? settings?.quietEnd ?? 7;
  const hour = tzHour(getUserTimezone(store || { profile: { settings } }));
  if (qStart > qEnd) return hour >= qStart || hour < qEnd;
  return hour >= qStart && hour < qEnd;
}

module.exports = {
  runPulseForUser, startPulse, startPulseForUser,
  stopPulse, stopPulseForUser, isQuietHours, applyPulseLevel,
};
