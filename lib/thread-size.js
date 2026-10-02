// Offer optional topic separation once per thread, once the conversation
// itself has grown long. Measured on the thread's own messages: the model's
// instructions, tools and recalled context are about as large on the first
// message as on the hundredth, and counting them made the notice fire on a
// thread's second or third reply. Do not present it as a history size or a
// requirement to reset the conversation.
const LONG_THREAD_TOKENS = 20000;
const FACT = "_long-thread-notice";
function historyTokens(conversation) {
  const { estimateMessageTokens } = require("./token-tracker");
  return (conversation || []).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
function longThreadNotice(store, threadId, conversation) {
  if (!store || historyTokens(conversation) < LONG_THREAD_TOKENS) return null;
  store.facts = store.facts || {};
  const noticed = store.facts[FACT];
  const last = noticed && typeof noticed === "object" ? noticed.value : noticed;
  const thread = threadId || "default";
  if (last === thread) return null;
  store.facts[FACT] = thread;
  return "[Thread note: You can keep chatting here; older history is condensed automatically. For a new topic, /new starts a separate thread. Earlier conversations stay saved.]";
}
module.exports = { LONG_THREAD_TOKENS, historyTokens, longThreadNotice };
