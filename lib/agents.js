// lib/agents.js — Background autonomous agent engine
// Agents run tool loops independently, sharing the per-user mutex with chat handlers.

const ctx = require("./context");
const { acquireUserMutex } = require("./user-mutex");
const { UserStore } = require("../user-store");
const { swapToCloudStore, syncAdapterBack, cleanupUserContext } = require("./storage");
const { isInternalTool, handleInternalTool } = require("./tools/handlers");
const { callMCPTool, getMcpToolDefsFor, warmUserMcp } = require("./mcp");
const spendGuard = require("./spend-guard");
const claimsCheck = require("./claims-check");
const outboundGuard = require("./outbound-guard");
const { INTERNAL_TOOLS } = require("./tools/definitions");
const { sendToPlatform } = require("./messaging");
const { createTask, updateTask, getTask } = require("./agents-store");
const { createAgentResponse } = require("./agent-context");
const { withTaskRun, makeBudget, budgetSnapshot } = require("./task-model");
const { successfulDeliveryKeys, handoverMessages } = require("./task-evidence");
const { prepareTask } = require("./verification");
const taskLease = require("./task-lease");
const { createToolScope, SAFE_READS, runRead, prefetchReads } = require("./task-tools");

// Tools agents must NOT use (meta/system/recursive)
const { getSkillsForPrompt } = require("./skills");
const { getInternalClient, getUserLLMClient, resolveUserModel } = require("./llm");

const EXCLUDED_TOOLS = new Set([
  "agent_start", "agent_status", "agent_cancel", "agent_note",
  "disconnect_service", "connect_service",
  "pulse_toggle",
  "automation_create", "automation_pause", "automation_resume",
]);

// An agent runs unattended, so it has no way to ask before doing something on
// the user's own machine, and the confirmation gate that guards these in the
// main conversation lives in ask() which agents never touch. Left available, an
// agent will drive the user's real mouse, keyboard and browser while they are
// sitting at it: this is exactly how one ended up clicking around Gmail on a
// laptop to read a draft it could have fetched from the API. Work on the user's
// Mac stays in the foreground conversation where they can see it and say no.
function isUserMachineTool(name) {
  return /^bridge_/.test(name);
}

const MAX_ITERATIONS = 50;
const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const PROGRESS_INTERVAL = 10;      // send update every N tool calls
const PROGRESS_MIN_GAP_MS = 120000; // and never more often than this
// Eleven messages in ten minutes turned a chat thread into a progress bar made
// of separate notifications. The tool count alone did not bound it, because a
// fast run fires them back to back.

// --- User-friendly progress descriptions ---

// TIPS removed: these were spliced into agent progress updates, so a user
// waiting on a task got adverts for the product they were already using,
// interleaved with status lines. Nothing else referenced them.


let _lastProgressMsg = "";

function describeAgentProgress(lastTool, totalTools, allTools, model, elapsedMs = 0, lastToolInput = null) {
  const toolActions = {
    web_search: "Searching the web",
    web_fetch: "Reading web pages",
    api_request: "Fetching from a connected service",
    send_email: "Working on an email",
    search_email: "Searching emails",
    read_email: "Reading emails",
    calendar_search: "Checking calendar",
    calendar_create: "Setting up an event",
    run_code: "Running some code",
    file_write: "Writing a file",
    file_read: "Reading a file",
    // The long jobs that get handed over are mostly browser and sandbox work,
    // and without these every update read "Working on it".
    sandbox_browse: "Working through a page in the browser",
    sandbox_exec: "Running something on the cloud computer",
    sandbox_gateway: "Fetching from a connected service",
    search_cache: "Digging through your mail and calendar",
    semantic_search: "Searching your history",
    gmail_send: "Getting an email ready",
    gmail_reply: "Drafting a reply",
    gcal_create_event: "Putting something in the calendar",
    drive_search: "Looking through your Drive",
    fetch_attachment: "Opening an attachment",
    sandbox_file_read: "Reading a file on the cloud computer",
    sandbox_file_list: "Looking through files on the cloud computer",
    sandbox_file_write: "Writing a file on the cloud computer",
    gmail_draft_update: "Rewriting the draft",
    search_calendar: "Checking the calendar",
    list_connections: "Checking which accounts are connected",
  };

  let action = toolActions[lastTool] || "Working on it";
  // "Pulling data from a connected account" told the user nothing: not which
  // account, not what for. Where the tool call names a service or a target,
  // say it.
  if (lastToolInput) {
    const url = String(lastToolInput.url || "");
    const svc = lastToolInput.service
      || (/gmail|googleapis\.com\/gmail/i.test(url) ? "Gmail"
        : /calendar/i.test(url) ? "Calendar"
        : /drive/i.test(url) ? "Drive"
        : /instagram|facebook|graph\.facebook/i.test(url) ? "Meta"
        : /shopify/i.test(url) ? "Shopify"
        : /slack/i.test(url) ? "Slack" : null);
    if (svc && /Fetching from a connected service/.test(action)) {
      action = `Fetching from ${svc.charAt(0).toUpperCase() + svc.slice(1)}`;
    }
  }

  // No tips, no filler, no guessing at how far along it is. An agent cannot
  // know it is "almost done", and saying so on a timer is a claim it has not
  // earned. Each update says what it is doing now and how long it has been
  // going, which is the only thing the user cannot see for themselves.
  const mins = Math.max(1, Math.round(elapsedMs / 60000));
  const msg = `${action}... (${mins}m so far)`;
  _lastProgressMsg = msg;
  return msg;
}

