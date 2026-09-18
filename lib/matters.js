const { responseText } = require("./model-wire");
// lib/matters.js — the live picture of each matter in flight.
//
// The transcript is not the picture. A person following a party, a shipment
// or a negotiation keeps a small running record (who is involved, what each
// has said, what is open, what was decided) and updates it as messages
// arrive; when they act they act from the record, not from a memory of
// forty messages. This module keeps that record per matter: a background
// pass after every turn, on the fast internal model and off the reply's
// critical path, decides which matter the turn touched (or that it opened
// one) and rewrites its state. The open matters ride in the prompt as a
// compact block, and the claims check reads them before anything
// irreversible goes out.
//
// Staleness is part of the design, not an afterthought: a matter with an
// end date resolves itself two days after it; a matter nobody has mentioned
// for a fortnight is marked stale and leaves the prompt; a stale one is
// deleted a month later. So last month's party cannot complicate this one.

const { supabase } = require("./db");
const { getInternalClient } = require("./llm");

const STALE_AFTER_MS = 14 * 86400000;
const DELETE_STALE_AFTER_MS = 30 * 86400000;
const END_GRACE_MS = 2 * 86400000;
const MAX_IN_PROMPT = 6;
const MAX_CHARS_EACH = 700;

// userId -> { at, open: [rows] }
const _cache = new Map();
const TTL_MS = 20 * 1000;

async function listOpen(userId) {
  const { data, error } = await supabase
    .from("matters")
    .select("id, title, summary, state, status, expected_end, last_touched, created_at")
    .eq("user_id", userId)
    .eq("status", "open")
    .order("last_touched", { ascending: false })
    .limit(20);
  if (error) { console.error("[matters] list failed:", error.message); return []; }
  return data || [];
}

async function listAll(userId) {
  const { data, error } = await supabase
    .from("matters")
    .select("id, title, summary, state, status, expected_end, last_touched, created_at, resolved_at")
    .eq("user_id", userId)
    .order("last_touched", { ascending: false })
    .limit(100);
  if (error) { console.error("[matters] list failed:", error.message); return []; }
  return data || [];
}

async function dbUpdate(id, patch) {
  const { error } = await supabase.from("matters").update(patch).eq("id", id);
  if (error) console.error("[matters] update failed:", error.message);
}

// Silence and end dates decide staleness, in code, every time the matters
// are loaded, so nothing depends on a pass that might not run.
async function sweep(userId, rows) {
  const now = Date.now();
  const keep = [];
  for (const m of rows) {
    const end = m.expected_end ? new Date(m.expected_end).getTime() : null;
    const touched = new Date(m.last_touched).getTime();
    if (end && now > end + END_GRACE_MS) {
      await dbUpdate(m.id, { status: "resolved", resolved_at: new Date().toISOString() });
      continue;
    }
    if (now - touched > STALE_AFTER_MS) {
      await dbUpdate(m.id, { status: "stale" });
      continue;
    }
    keep.push(m);
  }
  // Old stale rows go for good.
  const cutoff = new Date(now - STALE_AFTER_MS - DELETE_STALE_AFTER_MS).toISOString();
  const { error } = await supabase.from("matters").delete().eq("user_id", userId).eq("status", "stale").lt("last_touched", cutoff);
  if (error) console.error("[matters] sweep delete failed:", error.message);
  return keep;
}

async function warmMatters(userId) {
  if (!userId) return [];
  const hit = _cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.open;
  const open = await sweep(userId, await listOpen(userId));
  _cache.set(userId, { at: Date.now(), open });
  return open;
}

function invalidate(userId) { _cache.delete(userId); }

function shortDate(iso) {
  try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); } catch { return ""; }
}

function renderOne(m) {
  const s = m.state || {};
  const parts = [];
  if (Array.isArray(s.people) && s.people.length) {
    parts.push("People: " + s.people.map((p) => `${p.name}${p.position ? " (" + p.position + ")" : ""}${p.said ? ": " + p.said : ""}${p.when ? " [" + shortDate(p.when) + "]" : ""}`).join("; "));
  }
  if (Array.isArray(s.facts) && s.facts.length) parts.push("Facts: " + s.facts.join("; "));
  if (Array.isArray(s.open) && s.open.length) parts.push("Open: " + s.open.join("; "));
  if (Array.isArray(s.decisions) && s.decisions.length) parts.push("Decided: " + s.decisions.join("; "));
  let line = `- [${String(m.id).slice(0, 8)}] ${m.title}${m.expected_end ? " (until " + shortDate(m.expected_end) + ")" : ""}, updated ${shortDate(m.last_touched)}: ${m.summary || ""} ${parts.join(". ")}`.trim();
  if (line.length > MAX_CHARS_EACH) line = line.slice(0, MAX_CHARS_EACH - 1) + "…";
  return line;
}

// One line per matter: the title and where things stand. Enough for the
// model to know the matter exists in any thread, without its whole record
// riding along into a conversation about something else.
function renderTitle(m) {
  let line = `- [${String(m.id).slice(0, 8)}] ${m.title}${m.expected_end ? " (until " + shortDate(m.expected_end) + ")" : ""}: ${m.summary || ""}`.trim();
  if (line.length > 200) line = line.slice(0, 199) + "…";
  return line;
}

