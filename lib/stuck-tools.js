// lib/stuck-tools.js -- the same failure, again and again.
//
// A source that rate-limits, or a run that keeps hitting the workspace's
// time cap, does not get better with retries; an agent kept at it for eight
// minutes and twenty-two runs on a house-price question it had half
// answered. This reads the results of each iteration and, after three
// iterations in a row that only failed the same way, tells the model to
// stop retrying and report. After six, it is told to answer now.
const SIGNS = [
  [/\b429\b|Too Many Requests|rate.?limit/i, "the source is rate-limiting you"],
  [/"exit_code":\s*-1|timed out|ETIMEDOUT|timeout/i, "the run is timing out"],
  [/\b(503|502|504)\b|Service Unavailable|Bad Gateway/i, "the source is unavailable"],
];
function textOf(results) {
  return results.map(r => typeof r.content === "string" ? r.content : JSON.stringify(r.content || "")).join("\n");
}
function failureSign(results) {
  const text = textOf(results);
  for (const [pattern, why] of SIGNS) if (pattern.test(text)) return why;
  return null;
}
// Returns a note to put to the model, or null. `streak` is mutated: { sign, count }.
function stuckNote(results, streak) {
  const sign = failureSign(results);
  if (!sign) { streak.sign = null; streak.count = 0; return null; }
  if (streak.sign === sign) streak.count += 1; else { streak.sign = sign; streak.count = 1; }
  if (streak.count === 3) return `Note from the system: ${sign}, for the third iteration running. Retrying, waiting and polling will not change that. Stop trying this route. Answer with what you already have, say plainly what is blocked and why, and suggest trying again later if that would help.`;
  if (streak.count >= 6) return `Note from the system: ${sign}, for the ${streak.count}th iteration running. Make no more tool calls. Write the final answer now from what you have, and state what could not be obtained.`;
  return null;
}
module.exports = { stuckNote, failureSign };