function formatElapsed(secs) {
  if (secs < 60) return secs + 's';
  var mins = Math.floor(secs / 60);
  var rem = secs % 60;
  if (mins < 60) return mins + 'm ' + rem + 's';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

// --- Model routing ---

// --- Build agent system prompt ---

function buildAgentSystemPrompt(goal, userStore) {
  const settings = userStore?.profile?.settings || {};
  const userName = settings.preferred_name || userStore?.profile?.display_name || "User";

  let prompt = `You are a background agent working for ${userName}'s personal AI assistant, ClosedHand.
You have been given a goal and must complete it autonomously using the tools available.
Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Current time: ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.

YOUR GOAL: ${goal}

WORKFLOW:
1. PLAN FIRST: Before doing anything, think through the steps you need to take. For complex tasks (research, multi-step operations), mentally outline your approach. Don't just dive in.
2. EXECUTE: Work through your plan using available tools. Be thorough but efficient. Use agent_map only for independent subtasks with enough work to justify separate workers, such as research per supplier or document. Handle a small lookup here. Each worker gets separate context; reconcile its evidence before answering. Sequential or dependent steps stay here with you.
3. VERIFY: Before finishing, review your own output. Ask yourself: is this actually useful? Does it answer the question? Is it complete? If your output is thin or vague, keep going.
4. DELIVER: Write a clear, detailed report of findings or results. The user wants substance, not a summary of your process. Focus on the actual answer, data, or deliverable. The report is a standalone document: the user can download it as a PDF long after this conversation, so it must not end with a conversational offer ("want me to draft X?"), address the reader with a question, or refer to the chat or dashboard. If follow-up actions suggest themselves, put them in a plain "Recommended next steps" list; the chat message that announces the report is where offers belong, and it is written separately.

RULES:
- You have full access to the user's connected services (Gmail, Calendar, Drive, Slack, Shopify, Meta Ads, etc.).
- Get that data from the API and the cache, never by driving a browser. Reading: search_cache for mail and unsent drafts, search_calendar for events, fetch_attachment for attachments.
- WRITING has its own tools, and they are the ones to use. Creating a draft is gmail_create_draft, which saves into the account that owns the thread. Changing an unsent draft is gmail_draft_update. Sending is gmail_send or gmail_reply. Calendar changes are gcal_create_event, gcal_update_event, gcal_delete_event. Do not reach for api_request or sandbox_gateway for something one of these already does, and never use the cloud computer's shell or filesystem to get at mail: sandbox_exec and sandbox_file_read have nothing to do with the user's inbox.
- Editing a draft is two calls, not an investigation: search_cache to find it and read what it says now, then gmail_draft_update with the new wording. If the first attempt at a tool fails, read the error rather than trying a different route to the same thing.
- You cannot use the user's own computer. Tools that act on their Mac are deliberately unavailable to you, because you run unattended and they are sitting at that machine. If a task genuinely needs their Mac, say so in your result and let them do it in conversation, where they can watch it and say no. Web work that needs a real browser goes to the cloud computer with sandbox_browse.
- You can make API calls, search the web, execute code in the sandbox, and more.
- Sending mail and paying for anything are put to the user first; everything else needs no confirmation, the user authorised this work by starting the agent. A payment only ever happens in the browser, on the site's own page, by pressing its own button: never by calling the site or a payment provider directly from code, which is refused.
- Sending a file is final: a send tool that returns success has delivered it. Send each document the user asked for exactly ONCE. Do not re-send a file to confirm it arrived, and never send your own working files (image slices, OCR crops, temporary exports you made for your own reading). Once every requested document is delivered, stop and write your summary.
- To READ a document (PDF, Word, Excel), use fetch_attachment or view_attachment: they return the extracted text directly. Do NOT upload a file to the cloud computer to read it. The cloud computer is for actual computation (running code, transforming data, generating charts), not for opening an attachment you can already read through the connected account. This includes files from past conversations: when the goal or a search result references a file the user sent or a document ClosedHand made, list_attachments finds its stored copy. Read it when the task needs specifics the reference does not carry; a reference that already answers is enough on its own.
- To SEND or reply to an email, use gmail_send / gmail_reply (or the Outlook equivalents), attaching files with attachment_ids. NEVER send mail by POSTing to the provider API through sandbox_gateway, api_request or sandbox_exec: that bypasses the confirmation the user must give before any message leaves their account, and it is refused. Sending pauses for the user's yes unless they have turned that off.
- Never pad your response with filler. Be direct and substantive.
- If the task involves research, cross-reference multiple sources. Don't rely on a single result.

VERIFY YOUR WORK: After completing the task, check your own output. Did the API call return data? Did the code run without errors? If a tool broke or returned nothing because it broke, try a different approach immediately.

A TOOL FAILING AND AN ANSWER OF "NO" ARE NOT THE SAME THING. A search that ran properly and found nothing has answered the question. Say so and stop. Looking again, in more places, with more tools, cannot make something appear that is not there, and every extra attempt costs the user money while they wait for a reply. Two or three well aimed searches across the obvious places are enough to be sure. Then tell them plainly what you looked through and what was not in it, and say what you think happened where you can reasonably tell, for instance that a file looks like it was only ever saved on their own computer and never uploaded.

Persistence is for things that are failing, not for things that are absent. If one tool errors, try another. If a service is down, find another route. But do not wander into unrelated tools to look busy: hunting for a Drive file with a web search or the sandbox shell is not thoroughness, it is noise.`;

  // Inject skills for the agent's goal
  const skillsBlock = getSkillsForPrompt(userStore, goal);
  if (skillsBlock) {
    prompt += "\n" + skillsBlock;
  }

  if (userStore?.notes && Object.keys(userStore.notes).length > 0) {
    prompt += `\n\nUser's saved notes (for context):\n${JSON.stringify(userStore.notes, null, 2)}`;
  }

  if (userStore?.location) {
    prompt += `\n\nUser's location: ${userStore.location.name} (${userStore.location.latitude}, ${userStore.location.longitude})`;
  }

  return prompt + require("./response-presentation").responsePresentation("web");
}

// --- Get filtered tools for agents ---

function getAgentTools(userStore) {

  // MCP tools: the install's own and the ones the user connected
  const mcpToolDefs = getMcpToolDefsFor((userStore && userStore.userId) || ctx.activeUserId);

  // Internal tools, filtered
  const filteredInternal = INTERNAL_TOOLS.filter((tool) => {
    if (EXCLUDED_TOOLS.has(tool.name)) return false;
    if (isUserMachineTool(tool.name)) return false;
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

// --- Map-step: parallel clean-context sub-runs ---
//
// An agent facing N similar independent subtasks fans them out instead of
// grinding them through one growing transcript: same work tokens, but each
// sub reasons over a small clean context instead of everyone's noise. Subs
// are research workers by design: no sends (the parent synthesises and sends
// after), no browser (one shared tab cannot be driven concurrently), no
// map-in-map and no agent tools (the tree is chat -> agents -> subs, full
// stop). The real fan-out risk is a looping sub burning N times faster,
// which is what the per-sub iteration and token budgets are for.

const MAP_MAX_ITEMS = 8;
const MAP_CONCURRENCY = 3;
const MAP_SUB_MAX_ITERATIONS = 6;
const MAP_SUB_TOKEN_BUDGET = 25000; // output tokens per sub

function getMapSubTools() {
  return INTERNAL_TOOLS
    .filter((tool) =>
      (SAFE_READS.has(tool.name) || ["get_tool_details", "get_facts", "list_connections"].includes(tool.name)) &&
      !EXCLUDED_TOOLS.has(tool.name) &&
      !isUserMachineTool(tool.name) &&
      tool.name !== "agent_map" &&
      tool.name !== "sandbox_browse" &&
      !AGENT_CONFIRM_SENDS.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }));
}

async function runMapSub(userId, subGoal, platform, chatId, model) {
  const userStore = await UserStore.load(userId);
  if (userStore.profile?.settings?.agent_worker_tier === "fast") model = resolveUserModel(userId, "fast", userStore);
  const toolScope = createToolScope(getMapSubTools(), subGoal);
  const systemPrompt = buildAgentSystemPrompt(subGoal, userStore) + toolScope.catalog;
  const messages = [{ role: "user", content: [{ type: "text", text: "Begin. Work the goal with the tools you have and finish with your findings as plain text." }] }];
  const { client } = getUserLLMClient(userId, userStore);

  let spentTokens = 0;
  for (let i = 0; i < MAP_SUB_MAX_ITERATIONS; i++) {
    const response = await createAgentResponse(client, { model, max_tokens: 4096, system: systemPrompt, messages, tools: toolScope.definitions(messages) }, userStore?.profile?.settings?.llm_provider);
    spentTokens += response.usage?.output_tokens || 0;

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const toolResults = [];
      for (const b of response.content) {
        if (b.type !== "tool_use") continue;
        require("./task-model").countToolCall();
        let r;
        try {
          if (!toolScope.has(b.name)) r = { error: "Tool is unavailable to this worker." };
          else if (b.name === "get_tool_details") r = toolScope.describe(b.input?.tool_name);
          else if (SAFE_READS.has(b.name) && process.env.AGENT_PARALLEL_READS !== "0") r = await runRead(userId, platform, chatId, b.name, b.input);
          else if (isInternalTool(b.name)) {
            // Same per-call mutex + context swap as the parent loop: subs run
            // concurrently, so each tool call takes its own turn.
            r = await acquireUserMutex(userId, async () => {
              const freshStore = await UserStore.load(userId);
              swapToCloudStore(freshStore, userId, chatId);
              ctx.activePlatform = platform;
              try { return await handleInternalTool(b.name, { ...b.input, _userId: userId, _chatId: chatId }); }
              finally { syncAdapterBack(); cleanupUserContext(); }
            });
          } else {
            r = { error: `Tool ${b.name} is not available in a sub-run.` };
          }
        } catch (e) { r = { error: e.message }; }
        if (r && r.error) console.log(`[tool-error] map-sub ${b.name}: ${String(r.error).substring(0, 200)}`);
        toolResults.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(r) });
      }
      if (spentTokens > MAP_SUB_TOKEN_BUDGET) {
        toolResults.push({ type: "text", text: "Token budget for this sub-task is spent. No more tools: write your findings now from what you already have." });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    let text = "";
    for (const b of response.content) if (b.type === "text") text += b.text;
    return { findings: text.trim() || "No findings", evidence: require("./task-evidence").evidenceFrom(messages, 12000) };
  }

  // Out of iterations mid-tool-chatter: same rule as scheduled runs, the
  // caller must get findings, never a status line.
  try {
    messages.push({ role: "user", content: [{ type: "text", text: "Stop. Write your findings now from what you already have; if something could not be verified, say so briefly." }] });
    const fin = await createAgentResponse(client, { model, max_tokens: 4096, system: systemPrompt, messages }, userStore?.profile?.settings?.llm_provider);
    let text = "";
    for (const b of fin.content) if (b.type === "text") text += b.text;
    if (text.trim()) return { findings: text.trim(), evidence: require("./task-evidence").evidenceFrom(messages, 12000), partial: true };
  } catch (_) {}
  return { error: "The sub-task ran out of budget before reporting." };
}

async function runAgentMap(userId, platform, chatId, parentTaskId, input, model) {
  const items = Array.isArray(input.items) ? [...new Set(input.items.map((s) => String(s)).filter((s) => s.trim()))] : [];
  const template = String(input.prompt || "");
  if (items.length < 2) return { error: "agent_map needs 2 or more items. For one item, just do the work directly." };
  if (items.length > MAP_MAX_ITEMS) return { error: `agent_map caps at ${MAP_MAX_ITEMS} items. Narrow the list or batch the rest into a second call.` };
  if (!template.trim()) return { error: "agent_map needs the prompt template." };
  const label = String(input.label || "sub-tasks").substring(0, 40);

  const pushProgress = async (text) => {
    try {
      const t = await getTask(parentTaskId);
      await updateTask(parentTaskId, { progress: [...(t?.progress || []), { text, time: new Date().toISOString() }] });
    } catch (_) { /* progress is a nicety */ }
  };
  await pushProgress(`Splitting this into ${items.length} parallel ${label}`);

  const results = new Array(items.length);
  let nextIdx = 0;
  let doneCount = 0;
  const worker = async () => {
    while (nextIdx < items.length) {
      const my = nextIdx++;
      const subGoal = template.includes("{item}")
        ? template.split("{item}").join(items[my])
        : `${template}\n\nThis run covers: ${items[my]}`;
      try {
        const { supabase } = require("./db");
        const itemKey = require("crypto").createHash("sha256").update(JSON.stringify([subGoal, model])).digest("hex");
        const { data: cached, error: readError } = await supabase.from("task_worker_results").select("result")
          .eq("user_id", userId).eq("task_id", parentTaskId).eq("item_key", itemKey).limit(1);
        if (readError) throw readError;
        const result = cached?.[0]?.result || await withTaskRun({ purpose: "map_worker" }, () => runMapSub(userId, subGoal, platform, chatId, model));
        results[my] = { item: items[my], ...result, reused: !!cached?.length };
        if (!cached?.length && !result.error && !result.partial) {
          const { error: saveError } = await supabase.from("task_worker_results").upsert({ user_id: userId, task_id: parentTaskId, item_key: itemKey, result }, { onConflict: "task_id,item_key" });
          if (saveError) throw saveError;
        }
      } catch (e) {
        results[my] = { item: items[my], error: e.message };
      }
      doneCount++;
      await pushProgress(`${doneCount} of ${items.length} ${label} done (${items[my].substring(0, 40)})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAP_CONCURRENCY, items.length) }, worker));

  return {
    results,
    note: "Synthesise these into one answer. Sub-runs could not see each other, so reconcile any overlap or disagreement yourself, and say so where they conflict.",
  };
}

// --- Start agent (called from tool handler) ---

async function startAgent(userId, platform, chatId, goal, successCriteria, snapshot = null) {
  // An agent can run for minutes and then deliver into nothing, which looks to
  // the user like it silently gave up: the report is in the Agents tab and the
  // chat stays quiet. A missing platform is the way that happens, and "web" is
  // the worst possible guess because a web send to a chatId that belongs to
  // another platform fails without erroring. Say so in the logs rather than
  // defaulting quietly, so the next occurrence is greppable.
  if (!platform) {
    console.warn(`[Agent] Starting with no platform for user ${userId} (chat ${chatId}). Its result cannot be delivered. A caller lost its context bubble.`);
  }
  const store = await UserStore.load(userId);
  const model = resolveUserModel(userId, "default", store);
  const criteria = successCriteria || null;
  const title = String(goal).split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 70);
  const task = await createTask(userId, goal, model, platform, chatId, title, criteria,
    { request: snapshot, threadId: ctx.activeThreadId || null });

  // Fire and forget — agent runs in background, in its own context bubble.
  // Sharing the chat turn's bubble meant the turn's cleanup nulled the user
  // store under a running agent, and its next model call had no client
  // ("Cannot read properties of null (reading 'messages')").
  ctx.runWithInheritedContext(() => runAgent(task.id, userId, platform, chatId, goal, model, criteria)).catch((err) => {
    console.error(`Agent ${task.id} crashed:`, err.message);
  });

  // Tier label for status messages, provider-neutral (never name-drop models to users)
  const modelName = model.includes(":low") || model.includes("haiku") || model.includes("mini") || model.includes("flash") ? "fast"
    : model.includes("opus") || model.includes("o3") ? "thorough" : "balanced";
  return { taskId: task.id, model: modelName };
}

// --- Core agent loop ---

// Send-type tools deliver a file to the user. An agent has no memory across
// iterations, so with nothing to stop it, it re-downloads and re-sends the same
// file every turn until it hits the step cap. This returns a stable per-file key
// for the send tools (null for every other tool), used to dedupe deliveries
// within a single run.
function sendDeliveryKey(name, input = {}) {
  switch (name) {
    case "sandbox_file_download": return input.path ? "sbx:" + input.path : null;
    case "drive_send_file": return input.file_id ? "drv:" + input.file_id : null;
    case "send_file": return input.attachment_id ? "att:" + input.attachment_id : null;
    default: return null;
  }
}

// Outbound sends an agent must confirm before running. The user authorised the
// agent's work, not each irreversible message to a third party.
const AGENT_CONFIRM_SENDS = new Set(["gmail_send", "gmail_reply", "outlook_send", "outlook_reply", "send_mail", "reply_to_mail"]);

// Default ON: an absent setting means confirm. Users opt out on the dashboard
// (settings.require_send_confirmation === false).
function sendConfirmRequired(userStore) {
  return userStore?.profile?.settings?.require_send_confirmation !== false;
}

// Plain-language "about to send" line naming recipient, subject and attachments,
// so the user knows exactly what they are approving.
function describeAgentSend(block) {
  const i = block.input || {};
  const isReply = /reply/.test(block.name);
  const lines = [`I'm about to ${isReply ? "reply to an email" : "send an email"}. Reply "yes" to send it or "no" to skip.`, ""];
  if (i.to) lines.push(`To: ${i.to}`);
  if (i.account) lines.push(`From: ${i.account}`);
  if (i.subject) lines.push(`Subject: ${i.subject}`);
  if (Array.isArray(i.attachment_ids) && i.attachment_ids.length) {
    const names = i.attachment_ids.map((id) => {
      for (const uid of Object.keys(ctx.store.attachments || {})) {
        const a = (ctx.store.attachments[uid] || []).find((x) => x.id === id);
        if (a) return a.fileName || id;
      }
      return id;
    });
    lines.push(`Attaching: ${names.join(", ")}`);
  }
  if (i.body) lines.push(`\n${String(i.body).substring(0, 400)}${String(i.body).length > 400 ? "..." : ""}`);
  return lines.join("\n");
}

// A provider mail-send endpoint. Used to stop an agent smuggling a send past the
// confirmation by POSTing raw through sandbox_gateway / api_request.
function isMailSendUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/messages\/send/.test(url)
    || /graph\.microsoft\.com\/[^ ]*\/sendMail/i.test(url)
    || /\/messages\/send(\?|$)/.test(url);
}

// Resume a background agent that paused for a send confirmation. On yes, run the
// held send and feed its result back; on no, tell the agent the user declined.
// Either way the agent carries on from where it paused.
async function resumeAgentAfterConfirmation(pending, approved, chatId) {
  const { taskId, userId, platform, goal, model, successCriteria } = pending;
  const saved = await getTask(taskId);
  if (!saved || saved.status !== "awaiting_confirmation") return "That task is no longer waiting for a send confirmation.";
  let result;
  if (approved) {
    try {
      if (pending.draftId) {
        // Send the exact draft the user previewed: one send, no re-composition.
        const { sendGmailDraft } = require("./tools/handlers");
        result = await sendGmailDraft(pending.sendAccount, pending.draftId);
      } else {
        const input = { ...pending.toolInput, _userId: userId, _chatId: chatId };
        result = pending.isInternal
          ? await handleInternalTool(pending.toolName, input)
          : await callMCPTool(pending.toolName, input);
        result = result?.content || result;
        if (pending.spend && pending.spend.ledgerId) await spendGuard.ledgerUpdate(pending.spend.ledgerId, { status: result && result.error ? "failed" : "completed" });
      }
    } catch (e) { result = { error: `Send failed: ${e.message}` }; }
  } else {
    if (pending.draftId) {
      const { deleteGmailDraft } = require("./tools/handlers");
      await deleteGmailDraft(pending.sendAccount, pending.draftId);
    }
    result = { declined: true, note: "The user declined to send this. The draft was discarded. Do NOT send it. Tell them it was not sent, then continue with anything else outstanding or stop." };
  }
  const resumeMessages = [
    ...pending.messages,
    { role: "user", content: [...(pending.otherToolResults || []), { type: "tool_result", tool_use_id: pending.toolUseId, content: JSON.stringify(result) }] },
  ];
  // Exclude the time the user spent deciding from the agent's run clock. Without
  // this, a slow confirmation makes the resumed agent time out the instant it
  // comes back, which reads to the user as "it timed out because I was too slow".
  const elapsedBeforePause = (pending.pausedAt || pending.createdAt) - pending.createdAt;
  const resumeState = {
    messages: resumeMessages,
    tools_used: pending.toolsUsed,
    created_at: new Date(Date.now() - elapsedBeforePause).toISOString(),
  };
  await updateTask(taskId, { status: "running", messages: resumeMessages, runtime: { ...(saved.runtime || {}), confirmation: null } });
  ctx.runWithInheritedContext(() => runAgent(taskId, userId, platform, chatId, goal, model, successCriteria, resumeState)).catch((err) => {
    console.error(`Agent ${taskId} resume crashed:`, err.message);
  });
  if (pending.spend) return approved ? "Paying now." : "OK, I won't pay for it.";
  return approved ? "Sending it now." : "OK, I won't send it.";
}

async function runAgent(taskId, userId, platform, chatId, goal, model, successCriteria, resumeState = null) {
  const { supabase } = require("./db");
  const task = await taskLease.claim(supabase, "agent_tasks", taskId, userId);
  if (!task) return;
  const userStore = await UserStore.load(userId);
  const budget = makeBudget(task.runtime?.budget, userStore.profile?.settings?.agent_budget || {});
  if (resumeState?.created_at) budget.startedAt = new Date(resumeState.created_at).getTime();
  const controller = new AbortController();
  const leaseTimer = setInterval(() => taskLease.renew(supabase, "agent_tasks", taskId, task.lease_owner).catch(() => controller.abort()), 30000);
  try {
    return await ctx.runWithInheritedContext(async () => {
      swapToCloudStore(userStore, userId, chatId); ctx.activePlatform = platform;
      return withTaskRun({ userId, taskId, kind: "agent", leaseOwner: task.lease_owner, budget, signal: controller.signal }, async () => {
        const prepared = task.runtime?.prepared ? { criteria: task.success_criteria, tier: null }
          : await prepareTask(goal, userId, userStore, successCriteria || task.success_criteria);
        model = prepared.tier ? resolveUserModel(userId, prepared.tier, userStore) : task.model;
        const runtime = { ...(task.runtime || {}), prepared: true, budget: budgetSnapshot() };
        await updateTask(taskId, { model, success_criteria: prepared.criteria, runtime });
        const state = resumeState || { messages: task.messages?.length ? task.messages
          : runtime.request ? handoverMessages(runtime.request) : [], tools_used: task.tools_used, created_at: task.created_at };
        try { return await runAgentLoop(taskId, userId, platform, chatId, goal, model, prepared.criteria, { ...state, runtime }); }
        catch (error) {
          if (error.code === "TASK_STOPPED" || controller.signal.aborted) return;
          await require("./task-outcome").saveInterrupted("agent_tasks", taskId, error);
        }
      });
    });
  } catch (error) {
    if (error.code !== "TASK_STOPPED" && !controller.signal.aborted) {
      await withTaskRun({ userId, taskId, leaseOwner: task.lease_owner, budget }, () => require("./task-outcome").saveInterrupted("agent_tasks", taskId, error));
    }
  } finally { clearInterval(leaseTimer); await taskLease.release(supabase, "agent_tasks", taskId, task.lease_owner); }
}

async function runAgentLoop(taskId, userId, platform, chatId, goal, model, successCriteria, resumeState = null) {
  console.log(`Agent ${taskId} ${resumeState ? "resuming" : "starting"}: model=${model}, goal="${goal.substring(0, 80)}"`);

  // Load user's own UserStore instance
  const userStore = await UserStore.load(userId);
  await warmUserMcp(userId);
  const agentTools = getAgentTools(userStore);
  const toolScope = createToolScope(agentTools, goal);
  const systemPrompt = buildAgentSystemPrompt(goal, userStore) + toolScope.catalog;

  // Resume where it left off. Every deploy restarts the bot, and this used to
  // begin again from the goal alone with all its work discarded, which is why a
  // task that spanned a couple of deploys appeared to take forever and reported
  // less elapsed time than the message before it.
  let messages = Array.isArray(resumeState?.messages) && resumeState.messages.length
    ? resumeState.messages
    : [{ role: "user", content: goal }];
  let toolCallCount = 0;
  let iteration = resumeState?.runtime?.iteration || 0;
  const toolsUsed = new Set(resumeState?.tools_used || []);
  // Measured from when the TASK began, not this process, so a restart does not
  // make the agent claim it has been going for less time than it has.
  const startTime = resumeState?.created_at ? new Date(resumeState.created_at).getTime() : Date.now();
  // Verification state for this run. It used to be read off a `task` variable
  // that only ever existed in startAgent, so the first agent to reach the
  // verification step died with ReferenceError: task is not defined. These are
  // per-run counters, not persisted fields, so they belong here.
  const verification = resumeState?.runtime?.verification || { passed: false, attempts: 0 };
  let lastProgressAt = Date.now();  // the first ping waits too, rather than firing instantly

  // Files already delivered this run. Seeded from any resumed transcript so a
  // restart mid-task does not restart the re-send loop this guards against.
  const deliveredFiles = successfulDeliveryKeys(messages, sendDeliveryKey);
  const uncertainFiles = require("./task-evidence").uncertainDeliveryKeys(messages, sendDeliveryKey);

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Timeout check
    if (Date.now() - startTime > AGENT_TIMEOUT_MS) {
      throw Object.assign(new Error("This task reached its time allowance."), { code: "TASK_BUDGET_EXCEEDED" });
    }

    // Check cancellation, and pick up steering notes: both ride the same
    // per-iteration row read, so mid-run "also check X" costs nothing extra.
    const currentTask = await getTask(taskId);
    const steeringNotes = Array.isArray(currentTask?.pending_notes) ? currentTask.pending_notes : [];
    if (currentTask && steeringNotes.length && currentTask.status !== "cancelled") {
      const noteText = steeringNotes.map((n) => n.note || String(n)).join("\n");
      const { supabase } = require("./db");
      messages.push({ role: "user", content: [{ type: "text", text: `The user corrected this task: ${noteText}. Apply this to the remaining work and final answer.` }] });
      successCriteria = (await prepareTask(goal + "\nUser corrections: " + noteText, userId, userStore)).criteria;
      verification.passed = false; verification.attempts = 0;
      await updateTask(taskId, { messages, success_criteria: successCriteria });
      const { error: noteError } = await supabase.rpc("acknowledge_agent_notes", {
        p_task_id: taskId, p_user_id: userId, p_ids: { ids: steeringNotes.map(n => n.id || n.at || "") } });
      if (noteError) throw new Error("Could not acknowledge task corrections: " + noteError.message);
      await updateTask(taskId, { progress: [...(currentTask.progress || []), { text: "Taking your correction into account", time: new Date().toISOString() }] });

    }
    if (!currentTask || currentTask.status === "cancelled") {
      console.log(`Agent ${taskId} cancelled`);
      // The stop came from the dashboard or a cancel command; say so in the
      // chat the agent belongs to, or the user who pressed Stop is left
      // wondering whether it took.
      try {
        const stoppedTitle = currentTask?.title || (goal || "").split("\n")[0].substring(0, 60) || "the background task";
        await sendToPlatform(platform, chatId, `Stopped "${stoppedTitle}". No further steps will run.`);
      } catch (e) { /* the stop itself already succeeded */ }
      return;
    }

    await taskLease.renew(require("./db").supabase, "agent_tasks", taskId);
    await updateTask(taskId, { runtime: { ...(currentTask.runtime || {}), budget: budgetSnapshot(), iteration, verification }, messages });

    // Call LLM API — NO mutex needed (only reads from agent's local messages)
    console.log(`Agent ${taskId} iteration ${iteration}: messages=${messages.length}`);
    const { client: agentClient } = getUserLLMClient(userId, userStore);
    const response = await createAgentResponse(agentClient, {
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: toolScope.definitions(messages),
    }, userStore?.profile?.settings?.llm_provider);

    await taskLease.renew(require("./db").supabase, "agent_tasks", taskId);
    const afterModel = await getTask(taskId);
    if (afterModel?.pending_notes?.length) continue;
    if (response.stop_reason !== "tool_use") {
      // Agent thinks it's done. Extract output, then verify.
      let finalText = "";
      for (const block of response.content) {
        if (block.type === "text") finalText += block.text;
      }

      messages.push({ role: "assistant", content: response.content });

      let reportText = finalText;

      // One verification pass and one targeted correction pass.
      if (successCriteria && successCriteria.length > 0 && !verification.passed) {
        const verifyAttempts = verification.attempts;
        const MAX_VERIFY = 2;
        if (verifyAttempts < MAX_VERIFY) {
          try {
            const { verifyCompletion } = require("./verification");
            const verdict = await verifyCompletion(goal, successCriteria, reportText, [...toolsUsed], userId, messages, userStore);
            console.log(`Agent ${taskId} verification attempt ${verifyAttempts + 1}: passed=${verdict.passed}`);
            verification.verdict = verdict;
            if (!verdict.passed && verdict.status !== "unavailable") {
              verification.attempts = verifyAttempts + 1;
              // Inject feedback and loop back
              messages.push({ role: "user", content: [{ type: "text", text: `VERIFICATION (attempt ${verifyAttempts + 1}/${MAX_VERIFY}): Your output didn't pass quality checks.\n${verdict.feedback}\n\nPlease address this and provide an improved response.` }] });
              await updateTask(taskId, { progress: [...((currentTask?.progress) || []), { text: `Quality check sent it back for another pass: ${String(verdict.feedback || "").substring(0, 140)}`, time: new Date().toISOString() }] });
              if (verification.attempts < MAX_VERIFY) continue; // One correction pass, then retain the actual outcome.
            }
            verification.passed = verdict.passed;
          } catch (e) {
            console.log(`Agent ${taskId} verification error: ${e.message}`);
            // Don't block on verification infra failures
          }
        }
      }

      const beforeCompletion = await getTask(taskId);
      if (beforeCompletion?.pending_notes?.length) continue;
      await updateTask(taskId, {
        status: verification.passed ? "completed" : "partial",
        delivery_status: "pending",
        error: verification.passed ? null : (verification.verdict?.feedback || "Completion is unverified"),
        runtime: { ...(currentTask.runtime || {}), budget: budgetSnapshot(), iteration, verification },
        result: reportText,
        messages,
        tools_used: [...toolsUsed],
        completed_at: new Date().toISOString(),
      });

      require("./task-delivery").deliverFinished();
      return;
    }

    // Tool use — process each tool call inside the mutex
    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];
    await updateTask(taskId, { messages, tools_used: [...toolsUsed] });
    let pendingSend = null;
    const prefetched = prefetchReads(response.content.filter(b => b.type !== "tool_use" || toolScope.has(b.name)), async b => {
      await taskLease.renew(require("./db").supabase, "agent_tasks", taskId);
      require("./task-model").countToolCall();
      return runRead(userId, platform, chatId, b.name, b.input);
    });

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (!toolScope.has(block.name)) {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Tool is unavailable to this task." }); continue;
      }


      await taskLease.renew(require("./db").supabase, "agent_tasks", taskId);
      if (!prefetched.has(block.id)) require("./task-model").countToolCall();
      toolCallCount++;
      toolsUsed.add(block.name);

      // Confirm-and-wait for outbound sends (unless the user turned confirmations
      // off). Hold the first send for the user's yes; refuse a second in the same
      // batch, since one confirmation authorises one send.
      if (AGENT_CONFIRM_SENDS.has(block.name) && sendConfirmRequired(userStore)) {
        if (!pendingSend) { pendingSend = block; continue; }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: "Not sent. Only one send is confirmed at a time. Raise this one on its own after the first is dealt with." }) });
        continue;
      }
      // Money: a click that pays is held for the user's yes, like a send. Over
      // a limit it is refused outright; under the no-questions amount it runs.
      {
        const guardInput = { ...block.input, _userId: userId };
        const intent = spendGuard.spendIntent(block.name, guardInput);
        if (intent) {
          const page = block.name === "sandbox_browse" ? await spendGuard.readCheckout(userId, intent.at) : spendGuard.lastPage(userId);
          const verdict = await spendGuard.assess({ userId, userStore, toolName: block.name, source: "agent", intent, page });
          if (verdict.action === "refuse") {
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: verdict.message }) });
            continue;
          }
          if (verdict.action === "ask") {
            if (!pendingSend) { pendingSend = block; pendingSend._spendCard = verdict.card; pendingSend._spendLedgerId = verdict.ledgerId; continue; }
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: "Not done. One purchase is confirmed at a time. Raise this one on its own after the first is dealt with." }) });
            continue;
          }
          block._spendLedgerId = verdict.ledgerId;
        }
      }
      // Data leaving for somewhere new: held for the user's yes, like a send.
      {
        const ob = outboundGuard.outboundIntent(block.name, block.input, userStore);
        if (ob) {
          if (!pendingSend) { pendingSend = block; pendingSend._spendCard = outboundGuard.card(ob); pendingSend._outboundHost = ob.host; continue; }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: "Not done. One action is put to the user at a time. Raise this one on its own after the first is dealt with." }) });
          continue;
        }
      }
      // Defense in depth: refuse a raw mail send through the API proxy, which
      // would otherwise slip past the confirmation above. Force it through the
      // proper tool. Applies even when confirmations are off, so the model stops
      // hand-rolling MIME and uses gmail_send's attachment support.
      if ((block.name === "sandbox_gateway" || block.name === "api_request") && isMailSendUrl(block.input?.url)) {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: "Refused. Do not send email by calling the provider API directly. Use gmail_send or gmail_reply (with attachment_ids for any files) instead, which attaches files properly and confirms with the user first." }) });
        continue;
      }

      // agent_map runs its own sub-loop fleet and must not hold the user
      // mutex for the whole fan-out; each sub's tool calls take the mutex
      // per call, exactly like this loop's own calls below.
      if (block.name === "agent_map") {
        const mapOut = await runAgentMap(userId, platform, chatId, taskId, block.input || {}, model);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(mapOut) });
        continue;
      }

      // Execute tool inside per-user mutex (acquire, run, release)
      const result = prefetched.has(block.id) ? await prefetched.get(block.id)
        : block.name === "get_tool_details" ? toolScope.describe(block.input?.tool_name)
        : await acquireUserMutex(userId, async () => {
        await taskLease.renew(require("./db").supabase, "agent_tasks", taskId);
        // Swap in user context for this tool call
        const freshStore = await UserStore.load(userId);
        swapToCloudStore(freshStore, userId, chatId);
        ctx.activePlatform = platform;

        let toolResult;
        try {
          if (isInternalTool(block.name)) {
            const dupKey = sendDeliveryKey(block.name, block.input);
            if (dupKey && uncertainFiles.has(dupKey)) {
              toolResult = { error: "The previous delivery has no saved receipt. Do not send it again automatically; ask the user whether it arrived." };
            } else if (dupKey && deliveredFiles.has(dupKey)) {
              // Already delivered once this run. Refuse the resend and say so, or
              // the agent loops on the same file until it hits the step cap.
              const label = block.input.path || block.input.file_id || block.input.attachment_id || "that file";
              toolResult = { already_delivered: true, note: `"${label}" was already sent to the user earlier in this task. Do NOT send it again. Once every document the user actually asked for has been delivered once, stop and write your final summary.` };
            } else {
              console.log(`Agent ${taskId} tool: ${block.name}`);
              const input = { ...block.input, _userId: userId, _chatId: chatId };
              toolResult = await handleInternalTool(block.name, input);
              if (block._spendLedgerId) await spendGuard.ledgerUpdate(block._spendLedgerId, { status: toolResult && toolResult.error ? "failed" : "completed" });
              // Record a successful delivery so the next identical send short-circuits.
              if (dupKey && !require("./task-evidence").resultFailed({ content: toolResult })) deliveredFiles.add(dupKey);

              // Handle special return types from attachments
              if (toolResult?._contentType === "pdf") {
                // The agent's model is text-only, so a PDF block is unreadable
                // and used to be discarded here, which is what pushed agents to
                // shuttle PDFs to the cloud computer to read them. Extract the
                // text and hand that over instead.
                let pdfText = null;
                try {
                  const buf = Buffer.from(toolResult.base64, "base64");
                  pdfText = await require("./services/usi").extractAttachmentText(buf, "document.pdf");
                } catch (_) { /* fall through to the note below */ }
                toolResult = pdfText
                  ? { text_content: pdfText, description: toolResult.description }
                  : { description: toolResult.description, note: "PDF received but its text could not be extracted." };
              } else if (toolResult?._contentType === "image") {
                toolResult = { description: toolResult.description, note: "Binary content handled" };
              } else if (toolResult?._contentType === "text") {
                toolResult = { fileName: toolResult.fileName, content: toolResult.textContent };
              }
              // Location requests — agents can't prompt for location
              if (toolResult?._needs_location) {
                toolResult = { error: "This tool needs the user's location which isn't available to agents. Use a different approach." };
              }
            }
          } else {
            console.log(`Agent ${taskId} MCP tool: ${block.name}`);
            toolResult = await callMCPTool(block.name, block.input);
            toolResult = toolResult.isError ? { error: "Connected tool returned an error", content: toolResult.content } : toolResult.content || toolResult;
          }
        } catch (e) {
          toolResult = { error: `Tool error: ${e.message}` };
        }

        // Sync back and save
        syncAdapterBack();
        ctx.activeUserStore?.save().catch(() => {});
        cleanupUserContext();

        return toolResult;
      });

      // Same tag the chat executor uses, so error rates are measurable with
      // one log query instead of being invisible outside chat.
      if (result && result.error) console.log(`[tool-error] agent ${block.name}: ${String(result.error).substring(0, 200)}`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });

      await updateTask(taskId, { messages: [...messages, { role: "user", content: [...toolResults] }], tools_used: [...toolsUsed] });

      // Progress update. Fires on the interval, and also right after a document
      // is delivered, so the user knows more is still coming. WhatsApp has no
      // typing indicator (sendTyping is a no-op there), so silence after a file
      // reads as "finished". The min-gap throttle stops either from spamming, so
      // a burst of files yields at most one "still working" line per gap.
      const deliveredNow = !!sendDeliveryKey(block.name, block.input) && result && !result.error && !result.already_delivered;
      const sinceLastPing = Date.now() - lastProgressAt;
      if (((toolCallCount % PROGRESS_INTERVAL === 0) || deliveredNow) && sinceLastPing >= PROGRESS_MIN_GAP_MS) {
        lastProgressAt = Date.now();
        const friendlyStatus = deliveredNow
          ? "Sent that over. Still pulling the rest together, one moment."
          : describeAgentProgress(block.name, toolCallCount, [...toolsUsed], model, Date.now() - startTime, block.input);
        const progressEntry = { text: friendlyStatus, tool: block.name, count: toolCallCount, time: new Date().toISOString() };
        await updateTask(taskId, {
          progress: [...(currentTask?.progress || []), progressEntry],
          tools_used: [...toolsUsed],
          messages,
        });
        await sendToPlatform(platform, chatId, friendlyStatus);
      }
    }

    if (pendingSend) {
      // Save the email as a Gmail draft first, so the user can open it and check
      // the real formatting and attachment before deciding. On "yes" that exact
      // draft is sent; on "no" it is binned. Runs in a mutex/context swap because
      // the pause sits outside the per-tool context.
      let draftId = null;
      // The claims check runs alongside the draft, not after it.
      const claimsPromise = pendingSend._spendCard ? null
        : claimsCheck.checkOutbound({ userId, kind: "send an email", to: pendingSend.input.to, subject: pendingSend.input.subject, body: pendingSend.input.body, recent: messages.slice(-12) });
      if (!pendingSend._spendCard && (pendingSend.name === "gmail_send" || pendingSend.name === "gmail_reply")) {
        try {
          draftId = await acquireUserMutex(userId, async () => {
            const s = await UserStore.load(userId);
            swapToCloudStore(s, userId, chatId);
            ctx.activePlatform = platform;
            const { createGmailDraft } = require("./tools/handlers");
            const d = await createGmailDraft(pendingSend.name, pendingSend.input);
            cleanupUserContext();
            return d && !d.error ? d.draftId : null;
          });
        } catch (_) { draftId = null; }
      }
      // Park the run: save what to send plus everything needed to resume, ask the
      // user in chat, and stop here until they reply (handled in confirmation.js).
      if (!ctx.pendingConfirmations) ctx.pendingConfirmations = {};
      ctx.pendingConfirmations[userId] = {
        isAgent: true, taskId, userId, platform, chatId, goal, model, successCriteria,
        toolName: pendingSend.name, toolInput: pendingSend.input, toolUseId: pendingSend.id,
        isInternal: isInternalTool(pendingSend.name),
        messages, otherToolResults: toolResults,
        toolsUsed: [...toolsUsed], createdAt: startTime, pausedAt: Date.now(),
        draftId, sendAccount: pendingSend.input.account,
        spend: pendingSend._spendLedgerId ? { ledgerId: pendingSend._spendLedgerId } : null,
        outbound: pendingSend._outboundHost ? { host: pendingSend._outboundHost } : null,
      };
      await updateTask(taskId, { status: "awaiting_confirmation", messages, tools_used: [...toolsUsed],
        runtime: { ...(currentTask.runtime || {}), budget: budgetSnapshot(), iteration, verification, confirmation: ctx.pendingConfirmations[userId] } });
      const draftNote = draftId ? "\n\nIt's saved as a draft in your Gmail so you can open it and check the formatting and attachment before you decide." : "";
      let claimsNote = "";
      if (claimsPromise) { try { claimsNote = claimsCheck.renderWarnings((await claimsPromise).warnings); } catch { /* none */ } }
      await sendToPlatform(platform, chatId, pendingSend._spendCard ? pendingSend._spendCard : describeAgentSend(pendingSend) + claimsNote + draftNote);
      console.log(`Agent ${taskId} paused for send confirmation (${pendingSend.name}, draft=${draftId ? "yes" : "no"})`);
      return;
    }

    messages.push({ role: "user", content: toolResults });

    // Save state to Supabase for restart resilience
    await updateTask(taskId, { messages, tools_used: [...toolsUsed] });
  }

  throw Object.assign(new Error("This task reached its step allowance."), { code: "TASK_BUDGET_EXCEEDED" });
}

