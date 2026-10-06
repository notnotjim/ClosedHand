// Sums and comparisons in a chat answer, checked before it is sent. An answer
// once said Food (£37.55) was "ahead of Transport, Books and Leisure combined"
// when those three come to £51.99, and that a £23.45 shop beat two categories
// worth £29.99 together. The figures were right; the arithmetic between them
// was not. Background agents have a check like this (lib/verification.js);
// chat answers had none.
//
// It runs only on answers that both state figures and compare or add them,
// reads them against what this turn looked at and against the answer's own
// numbers, and replaces just the sentences that are wrong. No answer from the
// check in time means the answer goes as written.

const TIMEOUT_MS = 12000;
const COMPARES = /\b(more than|less than|fewer than|bigger than|smaller than|higher than|lower than|combined|together|put together|ahead of|behind|outweigh|beats?|in total|totals?|totalling|sum|twice|half|double|triple|times as|times more|average|on its own|alone)\b|%/i;

function worthChecking(answer) {
  const text = String(answer || "");
  const numbers = text.match(/\d[\d,]*(?:\.\d+)?/g) || [];
  return numbers.length >= 3 && COMPARES.test(text);
}

function plain(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && (b.text || (typeof b.content === "string" ? b.content : Array.isArray(b.content) ? plain(b.content) : "")))).join("\n");
  return "";
}

// What this turn read: the person's message (with any file preview) and the
// tool results since it, newest last, trimmed to a size the check can read.
function evidenceFrom(messages, userMessage) {
  const parts = [String(userMessage || "")];
  for (const m of messages || []) {
    if (!m || m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === "tool_result") parts.push(plain(b.content));
  }
  const text = parts.filter(Boolean).join("\n---\n");
  return text.length > 12000 ? text.slice(-12000) : text;
}

// Models are poor at sums and code is exact, so the work is split: the model
// only lifts each claim out as numbers, code does the arithmetic, and the
// model rewrites just the sentences the arithmetic proved wrong, given the
// true figures.
const RELATIONS = { ">": (a, b) => a > b, "<": (a, b) => a < b, ">=": (a, b) => a >= b, "<=": (a, b) => a <= b, "=": (a, b) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005) };
const sum = (xs) => (Array.isArray(xs) ? xs : [xs]).map(Number).filter((n) => Number.isFinite(n)).reduce((a, b) => a + b, 0);
const round = (n) => Math.round(n * 100) / 100;

// Several numbers on one side are added only when the sentence says to
// ("combined", "together"). An answer that was right ("more than Transport
// and well ahead of Books and Leisure") was once read as one combined sum and
// "corrected" into a wrong one; read as separate comparisons it holds.
const COMBINES = /\b(combined|together|put together|in total|altogether|between them|added up|summed|sum of|plus)\b|\+/i;
const numbersIn = (text) => (String(text || "").replace(/,(?=\d{3}\b)/g, "").match(/\d+(?:\.\d+)?/g) || []).map(Number);
function seenIn(n, pool) { return pool.some((m) => Math.abs(m - n) < 0.005); }

function judge(claim, sentence = claim && claim.sentence, evidence = "") {
  if (!claim || typeof claim !== "object") return null;
  // Every number in the claim must be one the sentence or the evidence holds.
  const pool = numbersIn(sentence).concat(numbersIn(evidence));
  const all = [].concat(claim.left ?? [], claim.right ?? [], claim.part ?? [], claim.whole ?? [], claim.percent ?? []).map(Number).filter(Number.isFinite);
  if (pool.length && !all.every((n) => seenIn(n, pool))) return null;
  const combined = COMBINES.test(String(sentence || ""));
  const lefts = [].concat(claim.left ?? []), rights = [].concat(claim.right ?? []);
  if (!combined && (lefts.length > 1 || rights.length > 1) && claim.relation) {
    for (const l of lefts) for (const r of rights) {
      const why = judge({ left: [l], relation: claim.relation, right: [r] }, "", "");
      if (why) return why;
    }
    return null;
  }
  if (claim.percent !== undefined) {
    const part = Number(claim.part), whole = Number(claim.whole), pct = Number(claim.percent);
    if (!(whole > 0) || !Number.isFinite(part) || !Number.isFinite(pct)) return null;
    const actual = (part / whole) * 100;
    return Math.abs(actual - pct) <= 0.6 ? null : `${part} is ${round(actual)}% of ${whole}, not ${pct}%`;
  }
  const test = RELATIONS[claim.relation];
  if (!test) return null;
  const left = sum(claim.left), right = sum(claim.right);
  if (!left && !right) return null;
  if (test(left, right)) return null;
  const word = left > right ? "more than" : left < right ? "less than" : "the same as";
  return `${(Array.isArray(claim.left) ? claim.left : [claim.left]).join(" + ")} = ${round(left)}, which is ${word} ${(Array.isArray(claim.right) ? claim.right : [claim.right]).join(" + ")} = ${round(right)}`;
}

async function ask(userId, store, system, content, maxTokens) {
  const { client, model } = require("./llm").getInternalClient(userId, store);
  const res = await require("./task-model").modelCall(client, {
    model, max_tokens: maxTokens, effort: "fast", system, messages: [{ role: "user", content }],
  }, { purpose: "figures-check", timeoutMs: TIMEOUT_MS });
  const raw = (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return JSON.parse((raw.match(/\{[\s\S]*\}/) || ["{}"])[0]);
}

async function correct({ userId, store, answer, evidence = "" }) {
  try {
    const found = await ask(userId, store,
      "List every claim in the answer that compares figures or adds them up, as numbers, without judging whether it is right. For a comparison: {\"sentence\": exact sentence from the answer, \"left\": [numbers on one side, several if it says combined or together], \"relation\": one of > < >= <= =, \"right\": [numbers on the other side]}. For a percentage: {\"sentence\": ..., \"part\": n, \"whole\": n, \"percent\": n}. Take numbers from the answer, or from the evidence when the answer names something without its figure. Return ONLY JSON: {\"claims\": [...]}.",
      `ANSWER:\n${String(answer).slice(0, 6000)}\n\nEVIDENCE THIS TURN READ:\n${String(evidence || "(none)").slice(0, 12000)}`, 900);
    const wrong = [];
    for (const c of Array.isArray(found.claims) ? found.claims.slice(0, 12) : []) {
      const why = judge(c, c && c.sentence, evidence);
      const sentence = String(c && c.sentence || "").trim();
      if (why && sentence.length >= 12 && String(answer).includes(sentence)) wrong.push({ sentence, why });
    }
    if (!wrong.length) return answer;
    const fixes = await ask(userId, store,
      "Rewrite each sentence so it is true, using the arithmetic given, which is correct. Keep the same style and length and change only the wrong claim, dropping any words that no longer fit, so it reads naturally. Return ONLY JSON: {\"fixes\": [{\"wrong\": the sentence exactly as given, \"right\": the rewritten sentence}]}.",
      JSON.stringify(wrong), 700);
    let out = String(answer);
    let fixed = 0;
    for (const f of Array.isArray(fixes.fixes) ? fixes.fixes : []) {
      const was = String(f && f.wrong || "").trim();
      const now = String(f && f.right || "").trim();
      if (!now || !wrong.some((w) => w.sentence === was) || !out.includes(was)) continue;
      out = out.replace(was, now);
      fixed++;
    }
    if (fixed) console.log(`[figures-check] corrected ${fixed} claim(s) before sending`);
    return out;
  } catch (_) {
    return answer;
  }
}

module.exports = { worthChecking, evidenceFrom, correct, judge };
