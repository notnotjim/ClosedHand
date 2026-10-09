// lib/confirmation.js — Confirmation system for destructive actions

const ctx = require("./context");
const { getUserLLMClient } = require("./llm");
const { saveStore } = require("./storage");
const { getConversation } = require("./conversation");
const { isInternalTool, handleInternalTool } = require("./tools/handlers");
const { callMCPTool } = require("./mcp");
const { isUserMcpTool, needsMcpConfirmation, getUserMcpToolDefs } = require("./user-mcp");
const { ledgerUpdate } = require("./spend-guard");
const { sendTyping } = require("./messaging");
const { CONNECTABLE_SERVICES } = require("./services-config");

const ACTIONS_NEEDING_CONFIRMATION = [
  "delegate_email_thread",
  "send_mail",
  "reply_to_mail",
  "gmail_send",
  "gmail_reply",
  "outlook_send",
  "outlook_reply",
  "outlook_cal_delete_event",
  "delete_event",
  "edit_event",
  "gcal_delete_event",
  "gcal_update_event",
  "disconnect_service",
];

// A reply to "Reply yes or no": people write "Yes, send it." or "ok go
// ahead", not a bare "yes". It counts as an answer only when every word in it
// is a plain yes (or a plain no) word; anything more, such as "yes but change
// the subject" or "send it to Sam instead", is not an answer and goes to the
// conversation as usual.
const YES_CORE = new Set(["yes", "y", "yep", "yeah", "yup", "sure", "ok", "okay", "go", "confirm", "confirmed", "do", "send", "approve", "approved", "always"]);
const YES_WORDS = new Set([...YES_CORE, "ahead", "it", "please", "thanks", "thank", "you", "now"]);
const NO_CORE = new Set(["no", "n", "nope", "nah", "cancel", "stop", "don't", "dont", "not", "skip", "never"]);
const NO_WORDS = new Set([...NO_CORE, "do", "send", "it", "please", "thanks", "thank", "you", "now", "mind"]);
function confirmationAnswer(response) {
  const words = String(response || "").toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return null;
  const all = (set) => words.every((w) => set.has(w));
  const any = (set) => words.some((w) => set.has(w));
  if (any(NO_CORE) && all(NO_WORDS)) return "no";
  if (any(YES_CORE) && all(YES_WORDS)) return words.length === 1 && words[0] === "always" ? "always" : "yes";
  return null;
}

