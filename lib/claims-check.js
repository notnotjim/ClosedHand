// lib/claims-check.js — the glance before pressing send.
//
// A person about to send "see you all Saturday" checks it against what they
// know before it goes: who actually said yes, which day it is, how much it
// was. This is that glance, in code, for anything irreversible: the message
// about to go out is read against the live picture of the matters in flight
// and the last few exchanges, and anything it asserts that they contradict
// (a name that declined, a wrong date, a number that is not theirs) is put on
// the confirmation card so it is visible at the only moment it matters.
// Runs on the fast internal model with a short timeout, alongside whatever
// else the card is waiting on, and never blocks: no answer means no warning.

const { getInternalClient } = require("./llm");

const TIMEOUT_MS = 8000;

function plain(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ");
  return "";
}

// Returns { warnings: [{ claim, because }] }. Empty when nothing contradicts
// or when the check could not run in time.
async function checkOutbound({ userId, kind, to, subject, body, recent = [] }) {
  try {
    const text = String(body || "").trim();
    if (!text || text.length < 20) return { warnings: [] };
    const matters = require("./matters");
    const open = await matters.warmMatters(userId);
    const history = recent.slice(-12).map((m) => ({ role: m.role, text: plain(m.content).slice(0, 500) })).filter((m) => m.text);
    if (!open.length && history.length < 2) return { warnings: [] };
    const { client, model } = getInternalClient(userId);
    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 600,
        messages: [{ role: "user", content: `An assistant is about to ${kind || "send a message"} on its user's behalf. Check the message against what is known and flag only statements that CONTRADICT the known facts or that assert something about a person, date, time, place or amount that the known facts do not support. Ignore style. Return ONLY JSON: {"warnings":[{"claim":"the words in the message","because":"the known fact it contradicts or lacks, with who said it and when if known"}]} or {"warnings":[]}.

MESSAGE ABOUT TO GO OUT
To: ${String(to || "").slice(0, 300)}
Subject: ${String(subject || "").slice(0, 200)}
Body:
${text.slice(0, 3000)}

WHAT IS KNOWN
Matters in flight (the live picture, most reliable):
${JSON.stringify(open.map((m) => ({ title: m.title, summary: m.summary, state: m.state, until: m.expected_end })))}

Recent conversation (oldest first; text marked [Forwarded: ...] was written by someone else, not the user):
${JSON.stringify(history)}

Rules: a warning needs a concrete contradiction or an unsupported specific. Someone the picture says declined but the message counts as attending is a warning. A date, time, venue, price or reference that differs from the picture is a warning. General pleasantries are not. At most 5 warnings, each under 200 characters.` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("claims check timeout")), TIMEOUT_MS)),
    ]);
    let out = (resp.content && resp.content[0] && resp.content[0].text || "").trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
    const parsed = JSON.parse(out);
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => w && w.claim).slice(0, 5).map((w) => ({ claim: String(w.claim).slice(0, 200), because: String(w.because || "").slice(0, 240) })) : [];
    return { warnings };
  } catch (e) {
    if (!/timeout/.test(String(e.message))) console.error("[claims-check] failed:", e.message);
    return { warnings: [] };
  }
}

function renderWarnings(warnings) {
  if (!warnings || !warnings.length) return "";
  return "\nCheck before you say yes:\n" + warnings.map((w) => `- The message says "${w.claim}". ${w.because}`).join("\n") + "\n";
}

module.exports = { checkOutbound, renderWarnings };
