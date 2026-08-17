// lib/confirmation.js — Confirmation system for destructive actions

const ctx = require("./context");
const { getUserLLMClient } = require("./llm");
const { saveStore } = require("./storage");
const { getConversation } = require("./conversation");
const { isInternalTool, handleInternalTool } = require("./tools/handlers");
const { callMCPTool } = require("./mcp");
const { sendTyping } = require("./messaging");
const { CONNECTABLE_SERVICES } = require("./services-config");

const ACTIONS_NEEDING_CONFIRMATION = [
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
  "api_request",
  "sandbox_gateway",
];

async function handleConfirmation(userId, chatId, response) {
  const pending = ctx.pendingConfirmations[userId];
  if (!pending) return false;

  const isYes = response.toLowerCase().match(/^(yes|y|yep|yeah|go|confirm|do it|ok|send it)$/);
  const isNo = response.toLowerCase().match(/^(no|n|nope|nah|cancel|stop|don't)$/);

  if (!isYes && !isNo) return false;

  delete ctx.pendingConfirmations[userId];
  const conversation = getConversation(userId);

  // A background agent paused for a send confirmation: resume it rather than
  // running the chat continuation loop below. On yes it sends and carries on;
  // on no it is told the send was declined.
  if (pending.isAgent) {
    const { resumeAgentAfterConfirmation } = require("./agents");
    conversation.push({ role: "user", content: isYes ? "Yes, send it." : "No, do not send it." });
    const ack = await resumeAgentAfterConfirmation(pending, !!isYes, chatId);
    conversation.push({ role: "assistant", content: ack });
    saveStore();
    return ack;
  }

  if (isNo) {
    conversation.push({ role: "user", content: "No, cancel that." });
    conversation.push({ role: "assistant", content: "Cancelled." });
    saveStore();
    return "Cancelled.";
  }

  sendTyping(chatId);
  console.log(`Confirmed — calling tool: ${pending.toolName}`);
  let result;
  if (pending.isInternal) {
    result = await handleInternalTool(pending.toolName, pending.toolInput);
  } else {
    result = await callMCPTool(pending.toolName, pending.toolInput);
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
    // run, ClosedHand could produce one closing sentence and nothing else. A
    // task that continued past the confirmation simply stopped: it would say
    // "verifying both drafts" and have no means to verify anything, which is
    // what the user saw. Carry on with the tools available, as any other turn.
    const tools = getAllTools();
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
        if (ACTIONS_NEEDING_CONFIRMATION.includes(block.name)) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Not run. The user confirmed one action, not this one. Tell them plainly what still needs doing and stop.",
          });
          continue;
        }
        try {
          const r = isInternalTool(block.name)
            ? await handleInternalTool(block.name, block.input)
            : await callMCPTool(block.name, block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(r?.content || r) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${e.message}` });
        }
      }
      messages.push({ role: "user", content: results });
    }

    conversation.push({ role: "user", content: "Yes, go ahead." });
    conversation.push({ role: "assistant", content: finalText });
    saveStore();
    return finalText;
  } catch (error) {
    return `Error after confirmation: ${error.message}`;
  }
}

module.exports = { ACTIONS_NEEDING_CONFIRMATION, handleConfirmation };
