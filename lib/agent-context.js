// Keep the full saved transcript, but bound the evidence sent on each model call.
const { modelCall } = require("./task-model");
const { estimateContextTokens, getContextWindow } = require("./token-tracker");
const EXCERPT_NOTE = "\n[Excerpt of a larger tool result. Omitted text is not evidence of absence. Narrow the lookup to read the relevant source in full.]";
function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - EXCERPT_NOTE.length);
  const head = Math.ceil(room * 0.8);
  return text.slice(0, head) + EXCERPT_NOTE + (room > head ? text.slice(-(room - head)) : "");
}
function prepareAgentMessages(params, provider, fraction = 0.5, contextWindow) {
  const messages = params.messages.map(message => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map(block =>
      block.type === "tool_result" && typeof block.content === "string"
        ? { ...block, content: excerpt(block.content, 40000) } : block) : message.content,
  }));
  for (let i = 0; i < messages.length; i++) {
    const calls = Array.isArray(messages[i].content) ? messages[i].content.filter(b => b.type === "tool_use") : [];
    if (!calls.length) continue;
    const next = messages[i + 1];
    const results = next?.role === "user" && Array.isArray(next.content) ? next.content : [];
    const missing = calls.filter(c => !results.some(b => b.type === "tool_result" && b.tool_use_id === c.id));
    if (missing.length) {
      const repairs = missing.map(c => ({ type: "tool_result", tool_use_id: c.id, is_error: true,
        content: "Execution was interrupted without a saved receipt. This action may or may not have happened. Check its state before retrying; do not repeat a send or purchase without confirmation." }));
      if (next?.role === "user" && Array.isArray(next.content)) next.content = [...next.content, ...repairs];
      else messages.splice(i + 1, 0, { role: "user", content: repairs });
    }
  }
  const budget = Math.max(1000, ((contextWindow || getContextWindow(provider)) - (params.max_tokens || 4096)) * fraction);
  const estimate = () => estimateContextTokens(messages, params.system, params.tools, provider).total;
  const results = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === "tool_result" && typeof block.content === "string");
  // Leave room for tokenisation differences, especially dense JSON. Reduce
  // the largest payload first, retaining IDs, tool pairing and user steering.
  while (estimate() > budget) {
    const biggest = results.filter(block => block.content.length > 1000)
      .sort((a, b) => b.content.length - a.content.length)[0];
    if (!biggest) break;
    biggest.content = excerpt(biggest.content, Math.max(1000, Math.floor(biggest.content.length / 2)));
  }
  return messages;
}
function isContextOverflow(error) {
  return /maximum (?:prompt|context) length|context (?:length|window).*(?:exceed|limit)|too many (?:input )?tokens|prompt.*too long/i.test(String(error?.message || ""));
}
async function createAgentResponse(client, params, provider, options = {}) {
  const limits = await client.getModelLimits?.(params.model);
  const messages = prepareAgentMessages(params, provider, 0.5, limits?.contextWindow);
  if (provider === "anthropic" && typeof params.system === "string") params = { ...params, system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }] };
  try {
    return await modelCall(client, { ...params, messages }, options);
  } catch (error) {
    if (!isContextOverflow(error)) throw error;
    // Estimates are a pressure gauge. If the provider rejects the real token
    // count, retry once with less evidence; never repeat an oversized payload.
    const smaller = prepareAgentMessages(params, provider, 0.25, limits?.contextWindow);
    if (JSON.stringify(smaller) === JSON.stringify(messages)) throw error;
    return modelCall(client, { ...params, messages: smaller }, options);
  }
}
module.exports = { prepareAgentMessages, createAgentResponse, isContextOverflow };
