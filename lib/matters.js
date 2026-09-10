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

// The block for the prompt, from the warmed cache (the prompt builder is
// synchronous). Empty when there is nothing in flight.
function getMattersBlock(userId) {
  const hit = _cache.get(userId);
  const open = hit ? hit.open : [];
  if (!open.length) return "";
  const lines = open.slice(0, MAX_IN_PROMPT).map(renderOne);
  return `\nMATTERS IN FLIGHT (the live picture of things with several people or steps, kept up to date across messages and channels; trust it over your memory of the thread, and act from it; matter_get gives the full record):\n${lines.join("\n")}\n`;
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
    let text = (resp.content && resp.content[0] && resp.content[0].text || "").trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
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

module.exports = { warmMatters, getMattersBlock, updateFromTurn, listAll, listOpen, getMatter, resolveMatter, deleteMatter, invalidate, renderOne };
