// A long thread makes every reply re-read it, and nothing in a chat shows
// that. Once per thread, when a reply carried more than LONG_THREAD_TOKENS
// in, the reply ends with how big it has grown and how to start fresh.
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
  return `This conversation has grown long, so each reply now carries about ${Math.round(carried / 1000)}k tokens of history. Send /new to start fresh when you change topic.`;
}
module.exports = { LONG_THREAD_TOKENS, carriedTokens, longThreadNotice };
