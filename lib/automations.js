// lib/automations.js — Execution engine for the automations system
// Runs automation loops in the background, manages cron scheduling, handles chaining + output routing.

const cron = require("node-cron");
const ctx = require("./context");
const { acquireUserMutex } = require("./user-mutex");
const { UserStore } = require("../user-store");
const { swapToCloudStore, syncAdapterBack, cleanupUserContext } = require("./storage");
const { isInternalTool, handleInternalTool } = require("./tools/handlers");
const { callMCPTool } = require("./mcp");
const { INTERNAL_TOOLS } = require("./tools/definitions");
const { sendToPlatform } = require("./messaging");
const { getSkillsForPrompt } = require("./skills");
const { MODEL_MAP, getUserLLMClient, getInternalClient } = require("./llm");
const {
  createRun, updateRun, getRun, getPendingRuns,
  getAutomation, getActiveScheduledAutomations,
} = require("./automations-store");

// Format output for different chat platforms
function formatForPlatform(text, platform) {
  if (platform === "whatsapp" || platform === "telegram") {
    // Convert markdown to WhatsApp/Telegram format
    let out = text;
    // Remove markdown tables
    out = out.replace(/\|[\s\S]*?\|[\s-|]*\|/g, function(table) {
      return table.split('\n').filter(r => r.trim() && !r.match(/^\|[\s-|]+\|$/)).map(r =>
        r.split('|').filter(c => c.trim()).map(c => c.trim()).join(' : ')
      ).join('\n');
    });
    // Headers: ## Title -> *Title*
    out = out.replace(/^#{1,4}\s+(.+)$/gm, '*$1*');
    // Horizontal rules
    out = out.replace(/^---+$/gm, '');
    // Bold: **text** -> *text*
    out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');
    // Remove consecutive blank lines
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
  }
  // Web chat and other platforms: keep markdown (rendered by UI)
  return text;
}

// Reuse progress helpers from agents
const { describeAgentProgress, formatElapsed } = (() => {
  // Inline the same helpers so we don't create a circular dep with agents.js
  const TIPS = [
    "Anything saved to your Context Brain is fully visible on your dashboard and you can delete it anytime.",
    "Your data is encrypted, never sold, and never used for training. You're always in control.",
    "ClosedHand automatically picks the best model for your query. No setup needed.",
    "You can wipe your entire conversation history or account data from Settings whenever you want.",
    "Connect more services on your dashboard to give your assistant new capabilities.",
    "You can set reminders, track flights, or manage your calendar, just by asking.",
    "Try asking your assistant to draft emails, manage your Shopify store, or research a topic.",
    "Your assistant's memory is transparent. Check the Context Brain tab on your dashboard to see exactly what it knows.",
    "ClosedHand runs on your terms. No hidden data collection, no lock-in, no surprises.",
    "You can schedule recurring tasks like daily briefings or weekly reports, just ask.",
    "Everything your assistant remembers is deletable from your dashboard. Nothing is permanent unless you want it to be.",
    "You can manage your agents, connections, and memory from your dashboard.",
  ];

  const PROGRESS_INTERVAL = 5;
  let _lastProgressMsg = "";

  function describeAgentProgress(lastTool, totalTools, allTools, model) {
    const toolActions = {
      web_search: "Searching the web",
      web_fetch: "Reading web pages",
      api_request: "Calling an API",
      send_email: "Working on an email",
      search_email: "Searching emails",
      read_email: "Reading emails",
      calendar_search: "Checking calendar",
      calendar_create: "Setting up an event",
      run_code: "Running some code",
      file_write: "Writing a file",
      file_read: "Reading a file",
    };

    const action = toolActions[lastTool] || "Working on it";
    const messages = [];

    if (totalTools <= PROGRESS_INTERVAL) {
      messages.push(`Working on it... ${action.toLowerCase()}.`, `${action}...`);
    } else if (totalTools <= PROGRESS_INTERVAL * 4) {
      messages.push(
        `Still working... ${action.toLowerCase()}.`,
        `${action}...`,
        "Working on it...",
        TIPS[Math.floor(Math.random() * TIPS.length)],
      );
    } else {
      messages.push(
        "Almost done...",
        "Wrapping up...",
        "Finishing up...",
        TIPS[Math.floor(Math.random() * TIPS.length)],
      );
    }

    let msg = messages[Math.floor(Math.random() * messages.length)];
    let attempts = 0;
    while (msg === _lastProgressMsg && attempts < 5) {
      msg = messages[Math.floor(Math.random() * messages.length)];
      attempts++;
    }
    _lastProgressMsg = msg;
    return msg;
  }

  function formatElapsed(secs) {
    if (secs < 60) return secs + "s";
    var mins = Math.floor(secs / 60);
    var rem = secs % 60;
    if (mins < 60) return mins + "m " + rem + "s";
    return Math.floor(mins / 60) + "h " + (mins % 60) + "m";
  }

  return { describeAgentProgress, formatElapsed };
})();

// Tools automations must NOT use
const EXCLUDED_TOOLS = new Set([
  "agent_start", "agent_status", "agent_cancel",
  "disconnect_service", "connect_service",
  "pulse_toggle",
]);

const MAX_ITERATIONS = 25;
const PROGRESS_INTERVAL = 5;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// Active cron jobs keyed by automation ID
const _automationCrons = {};

// --- Model mapping ---
// Tier keys from automation configs map to llm.js MODEL_MAP tiers
const TIER_MAP = { haiku: "fast", sonnet: "default", opus: "strong" };

function resolveModel(modelKey, userId) {
  const tier = TIER_MAP[modelKey] || "default";
  const { resolveUserModel } = require("./llm");
  return resolveUserModel(userId, tier);
}

// --- Build automation system prompt ---

async function buildAutomationPrompt(automation, userStore, inputContext, userId) {
  const userName = userStore?.profile?.settings?.preferred_name || userStore?.profile?.display_name || "User";
  let prompt = `You are a background automation working for ${userName}'s personal assistant, ClosedHand.
${require("./timezone").nowStamp(userStore)} ALL times you mention must be in the user's timezone.

YOUR TASK: ${automation.task_prompt}
${inputContext ? `\nCONTEXT FROM PREVIOUS STEP:\n${inputContext}` : ""}

WORKFLOW:
1. PLAN your approach before starting.
2. EXECUTE using available tools. Be thorough but efficient.
3. VERIFY: Before finishing, check your work.
   - If the task includes a QUALITY CHECK section, verify each criterion explicitly. If any fail, go back and fix them before delivering.
   - If no quality criteria were provided, define what "done properly" means for this specific task, then check against that.
   - Be honest with yourself. Thin, vague, or padded results fail verification.
   - If verification fails, don't report failure. Just iterate and fix it, then verify again.
4. DELIVER a clear, substantive report. No filler.

RULES:
- Full access to connected services. No confirmations needed.
- Cross-reference multiple sources for research tasks.
- Keep your final response focused on results, not process.
- If one approach fails, try another immediately. Loop until it works (minimum 3 attempts).
- Never say you couldn't do something without exhausting every alternative route first.`;

  // Inject skills
  const skillsBlock = getSkillsForPrompt(userStore, automation.task_prompt);
  if (skillsBlock) prompt += "\n" + skillsBlock;

  // Load attached user skills (stored as "skill:name" in task_tools)
  const skillNames = (automation.task_tools || [])
    .filter(t => t.startsWith("skill:"))
    .map(t => t.slice(6));

  if (skillNames.length > 0 && userId) {
    try {
      // The picker offers built-in skills alongside installed ones, but this
      // only ever looked in user_skills, where a built-in has no row. So
      // choosing meta-ads, which the form promises "ensures they are used",
      // silently attached nothing at all. Resolve those from the on-disk
      // registry first and ask the table only for what is left.
      const { getBuiltInSkill } = require("./skills");
      const resolved = [];
      const stillNeeded = [];
      for (const n of skillNames) {
        const builtIn = getBuiltInSkill(n);
        if (builtIn) resolved.push({ name: builtIn.name, content: builtIn.body });
        else stillNeeded.push(n);
      }

      const { supabase } = require("./db");
      const { data: installed } = stillNeeded.length
        ? await supabase.from("user_skills").select("name, content").eq("user_id", userId).in("name", stillNeeded)
        : { data: [] };
      const skills = resolved.concat(installed || []);

      if (skills && skills.length > 0) {
        prompt += "\n\n--- SKILLS ---\n";
        for (const skill of skills) {
          prompt += `\n### Skill: ${skill.name}\n${skill.content}\n`;
        }
        prompt += "\n--- END SKILLS ---\n";
      }
    } catch (e) {
      console.error("Failed to load user skills for automation:", e.message);
    }
  }

  return prompt;
}

// --- Get filtered tools for automations (same as agents) ---

function getAutomationTools(userStore) {

  const mcpToolDefs = ctx.allMcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.inputSchema || { type: "object", properties: {} },
  }));

  const filteredInternal = INTERNAL_TOOLS.filter((tool) => {
    if (EXCLUDED_TOOLS.has(tool.name)) return false;
    if (!tool.groups) return true;
    return true;
  });

  const internalToolDefs = filteredInternal.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));

  return [...mcpToolDefs, ...internalToolDefs];
}

