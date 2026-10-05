// The test at every level: a nudge must add something the item did not. An
// email already told the person what it says when it arrived, so passing it
// on is noise. A good assistant speaks up when something needs doing soon
// and could be missed, when it connects to something else in their life, or
// when it changes a plan they rely on. The level sets how much it must add.
const ADDS = "An email already told the person what it says when it arrived. Flag an item only when a nudge would add something it did not: it needs them to act soon (today or tomorrow) and is easy to miss; it connects to something else of theirs (a calendar event, a trip, a goal, another message) in a way they may not have noticed; or it changes something they are relying on. A deadline weeks away is not worth a nudge on the day its email arrives. Confirmations, codes they asked for, renewals, newsletters and marketing never are.";
const BARS = {
  low: "Only flag what goes wrong in the next few hours if they do not hear about it now: a travel change, money leaving unexpectedly, a direct request due today.",
  medium: "Flag what a busy person would thank you for: action due today or tomorrow that is easy to miss, a clash or change affecting their plans, a personal message waiting on them.",
  high: "Also flag useful connections between things and notable changes, still only where the nudge adds something.",
};
// Pulse's cheap screen: one short support-model call over the new items,
// before the writer (and its tools) is woken. A reply that can't be read
// counts as nothing to report.
// goals: what the person says they are working towards. An item that moves
// one forward or puts one at risk clears the bar.
// now: the current date and time where the person is, so "due tomorrow" and
// "weeks away" can be told apart.
async function triage({ items, level, goals = [], now = "", fallback }) {
  const aims = goals.length ? ` The person is working towards: ${goals.map((g) => `"${g}"`).join("; ")}. An item that moves one of these forward or puts one at risk is worth flagging.` : "";
  const raw = await fallback(
    `You triage new items for a proactive assistant. ${ADDS} ${BARS[level] || BARS.medium}${aims} Respond ONLY with JSON: {"pulse": true/false, "flagged": ["one line per flagged item: what the nudge adds that the item itself did not"]}`,
    `${now ? now + "\n\n" : ""}New items since last check:\n${items.join("\n")}`, 300);
  let verdict = { pulse: false, flagged: [] };
  try { verdict = JSON.parse((raw || "").match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch {}
  return verdict;
}
module.exports = { triage };