// Which open matter the current message is about, if any, chosen by meaning:
// the message's vector against each matter's (title, summary, people), with
// a plain word-overlap fallback when no embedder is configured. The pick is
// held per user for the prompt builder, which is synchronous.
const _touched = new Map();
const _matterVec = new Map(); // matter id -> { text, vec }
// The whole record, people, facts, open items and decisions included: a
// message about "the gifted deposit form" should find the house matter even
// when the one-line summary does not mention the form.
function matterText(m) {
  return renderOne(m).replace(/^- \[[^\]]+\] /, "");
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
// Word overlap, weighted so a generic word or two ("send", "form") cannot
// pick a matter on their own: a word from the title or a person's name
// counts double, and the bar is three.
function wordOverlap(message, m) {
  const words = (t) => new Set(String(t || "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
  const s = m.state || {};
  const strong = words(`${m.title} ${(Array.isArray(s.people) ? s.people.map((p) => p.name).join(" ") : "")}`);
  const all = words(matterText(m));
  let score = 0;
  for (const w of words(message)) { if (strong.has(w)) score += 2; else if (all.has(w)) score += 1; }
  return score;
}
async function pickTouched(userId, userMessage) {
  _touched.delete(userId);
  const hit = _cache.get(userId);
  const open = hit ? hit.open.slice(0, MAX_IN_PROMPT) : [];
  if (!open.length || !userMessage || String(userMessage).trim().length < 8) return null;
  let best = null, bestScore = 0;
  try {
    const usi = require("./services/usi");
    const qv = await usi.embedText(String(userMessage), { quick: true });
    if (qv) {
      const scored = [];
      for (const m of open) {
        const text = matterText(m);
        let entry = _matterVec.get(m.id);
        if (!entry || entry.text !== text) {
          const v = await usi.embedText(text);
          if (!v) continue;
          entry = { text, vec: v };
          _matterVec.set(m.id, entry);
        }
        scored.push({ m, score: cosine(qv, entry.vec) });
      }
      scored.sort((a, b) => b.score - a.score);
      // Small embedders score everything alike (0.45 either way on the local
      // one), so an absolute floor is no test. The pick must clearly lead the
      // pack; near-equals are settled by the words, or left alone.
      if (scored.length && scored[0].score >= 0.55) {
        const top = scored[0];
        const rivals = scored.slice(1).filter((x) => top.score - x.score < 0.06);
        if (!rivals.length) { _touched.set(userId, top.m.id); return top.m.id; }
        const byWords = [top, ...rivals].map((x) => ({ m: x.m, w: wordOverlap(userMessage, x.m) })).sort((a, b) => b.w - a.w);
        if (byWords[0].w >= 1 && (byWords.length < 2 || byWords[0].w > byWords[1].w)) { _touched.set(userId, byWords[0].m.id); return byWords[0].m.id; }
      }
    }
  } catch (_) { /* fall through to words */ }
  // Words, as the fallback and as the tie-break when meaning was not sure.
  for (const m of open) {
    const score = wordOverlap(userMessage, m);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (best && bestScore >= 3) { _touched.set(userId, best.id); return best.id; }
  return null;
}

// The block for the prompt, from the warmed cache (the prompt builder is
// synchronous). Every open matter as one line; the full record only for the
// one the current message touches. Empty when nothing is ongoing.
function getMattersBlock(userId) {
  const hit = _cache.get(userId);
  const open = hit ? hit.open : [];
  if (!open.length) return "";
  const touchedId = _touched.get(userId);
  const shown = open.slice(0, MAX_IN_PROMPT);
  const lines = shown.map((m) => (m.id === touchedId ? renderOne(m) : renderTitle(m)));
  return `\nONGOING MATTERS (things with several people or steps, kept up to date across messages and channels; trust this over your memory of the thread. One line each; the full record is given for the one this message is about, and matter_get fetches any other):\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The background pass after a turn
// ---------------------------------------------------------------------------

function compact(m) {
  return { id: String(m.id).slice(0, 8), title: m.title, summary: m.summary || "", state: m.state || {}, expected_end: m.expected_end || null, last_touched: m.last_touched };
}

function trivial(userMessage) {
  const t = String(userMessage || "").trim();
  return t.length < 12 && !/\bno\b|\byes\b/i.test(t);
}

// Called after the reply has gone out. Never on the critical path.
async function updateFromTurn(userId, userMessage, replyText, recent = []) {
  try {
    const open = await warmMatters(userId);
    if (!open.length && trivial(userMessage)) return;
    const { client, model } = getInternalClient(userId);
    const history = recent.slice(-8).map((m) => ({ role: m.role, text: (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "").slice(0, 600) }));
    const today = new Date().toISOString().slice(0, 10);
    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 1500,
        messages: [{ role: "user", content: `You keep the live picture of matters in flight for a personal assistant. A matter is something with several people or several steps that unfolds over messages: a party being organised, a shipment, a booking being arranged, a negotiation, a decision waiting on other people. Casual questions, one-off requests and general chat are NOT matters.

Today is ${today}.

OPEN MATTERS (the current picture):
${JSON.stringify(open.map(compact))}

RECENT CONVERSATION (oldest first; a message opening with [Forwarded: ...] was passed on by the user from someone else, so its words are that person's, not the user's):
${JSON.stringify(history)}

LATEST USER MESSAGE:
${JSON.stringify(String(userMessage || "").slice(0, 2000))}

ASSISTANT REPLY:
${JSON.stringify(String(replyText || "").slice(0, 1500))}

Decide what this turn changes. Return ONLY JSON: {"touched":[...]} where each item is
{"id":"<8-char id of an existing matter, or \\"new\\">","title":"short name","summary":"one line on where things stand","state":{"people":[{"name":"...","position":"yes|no|maybe|unknown|<role>","said":"what they said, briefly","when":"YYYY-MM-DD or null"}],"facts":["..."],"open":["what is still unresolved"],"decisions":["..."]},"expected_end":"YYYY-MM-DD or null (the day the matter is over, e.g. the party date)","status":"open|resolved"}

Rules:
- Return the FULL updated state for a touched matter, not a delta: carry forward everything still true and change only what this turn changed. Never drop a person's earlier answer unless they changed it.
- Merge into an existing matter when the turn is about the same thing; open a new one only for a genuinely new matter with several people or steps.
- Mark status resolved when the matter has concluded (the event happened, the decision was made and acted on, the shipment arrived).
- Attribute words to who wrote them: forwarded text is the sender's, not the user's.
- Be brief; every string under 160 characters. Do not invent names, dates or positions the messages do not contain.
- If nothing in flight was touched and nothing new opened, return {"touched":[]}.` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("matters update timeout")), 40000)),
    ]);
    let text = (responseText(resp) || "").trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
    let parsed;
    try { parsed = JSON.parse(text); } catch { console.error("[matters] update did not parse"); return; }
    const touched = Array.isArray(parsed.touched) ? parsed.touched : [];
    if (!touched.length) return;
    const now = new Date().toISOString();
    for (const t of touched) {
      if (!t || !t.title) continue;
      const state = t.state && typeof t.state === "object" ? {
        people: Array.isArray(t.state.people) ? t.state.people.slice(0, 30).map((p) => ({ name: String(p.name || "").slice(0, 60), position: p.position ? String(p.position).slice(0, 40) : null, said: p.said ? String(p.said).slice(0, 160) : null, when: p.when || null })) : [],
        facts: Array.isArray(t.state.facts) ? t.state.facts.slice(0, 20).map((x) => String(x).slice(0, 160)) : [],
        open: Array.isArray(t.state.open) ? t.state.open.slice(0, 12).map((x) => String(x).slice(0, 160)) : [],
        decisions: Array.isArray(t.state.decisions) ? t.state.decisions.slice(0, 12).map((x) => String(x).slice(0, 160)) : [],
      } : {};
      const expected = t.expected_end && !isNaN(new Date(t.expected_end).getTime()) ? new Date(t.expected_end).toISOString() : null;
      const status = t.status === "resolved" ? "resolved" : "open";
      const existing = t.id && t.id !== "new" ? open.find((m) => String(m.id).startsWith(String(t.id))) : null;
      if (existing) {
        await dbUpdate(existing.id, { title: String(t.title).slice(0, 120), summary: String(t.summary || "").slice(0, 300), state, expected_end: expected, status, last_touched: now, ...(status === "resolved" ? { resolved_at: now } : {}) });
      } else {
        const { error } = await supabase.from("matters").insert({ user_id: userId, title: String(t.title).slice(0, 120), summary: String(t.summary || "").slice(0, 300), state, expected_end: expected, status, last_touched: now, ...(status === "resolved" ? { resolved_at: now } : {}) });
        if (error) console.error("[matters] insert failed:", error.message);
      }
      console.log(`[matters] ${existing ? "updated" : "opened"}: ${t.title} (${status})`);
    }
    invalidate(userId);
  } catch (e) {
    console.error("[matters] update failed:", e.message);
  }
}

async function getMatter(userId, ref) {
  const rows = await listAll(userId);
  const want = String(ref || "").toLowerCase();
  return rows.find((m) => String(m.id).startsWith(want)) || rows.find((m) => m.title.toLowerCase() === want) || rows.find((m) => m.title.toLowerCase().includes(want)) || null;
}

async function resolveMatter(userId, id) {
  await dbUpdate(id, { status: "resolved", resolved_at: new Date().toISOString() });
  invalidate(userId);
}

async function deleteMatter(userId, id) {
  const { error } = await supabase.from("matters").delete().eq("user_id", userId).eq("id", id);
  if (error) console.error("[matters] delete failed:", error.message);
  invalidate(userId);
}

module.exports = { warmMatters, getMattersBlock, pickTouched, updateFromTurn, listAll, listOpen, getMatter, resolveMatter, deleteMatter, invalidate, renderOne, renderTitle };