async function handleConfirmation(userId, chatId, response) {
  const pending = ctx.pendingConfirmations[userId];
  if (!pending) return false;
  const origin = pending.toolInput || {};
  if ((origin._platform === "email" || ctx.activePlatform === "email") &&
      (origin._platform !== ctx.activePlatform || origin._chatId !== chatId)) {
    return "Please answer that approval in the conversation where I asked it.";
  }

  const answer = confirmationAnswer(response);
  const isYes = answer === "yes" || answer === "always";
  const isNo = answer === "no";

  // A question older than a day is over: a late "yes" must not fire it.
  if (require("./confirmation-lifetime").isLapsed(pending)) {
    await dropPending(userId, "lapsed");
    return isYes || isNo ? "That question is from more than a day ago and has lapsed, so nothing was done. Ask again if you still want it." : false;
  }
  if (!isYes && !isNo) return false;

  delete ctx.pendingConfirmations[userId];
  const conversation = getConversation(userId);

  // "always": allow this once and remember the place for next time.
  if (answer === "always" && pending.outbound && pending.outbound.host) {
    await require("./outbound-guard").approveHost(ctx.activeUserStore, pending.outbound.host);
  }

  // A background agent paused for a send confirmation: resume it rather than
  // running the chat continuation loop below. On yes it sends and carries on;
  // on no it is told the send was declined.
  if (pending.isAgent) {
    const { resumeAgentAfterConfirmation } = require("./agents");
    if (pending.spend && pending.spend.ledgerId) await ledgerUpdate(pending.spend.ledgerId, isYes ? { status: "approved", approved_via: "agent" } : { status: "declined" });
    const verb = pending.spend ? "pay for it" : "send it";
    conversation.push({ role: "user", content: isYes ? `Yes, ${verb}.` : `No, do not ${verb}.` });
    const ack = await resumeAgentAfterConfirmation(pending, !!isYes, chatId);
    conversation.push({ role: "assistant", content: ack });
    saveStore();
    return ack;
  }

  // A "no" is not the end of the turn. "Cancelled." on its own once left the
  // person's actual question unanswered, so the turn carries on with the
  // change marked declined, the way a "yes" carries on with it done.
  sendTyping(chatId);
  let result;
  if (isNo) {
    if (pending.spend && pending.spend.ledgerId) await ledgerUpdate(pending.spend.ledgerId, { status: "declined" });
    result = { declined: true, note: "The person said no, so this was not done. Do not do it or offer it again now. If their message asked anything else, answer that; otherwise say in a few words that you left it as it was." };
  } else {
    console.log(`Confirmed, calling tool: ${pending.toolName}`);
    if (pending.isInternal) {
      result = await handleInternalTool(pending.toolName, pending.toolInput);
    } else {
      result = await callMCPTool(pending.toolName, pending.toolInput);
    }
    if (pending.spend && pending.spend.ledgerId) {
      await ledgerUpdate(pending.spend.ledgerId, { status: result && result.error ? "failed" : "completed", approved_via: pending.isAgent ? "agent" : "chat" });
    }
  }

  // Lazy require to avoid circular dep with engine.js
  const { buildSystemPrompt, buildVolatileSystemTail } = require("./engine");

  const messages = [
    ...pending.messages,
    {
      role: "user",
      content: [
        ...(pending.otherToolResults || []),
        {
          type: "tool_result",
          tool_use_id: pending.toolUseId,
          content: JSON.stringify(result.content || result),
        },
      ],
    },
  ];

  try {
    const { client: llm, model: defaultModel } = getUserLLMClient(userId);
    const { getAllTools } = require("./engine");

    // This call used to be made without tools, so once a confirmed action had
    // run, Closedhand could produce one closing sentence and nothing else. A
    // task that continued past the confirmation simply stopped: it would say
    // "verifying both drafts" and have no means to verify anything, which is
    // what the user saw. Carry on with the tools available, as any other turn.
    const tools = [...getAllTools(), ...getUserMcpToolDefs(userId)];
    // Same unlock the chat engine does for on-demand tools, so the task can
    // carry on with the sandbox browser after a confirmation as it could before.
    const { INTERNAL_TOOLS } = require("./tools/definitions");
    const unlockTool = (name) => {
      if (tools.find((t) => t.name === name)) return;
      const def = INTERNAL_TOOLS.find((t) => t.name === name);
      if (def) tools.push({ name: def.name, description: def.description, input_schema: def.input_schema });
      else { const m = getUserMcpToolDefs(userId).find((t) => t.name === name); if (m) tools.push(m); }
    };
    let finalText = "";

    for (let i = 0; i < 8; i++) {
      const apiResponse = await llm.messages.create({
        model: defaultModel,
        max_tokens: 4096,
        system: buildSystemPrompt() + buildVolatileSystemTail(),
        tools,
        messages,
      });

      const toolUses = apiResponse.content.filter(b => b.type === "tool_use");
      finalText = apiResponse.content.filter(b => b.type === "text").map(b => b.text).join("");
      if (toolUses.length === 0) break;

      messages.push({ role: "assistant", content: apiResponse.content });
      const results = [];
      for (const block of toolUses) {
        // One "yes" authorises one action. Anything else sensitive has to be
        // put to the user on its own terms, so it is refused here rather than
        // gated again, and the engine raises it properly on the next turn.
        if (ACTIONS_NEEDING_CONFIRMATION.includes(block.name) || (isUserMcpTool(block.name) && needsMcpConfirmation(userId, block.name))) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Not run. The user confirmed one action, not this one. Tell them plainly what still needs doing and stop.",
          });
          continue;
        }
        try {
          const r = isInternalTool(block.name)
            ? await handleInternalTool(block.name, { ...block.input, _userId: userId, _chatId: chatId })
            : await callMCPTool(block.name, block.input);
          if (block.name === "get_tool_details" && r && !r.error && r.name) unlockTool(r.name);
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(r?.content || r) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${e.message}` });
        }
      }
      messages.push({ role: "user", content: results });
    }

    if (isNo && !String(finalText || "").trim()) finalText = "OK, I've left it as it was.";
    conversation.push({ role: "user", content: isNo ? "No, cancel that." : "Yes, go ahead." });
    conversation.push({ role: "assistant", content: finalText });
    saveStore();
    return finalText;
  } catch (error) {
    if (isNo) {
      conversation.push({ role: "user", content: "No, cancel that." });
      conversation.push({ role: "assistant", content: "OK, I've left it as it was." });
      saveStore();
      return "OK, I've left it as it was.";
    }
    return `Error after confirmation: ${error.message}`;
  }
}

// The user answered something else, or the question lapsed: forget the held
// action, note it in the conversation, and mark the task so it stops waiting.
async function dropPending(userId, reason) {
  const pending = ctx.pendingConfirmations[userId];
  if (!pending) return;
  delete ctx.pendingConfirmations[userId];
  const conversation = getConversation(userId);
  conversation.push({ role: "user", content: reason === "lapsed" ? "[The question lapsed unanswered, action cancelled]" : "[User moved on, action cancelled]" });
  conversation.push({ role: "assistant", content: "OK, cancelled." });
  saveStore();
  if (pending.isAgent) await require("./agents").dropConfirmation(pending, reason);
}

module.exports = { ACTIONS_NEEDING_CONFIRMATION, handleConfirmation, dropPending, confirmationAnswer };
