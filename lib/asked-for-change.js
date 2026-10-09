// Whether the person asked for the change Closedhand is about to put to
// them. "What's on today?" once came back as a card asking to move a
// calendar event: the prompt already said to change things only when asked,
// and a rule the model can talk itself past is not a rule. So the check is
// made here, in code, at the moment a change would be proposed: one short
// support-model call, only on the rare turns that reach a change, so an
// ordinary question costs nothing extra. If the check cannot be made, the
// card still goes out: the person's yes or no is the safety net behind it.

function text(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ");
  return "";
}

// Closedhand's last words before the person's latest message, so "yes" or
// "7pm" can be read as the answer to an offer or a question.
function lastAssistantBefore(conversation, userMessage) {
  const msgs = Array.isArray(conversation) ? conversation : [];
  let i = msgs.length - 1;
  if (i >= 0 && msgs[i].role === "user" && text(msgs[i]) === String(userMessage || "")) i--;
  for (; i >= 0; i--) if (msgs[i].role === "assistant") return text(msgs[i]);
  return "";
}

function describe(toolName, input) {
  const shown = {};
  for (const [k, v] of Object.entries(input || {})) if (!k.startsWith("_")) shown[k] = v;
  return `${toolName} ${JSON.stringify(shown)}`.slice(0, 600);
}

async function askedForChange({ userId, store, userMessage, lastAssistant = "", toolName, input }) {
  try {
    const { client, model } = require("./llm").getInternalClient(userId, store);
    const res = await require("./task-model").modelCall(client, {
      model, max_tokens: 5, effort: "fast",
      system: "You check one thing for a personal assistant. In their latest message, did the person ask the assistant to do this kind of thing (send this message, change or delete this event, and so on), or agree to it? Judge the action, not its exact wording or details: those go on a card for the person to check. Read the message with the assistant's message before it: \"yes\" to an offer, or an answer to the assistant's question about something they wanted done, counts as asking. A question, news or a request for information does not, even when the assistant noticed something worth changing. Reply with only yes or no.",
      messages: [{ role: "user", content: `Assistant's previous message: ${String(lastAssistant || "(none)").slice(0, 1500)}\n\nPerson's latest message: ${String(userMessage || "").slice(0, 1500)}\n\nThe change about to be put to them: ${describe(toolName, input)}` }],
    }, { purpose: "asked-for-change", timeoutMs: 8000 });
    const out = (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim().toLowerCase();
    if (/^yes\b/.test(out)) return true;
    if (/^no\b/.test(out)) return false;
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = { askedForChange, lastAssistantBefore, describe };
