// Evidence crosses executor boundaries as data, with tool-call identities intact.
const { randomUUID } = require("crypto");

function textOf(content) {
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(b => b.type === "text").map(b => b.text || "").join("\n") : "";
}
function excerpt(text, limit = 2000) {
  const s = String(text || "");
  if (s.length <= limit) return s;
  const n = Math.floor((limit - 80) / 2);
  return s.slice(0, n) + "\n[Excerpt; omitted material is not evidence of absence.]\n" + s.slice(-n);
}
function resultFailed(result) {
  if (!result || result.is_error || result.isError) return true;
  let content = result.content;
  try { if (typeof content === "string") content = JSON.parse(content); } catch (_) {}
  return !!(content && (content.error || content.isError || content.success === false));
}
function evidenceFrom(messages, limit = 36000) {
  const calls = new Map(); const evidence = [];
  for (const m of messages || []) for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === "tool_use") calls.set(b.id, b);
    if (b.type === "tool_result" && calls.has(b.tool_use_id)) {
      const call = calls.get(b.tool_use_id);
      evidence.push({ id: call.id, tool: call.name, input: call.input, failed: resultFailed(b), result: b.content });
    }
  }
  const perItem = Math.max(300, Math.floor(limit / Math.max(1, evidence.length)));
  return evidence.map(e => ({ ...e, input: excerpt(JSON.stringify(e.input), 800),
    result: excerpt(typeof e.result === "string" ? e.result : JSON.stringify(e.result), perItem) }));
}
function captureRequest(messages, goal, boundary, identity = {}) {
  // Object identity survives normal appends. If compression replaced history,
  // locate the last real user turn; never take an arbitrary tail of old tools.
  let start = messages.indexOf(boundary);
  if (start < 0) {
    start = messages.findLastIndex(m => m.role === "user" && textOf(m.content).includes(goal));
  }
  const selected = start >= 0 ? messages.slice(start) : [{ role: "user", content: goal }];
  return { requestId: randomUUID(), ...identity, goal,
    context: start > 0 ? messages.slice(Math.max(0, start - 4), start)
      .map(m => ({ role: m.role, content: excerpt(textOf(m.content), 1200) })).filter(m => m.content) : [],
    messages: JSON.parse(JSON.stringify(selected)), capturedAt: new Date().toISOString() };
}
function handoverMessages(snapshot) {
  return [
    { role: "user", content: `Continue this request: ${snapshot.goal}\nEarlier conversation is context only, not evidence gathered for this request:\n${JSON.stringify(snapshot.context || [])}` },
    ...(snapshot.messages || []),
    { role: "user", content: "Continue from the tool results above. Preserve the user's corrections, source references and successful action receipts. Do not repeat completed actions. Finish only the remaining work." },
  ];
}
function successfulDeliveryKeys(messages, keyFor) {
  const calls = new Map(); const keys = new Set();
  for (const m of messages || []) for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === "tool_use") calls.set(b.id, b);
    if (b.type === "tool_result" && !resultFailed(b)) {
      const c = calls.get(b.tool_use_id); const key = c && keyFor(c.name, c.input);
      if (key) keys.add(key);
    }
  }
  return keys;
}
function uncertainDeliveryKeys(messages, keyFor) {
  const calls = new Map(); const results = new Set();
  for (const m of messages || []) for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === "tool_use") calls.set(b.id, b);
    if (b.type === "tool_result") results.add(b.tool_use_id);
  }
  return new Set([...calls.values()].filter(c => !results.has(c.id)).map(c => keyFor(c.name, c.input)).filter(Boolean));
}
module.exports = { uncertainDeliveryKeys, textOf, excerpt, resultFailed, evidenceFrom, captureRequest, handoverMessages, successfulDeliveryKeys };
