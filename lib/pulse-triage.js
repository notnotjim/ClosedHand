const BARS = {
  low: "Only flag genuinely urgent things: same-day deadlines, imminent travel, money leaving the account, direct personal requests.",
  medium: "Flag things a busy person would want a nudge about: deadlines, travel, payments, personal messages needing replies, imminent events.",
  high: "Flag anything plausibly useful to mention: the above plus notable updates, confirmations, and changes.",
};
// Pulse's cheap screen: one short support-model call over the new items,
// before the writer (and its tools) is woken. A reply that can't be read
// counts as nothing to report.
async function triage({ items, level, fallback }) {
  const raw = await fallback(
    `You triage new items for a proactive assistant. ${BARS[level] || BARS.medium} Respond ONLY with JSON: {"pulse": true/false, "flagged": ["one-line reason per flagged item"]}`,
    `New items since last check:\n${items.join("\n")}`, 300);
  let verdict = { pulse: false, flagged: [] };
  try { verdict = JSON.parse((raw || "").match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch {}
  return verdict;
}
module.exports = { triage };