// --- Core execution loop ---

async function _executeLoop(runId, config, userId, platform, chatId, model, inputContext, successCriteria) {
  const fullModel = resolveModel(model, userId);
  // Smart duration: check if task implies long-running work
  const prompt = (config.task_prompt || "").toLowerCase();
  const isLongRunning = /always|continuously|monitor|watch for|every time|whenever|scrape daily|ongoing|keep checking/.test(prompt);
  const defaultDuration = isLongRunning ? 30 : 15; // 30 min for long-running, 15 for normal
  const timeoutMs = (config.task_max_duration || defaultDuration) * 60 * 1000;

  const provider = ctx.activeUserStore?.profile?.settings?.llm_provider || "anthropic";
  console.log(`Automation run ${runId} starting: model=${fullModel}, provider=${provider}, task="${(config.task_prompt || "").substring(0, 80)}"`);

  const userStore = await UserStore.load(userId);
  const tools = getAutomationTools(userStore);
  const systemPrompt = await buildAutomationPrompt(config, userStore, inputContext, userId);

  let messages = [{ role: "user", content: config.task_prompt }];
  let toolCallCount = 0;
  let iteration = 0;
  const toolsUsed = new Set();
  const startTime = Date.now();
  let verifyAttempts = 0;
  let verificationPassed = false;

  await updateRun(runId, { status: "running", started_at: new Date().toISOString(), model: fullModel });

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Timeout check
    if (Date.now() - startTime > timeoutMs) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      await updateRun(runId, {
        status: "failed",
        error: `Timed out after ${formatElapsed(elapsed)}`,
        messages,
        tools_used: [...toolsUsed],
        duration_secs: elapsed,
        completed_at: new Date().toISOString(),
      });
      return { status: "failed", error: "timeout" };
    }

    // Check cancellation
    const currentRun = await getRun(runId);
    if (!currentRun || currentRun.status === "cancelled") {
      console.log(`Automation run ${runId} cancelled`);
      return { status: "cancelled" };
    }

    // Call LLM API with 3-minute timeout per call
    console.log(`Automation run ${runId} iteration ${iteration}: messages=${messages.length}`);
    const response = await Promise.race([
      getUserLLMClient(userId).client.messages.create({
        model: fullModel,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("API call timed out after 3 minutes")), 180_000)),
    ]);

    // --- Agent done (no more tool use) ---
    if (response.stop_reason !== "tool_use") {
      let finalText = "";
      for (const block of response.content) {
        if (block.type === "text") finalText += block.text;
      }

      messages.push({ role: "assistant", content: response.content });

      let reportText = finalText;

      // Self-evaluation before completing
      if (successCriteria && successCriteria.length > 0 && !verificationPassed && verifyAttempts < 3) {
        try {
          const { verifyCompletion } = require("./verification");
          const verdict = await verifyCompletion(config.task_prompt, successCriteria, reportText, [...toolsUsed], userId);
          console.log(`Automation ${runId} verification attempt ${verifyAttempts + 1}: passed=${verdict.passed}`);
          verifyAttempts++;
          if (!verdict.passed) {
            messages.push({ role: "user", content: [{ type: "text", text: `VERIFICATION (attempt ${verifyAttempts}/3): ${verdict.feedback}\n\nPlease address this and provide an improved response.` }] });
            continue; // Loop back
          }
          verificationPassed = true;
        } catch (e) {
          console.log(`Automation ${runId} verification error: ${e.message}`);
        }
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const outputSummary = reportText.length > 500 ? reportText.substring(0, 497) + "..." : reportText;

      await updateRun(runId, {
        status: "success",
        output_summary: outputSummary,
        full_report: reportText,
        messages,
        tools_used: [...toolsUsed],
        duration_secs: elapsed,
        completed_at: new Date().toISOString(),
      });

      console.log(`Automation run ${runId} completed in ${formatElapsed(elapsed)}: ${reportText.length} chars`);
      return { status: "success", result: reportText, elapsed, toolsUsed: [...toolsUsed] };
    }

    // --- Tool use --- process each tool call inside the mutex
    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      toolCallCount++;
      toolsUsed.add(block.name);

      // Execute tool inside per-user mutex
      const result = await acquireUserMutex(userId, async () => {
        const freshStore = await UserStore.load(userId);
        swapToCloudStore(freshStore, userId, chatId);
        ctx.activePlatform = platform;

        let toolResult;
        try {
          if (isInternalTool(block.name)) {
            console.log(`Automation run ${runId} tool: ${block.name}`);
            const input = { ...block.input, _userId: userId, _chatId: chatId };
            toolResult = await handleInternalTool(block.name, input);

            // Handle special return types
            if (toolResult?._contentType === "image" || toolResult?._contentType === "pdf") {
              toolResult = { description: toolResult.description, note: "Binary content handled" };
            } else if (toolResult?._contentType === "text") {
              toolResult = { fileName: toolResult.fileName, content: toolResult.textContent };
            }
            if (toolResult?._needs_location) {
              toolResult = { error: "This tool needs the user's location which isn't available to automations. Use a different approach." };
            }
          } else {
            console.log(`Automation run ${runId} MCP tool: ${block.name}`);
            toolResult = await callMCPTool(block.name, block.input);
            toolResult = toolResult.content || toolResult;
          }
        } catch (e) {
          toolResult = { error: `Tool error: ${e.message}` };
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

      // Progress update every N tool calls
      if (toolCallCount % PROGRESS_INTERVAL === 0) {
        const friendlyStatus = describeAgentProgress(block.name, toolCallCount, [...toolsUsed], fullModel);
        const progressEntry = { text: friendlyStatus, tool: block.name, count: toolCallCount, time: new Date().toISOString() };
        await updateRun(runId, {
          progress: [...(currentRun?.progress || []), progressEntry],
          tools_used: [...toolsUsed],
          messages,
        });
        // Only send chat progress for manual/chat-triggered runs
        if (platform !== "dashboard") {
          await sendToPlatform(platform, chatId, friendlyStatus).catch(() => {});
        }
      }
    }

    messages.push({ role: "user", content: toolResults });

    // Persist state for resilience
    await updateRun(runId, { messages, tools_used: [...toolsUsed] });
  }

  // Hit max iterations
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  await updateRun(runId, {
    status: "failed",
    error: `Hit max iterations (${MAX_ITERATIONS})`,
    messages,
    tools_used: [...toolsUsed],
    duration_secs: elapsed,
    completed_at: new Date().toISOString(),
  });
  return { status: "failed", error: "max_iterations" };
}

// --- Handle run completion: output routing + chaining ---

async function handleRunComplete(runId, automation, userId, result, platform, chatId) {
  // Send output to user via messaging platform
  if (result.status === "success" && result.result) {
    const toolCount = (result.toolsUsed || []).length;
    const header = `Automation complete (${formatElapsed(result.elapsed)}, ${toolCount} tools)\n\n`;
    const maxLen = 3000;
    const truncated = result.result.length > maxLen
      ? result.result.substring(0, maxLen) + "\n\n...(see full report on dashboard)"
      : result.result;

    // Route to the appropriate platform(s)
    const destinations = automation?.output_destinations || ["chat_platforms"];
    console.log(`[Automation] Run complete. Destinations:`, destinations, `platform=${platform}, chatId=${chatId}`);
    if (destinations.includes("chat_platforms")) {
      // Look up delivery platforms from profile settings AND chat_links
      const { supabase: sbClient } = require("./db");

      const { data: profile } = await sbClient.from("profiles").select("settings").eq("id", userId).single();
      const ps = profile?.settings?.pulse_settings || profile?.settings?.pulse || {};
      const deliveryPlatforms = ps.deliveryPlatforms || [];
      console.log(`[Automation] Profile pulse_settings:`, JSON.stringify(ps));
      console.log(`[Automation] Delivery platforms:`, deliveryPlatforms);

      const { data: chatLinks } = await sbClient.from("chat_links").select("platform, platform_user_id").eq("user_id", userId);
      console.log(`[Automation] Chat links:`, JSON.stringify(chatLinks));

      if (deliveryPlatforms.length > 0 && chatLinks && chatLinks.length > 0) {
        for (const platformName of deliveryPlatforms) {
          const name = typeof platformName === "string" ? platformName : platformName.platform;
          const link = chatLinks.find(l => l.platform === name);
          if (link) {
            // Format output for the target platform
            const formatted = formatForPlatform(truncated, name);
            const msgBody = `Your "${automation?.name || "agent"}" just finished:\n\n${formatted}`;
            console.log(`[Automation] Sending to ${name} (chatId: ${link.platform_user_id})`);
            await sendToPlatform(name, link.platform_user_id, msgBody).catch((e) => {
              console.error(`[Automation] Delivery to ${name} failed:`, e.message);
            });
            console.log(`[Automation] Sent to ${name} successfully`);
          } else {
            console.log(`[Automation] No chat_link found for platform ${name}`);
          }
        }
      } else if (platform && platform !== "dashboard" && chatId) {
        // Fallback: send to the platform that triggered the run
        await sendToPlatform(platform, chatId, header + truncated).catch(() => {});
      }
    }

    // If urgent, also push to any additional Pulse destinations not already covered
    if (automation?.output_urgent) {
      const userStore = await UserStore.load(userId);
      const pulseConfig = userStore?.profile?.settings?.pulse || userStore?.store?.pulse;
      const extraDests = pulseConfig?.deliveryPlatforms || [];
      for (const dest of extraDests) {
        if (dest.platform !== platform || dest.chatId !== chatId) {
          await sendToPlatform(dest.platform, dest.chatId, `[Automation: ${automation.name}]\n\n${header}${truncated}`).catch(() => {});
        }
      }
    }
  } else if (result.status === "failed") {
    const errorMsg = `Automation failed: ${result.error}${automation ? ` (${automation.name})` : ""}`;
    if (platform && platform !== "dashboard" && chatId && chatId !== "dashboard") {
      await sendToPlatform(platform, chatId, errorMsg).catch(() => {});
    }
  }

  // Handle chaining — if this automation has a chain_target_id, fire the next one
  if (automation?.chain_target_id && result.status === "success") {
    console.log(`Automation chain: ${automation.id} -> ${automation.chain_target_id}`);
    try {
      await executeAutomationRun(automation.chain_target_id, userId, {
        triggered_by: "chain",
        chain_source_id: runId,
        input_context: result.result,
        platform,
        chatId,
      });
    } catch (e) {
      console.error(`Chain target ${automation.chain_target_id} failed to start:`, e.message);
    }
  }
}

// --- Execute a saved automation ---

async function executeAutomationRun(automationId, userId, opts = {}) {
  const automation = await getAutomation(automationId, userId);
  if (!automation) throw new Error("Automation not found");

  const platform = opts.platform || automation.platform || "dashboard";
  const chatId = opts.chatId || automation.chat_id || "dashboard";
  const model = automation.task_model || "sonnet";

  const run = await createRun(automationId, userId, {
    status: "pending",
    model: resolveModel(model, userId),
    triggered_by: opts.triggered_by || "manual",
    input_context: opts.input_context || null,
    chain_source_id: opts.chain_source_id || null,
    platform,
    chat_id: chatId,
  });

  // Generate success criteria from the automation's task prompt
  const { generateSuccessCriteria } = require("./verification");
  const criteria = automation.success_criteria || await generateSuccessCriteria(automation.task_prompt, userId).catch(() => null);

  // Fire in background
  _executeLoop(run.id, automation, userId, platform, chatId, model, opts.input_context || null, criteria)
    .then((result) => handleRunComplete(run.id, automation, userId, result, platform, chatId))
    .catch((err) => {
      console.error(`Automation run ${run.id} crashed:`, err.message);
      updateRun(run.id, {
        status: "failed",
        error: err.message,
        completed_at: new Date().toISOString(),
        duration_secs: 0,
      });
      if (platform !== "dashboard") {
        sendToPlatform(platform, chatId, `Automation failed: ${err.message}`).catch(() => {});
      }
    });

  return { runId: run.id, model };
}

// --- Quick run (one-off, no saved automation) ---

async function quickRun(userId, prompt, opts = {}) {
  const platform = opts.platform || "dashboard";
  const chatId = opts.chatId || "dashboard";
  const model = opts.model || "sonnet";

  // Create a virtual config (not saved as an automation)
  const config = {
    task_prompt: prompt,
    task_model: model,
    task_max_duration: opts.task_max_duration || 15,
    task_use_cloud: opts.task_use_cloud || false,
  };

  const run = await createRun(null, userId, {
    status: "pending",
    model: resolveModel(model, userId),
    triggered_by: opts.triggered_by || "quick",
    input_context: opts.input_context || null,
    platform,
    chat_id: chatId,
  });

  // Generate success criteria for quality verification
  const { generateSuccessCriteria } = require("./verification");
  const criteria = opts.success_criteria || await generateSuccessCriteria(prompt, userId).catch(() => null);

  // Fire in background
  _executeLoop(run.id, config, userId, platform, chatId, model, opts.input_context || null, criteria)
    .then((result) => handleRunComplete(run.id, null, userId, result, platform, chatId))
    .catch((err) => {
      console.error(`Quick run ${run.id} crashed:`, err.message);
      updateRun(run.id, {
        status: "failed",
        error: err.message,
        completed_at: new Date().toISOString(),
        duration_secs: 0,
      });
      if (platform !== "dashboard") {
        sendToPlatform(platform, chatId, `Task failed: ${err.message}`).catch(() => {});
      }
    });

  return { runId: run.id, model };
}

// --- Cron scheduling ---

function registerSingleCron(automation) {
  if (!automation.trigger_cron || automation.status !== "active") return;

  // Unregister existing if any
  unregisterCron(automation.id);

  const cronOpts = {};
  if (automation.trigger_timezone) cronOpts.timezone = automation.trigger_timezone;

  console.log(`Registering automation cron: ${automation.name} (${automation.trigger_cron}) [${automation.id}]`);

  _automationCrons[automation.id] = cron.schedule(automation.trigger_cron, async () => {
    console.log(`Automation cron firing: ${automation.name} [${automation.id}]`);
    try {
      await executeAutomationRun(automation.id, automation.user_id, {
        triggered_by: "scheduled",
        platform: automation.platform || "dashboard",
        chatId: automation.chat_id || "dashboard",
      });
    } catch (e) {
      console.error(`Automation cron error (${automation.name}):`, e.message);
    }
  }, cronOpts);
}

function unregisterCron(automationId) {
  if (_automationCrons[automationId]) {
    _automationCrons[automationId].stop();
    delete _automationCrons[automationId];
  }
}

async function registerAutomationCrons() {
  try {
    const scheduled = await getActiveScheduledAutomations();
    let count = 0;
    for (const automation of scheduled) {
      registerSingleCron(automation);
      count++;
    }
    console.log(`Startup: registered ${count} automation cron(s).`);
  } catch (e) {
    console.error("Failed to register automation crons:", e.message);
  }
}

// --- Poll for pending runs (created from dashboard) ---

async function processPendingAutomationRuns() {
  try {
    const pending = await getPendingRuns();
    if (!pending || pending.length === 0) return;

    for (const run of pending) {
      console.log(`Processing pending automation run ${run.id}`);

      // If it has an automation_id, load the automation config
      let config;
      if (run.automation_id) {
        config = await getAutomation(run.automation_id, run.user_id);
        if (!config) {
          await updateRun(run.id, {
            status: "failed",
            error: "Automation not found",
            completed_at: new Date().toISOString(),
            duration_secs: 0,
          });
          continue;
        }
      } else {
        // Quick run — input_context should contain the prompt
        config = {
          task_prompt: run.input_context || "No task specified",
          task_model: run.model || "sonnet",
          task_max_duration: 15,
        };
      }

      const model = config.task_model || "sonnet";
      const platform = run.platform || "dashboard";
      const chatId = run.chat_id || "dashboard";

      // Fire and forget
      _executeLoop(run.id, config, run.user_id, platform, chatId, model, run.input_context)
        .then((result) => handleRunComplete(run.id, config, run.user_id, result, platform, chatId))
        .catch((err) => {
          console.error(`Pending run ${run.id} crashed:`, err.message);
          updateRun(run.id, {
            status: "failed",
            error: err.message,
            completed_at: new Date().toISOString(),
            duration_secs: 0,
          });
        });
    }
  } catch (e) {
    console.error("Failed to process pending automation runs:", e.message);
  }
}

// Poll for pending runs every 10 seconds
setInterval(processPendingAutomationRuns, 10000);

// --- Parse natural language automation description ---

async function parseAutomationDescription(description, userId) {
  const userStore = await UserStore.load(userId);
  const connectedServices = userStore?.connections?.map(c => c.service) || [];

  const { client: llm, model: defaultModel } = getInternalClient(userId);
  const resp = await llm.messages.create({
    model: defaultModel,
    max_tokens: 2000,
    messages: [{ role: "user", content: description }],
    system: `You are a configuration parser for ClosedHand, a personal AI assistant.
The user will describe an automation they want. Parse it into JSON config.

The user has these services connected: ${connectedServices.join(", ") || "none yet"}

Reply with ONLY valid JSON:
{
  "name": "short-kebab-case-name (3 words max)",
  "description": "one-line plain English summary",
  "trigger_type": "manual" | "scheduled" | "event",
  "trigger_cron": "cron expression if scheduled (null otherwise)",
  "trigger_timezone": "Europe/London",
  "trigger_human_schedule": "human-readable schedule like 'Every day at 8am' (null if manual)",
  "trigger_event_source": "email|shopify|github|etc (null if not event)",
  "trigger_event_condition": "natural language condition (null if not event)",
  "task_prompt": "detailed prompt for what the AI should do each time this runs",
  "task_model": "haiku|sonnet|opus (haiku for simple, sonnet for most, opus for complex research)",
  "task_use_cloud": false,
  "output_urgent": false
}

Schedule parsing rules:
- "every morning" = "0 8 * * *" + "Every day at 8am"
- "every evening" = "0 18 * * *" + "Every day at 6pm"
- "every Monday" = "0 9 * * 1" + "Every Monday at 9am"
- "twice a day" = "0 8,18 * * *" + "Every day at 8am and 6pm"
- "every hour" = "0 * * * *" + "Every hour"
- "weekly" = "0 9 * * 1" + "Every Monday at 9am"

Model selection:
- haiku: simple lookups, quick checks, basic summaries
- sonnet: most tasks, email summaries, monitoring, reports
- opus: deep research, complex analysis, strategy

Cloud computer: enable if task implies code execution, data analysis, chart generation, file processing.

No explanation, just JSON.`,
  });

  try {
    const text = resp.content[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { error: "Failed to parse description", raw: resp.content[0]?.text };
  }
}

module.exports = {
  executeAutomationRun,
  quickRun,
  registerAutomationCrons,
  registerSingleCron,
  unregisterCron,
  processPendingAutomationRuns,
  parseAutomationDescription,
};