// --- Cancel agent ---

async function cancelAgent(taskId) {
  await updateTask(taskId, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
  });
  return { success: true };
}

// --- Resume agents on startup ---

async function resumeAgents() {
  const { supabase } = require("./db");
  const { data, error } = await supabase.from("agent_tasks").select("user_id,runtime").eq("status", "awaiting_confirmation");
  if (error) throw error;
  ctx.pendingConfirmations ||= {};
  for (const row of data || []) if (row.runtime?.confirmation) ctx.pendingConfirmations[row.user_id] = row.runtime.confirmation;
  await processPendingTasks();
}

// --- Pick up pending tasks created from the dashboard ---

async function processPendingTasks() {
  try {
    const { supabase } = require("./db");
    const pending = await taskLease.recoverable(supabase, "agent_tasks");

    for (const task of pending) {
      console.log(`Processing pending dashboard task ${task.id}: "${task.goal.substring(0, 60)}"`);

      const model = task.model;

      // runAgent atomically claims the pending row before preparation.

      // Fire and forget
      runAgent(task.id, task.user_id, task.platform, task.chat_id, task.goal, model, task.success_criteria).catch((err) => {
        console.error(`Dashboard agent ${task.id} crashed:`, err.message);
      });
    }
  } catch (e) {
    console.error("Failed to process pending tasks:", e.message);
  }
}

// The database is the cross-service wake-up channel. Claims also make this a restart recovery poll.
setInterval(processPendingTasks, 2000).unref();
setInterval(() => require("./task-delivery").deliverFinished(), 2000).unref();

module.exports = { startAgent, cancelAgent, resumeAgents, processPendingTasks, resumeAgentAfterConfirmation };
