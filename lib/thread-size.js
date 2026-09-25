// Offer optional topic separation once per thread after substantial input.
// Input usage includes instructions, tools and recalled context, not just history.
// Do not present it as a history size or a requirement to reset the conversation.
const LONG_THREAD_TOKENS = 20000;
const FACT = "_long-thread-notice";
function carriedTokens(usage) {
  return (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
}
function longThreadNotice(store, threadId, usage) {
  const carried = carriedTokens(usage);
  if (carried < LONG_THREAD_TOKENS || !store) return null;
  store.facts = store.facts || {};
  const noticed = store.facts[FACT];
  const last = noticed && typeof noticed === "object" ? noticed.value : noticed;
  const thread = threadId || "default";
  if (last === thread) return null;
  store.facts[FACT] = thread;
  return "[Thread note: You can keep chatting here; older history is condensed automatically. For a new topic, /new starts a separate thread. Earlier conversations stay saved.]";
}
module.exports = { LONG_THREAD_TOKENS, carriedTokens, longThreadNotice };
