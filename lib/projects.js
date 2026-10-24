const { responseText } = require("./model-wire");
// lib/projects.js: the person's projects.
//
// A project is something worked on over days or weeks: a move, a wedding, a
// trip, a course. It has an emoji that marks it in every chat app, what it is
// in the person's words, the instructions Closedhand follows for it, its context
// (files, notes, links, and emails, events or messages from connected apps),
// and a live picture of where it stands. The transcript is not the
// picture: a person following a party or a negotiation keeps a small running
// record (who is involved, what each has said, what is open, what was
// decided) and acts from it, not from a memory of forty messages. A pass
// after every turn, on the fast internal model and off the reply's critical
// path, rewrites that record for the project the turn touched.
//
// A project works as Claude's projects do, with the emoji as the way in from
// any chat app. A message starting with a project's emoji, or replying to a
// message that does, runs in that project's own conversation (a thread of its
// own that is never the open one), with its description, instructions, notes,
// the text of its files and its record in front of the model; the reply
// starts with the emoji, so the chat app's own search on it is the project's
// filter. Without the emoji a message sees none of it, only each project's
// emoji and name, which keeps the rest of the context window for the message.
// The emoji alone gets where the project stands and its page.
//
// Closedhand starts a project itself when something comes up again. When the
// pass sees something with several people or steps forming, it notes it
// (stored as "offered"); the next message about it makes it a project, and
// that reply says so in one line. A note not about anything said again
// within three days is dropped. A project the person deletes leaves its name
// for a month so it is not made again at once; an archived one is never made
// again. A project with an end date is archived two days after it; a message
// with its emoji brings it back.

const { supabase } = require("./db");
const { getInternalClient } = require("./llm");
const marks = require("./project-rules");

const END_GRACE_MS = 2 * 86400000;
const OFFER_WAIT_MS = 3 * 86400000;
const DECLINED_KEPT_MS = 30 * 86400000;
const MAX_CHARS_EACH = 6000;
const NOTE_CHARS = 1500;
const COLUMNS = "id, name, emoji, about, instructions, summary, state, context, status, expected_end, last_touched, created_at, offered_at, archived_at";

// userId -> { at, rows }
const _cache = new Map();
const TTL_MS = 20 * 1000;

async function load(userId) {
  const { data, error } = await supabase.from("projects").select(COLUMNS)
    .eq("user_id", userId).order("last_touched", { ascending: false }).limit(100);
  if (error) { console.error("[projects] list failed:", error.message); return []; }
  return data || [];
}

async function dbUpdate(userId, id, patch) {
  const { error } = await supabase.from("projects").update(patch).eq("user_id", userId).eq("id", id);
  if (error) console.error("[projects] update failed:", error.message);
  return !error;
}

// End dates and notes that did not come up again are settled in code each time projects
// are loaded, so nothing depends on a pass that might not run.
async function sweep(userId, rows, now = Date.now()) {
  const keep = [];
  for (const p of rows) {
    if (p.status === "active" && p.expected_end && now > new Date(p.expected_end).getTime() + END_GRACE_MS) {
      const at = new Date(now).toISOString();
      await dbUpdate(userId, p.id, { status: "archived", archived_at: at });
      p.status = "archived"; p.archived_at = at;
    }
    // Noticed and not come up again: dropped, free to be noticed afresh.
    // A deleted project's name (declined) is kept a month, then goes too.
    if ((p.status === "offered" && now - new Date(p.last_touched || p.created_at).getTime() > OFFER_WAIT_MS)
      || (p.status === "declined" && now - new Date(p.last_touched).getTime() > DECLINED_KEPT_MS)) {
      const { error } = await supabase.from("projects").delete().eq("user_id", userId).eq("id", p.id);
      if (error) console.error("[projects] sweep delete failed:", error.message);
      continue;
    }
    keep.push(p);
  }
  return keep;
}

async function warm(userId) {
  if (!userId) return [];
  const hit = _cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows = await sweep(userId, await load(userId));
  // Each project with its goal, if it has one (lib/goals.js), and this week's
  // count for a habit.
  try {
    const tz = require("./timezone").getUserTimezone(require("./context").store);
    const goals = await require("./goals").activeGoals(userId, tz);
    for (const p of rows) p.goal = goals.find((g) => g.project_id === p.id) || null;
  } catch (e) { console.error("[projects] goals not read:", e.message); }
  _cache.set(userId, { at: Date.now(), rows });
  return rows;
}

function invalidate(userId) { _cache.delete(userId); }
const cached = (userId) => (_cache.get(userId) || { rows: [] }).rows;
const activeOf = (rows) => rows.filter((p) => p.status === "active");

// What the bot is tracking for this person: projects, and things noticed
// that may become one. The claims check reads these before anything goes out.
async function live(userId) {
  return (await warm(userId)).filter((p) => p.status === "active" || p.status === "offered");
}

function byMark(rows, mark) {
  if (!mark) return null;
  const key = marks.markKey(mark);
  const same = (p) => p.emoji && marks.markKey(p.emoji) === key;
  return rows.find((p) => p.status === "active" && same(p)) || rows.find((p) => p.status === "archived" && same(p)) || null;
}

function findIn(rows, ref) {
  const want = String(ref || "").trim();
  if (!want) return null;
  const lower = want.toLowerCase();
  return byMark(rows, marks.onlyMark(want))
    || rows.find((p) => String(p.id).startsWith(lower))
    || rows.find((p) => p.name.toLowerCase() === lower)
    || rows.find((p) => p.status === "active" && p.name.toLowerCase().includes(lower))
    || null;
}

async function find(userId, ref) {
  invalidate(userId);
  return findIn(await warm(userId), ref);
}

function shortDate(iso) {
  try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Which project a message belongs to
// ---------------------------------------------------------------------------

// userId -> { id, how: "emoji" | "reply" | "open" | "offer", files }, for the prompt
// builder, which is synchronous, and for the reply's mark.
const _turn = new Map();
// userId -> { projectId, until }: a question a project asked (a goal's
// check-in), waiting for the person's next message.
const _asked = new Map();

// A message starting with a project's emoji, or replying to one that does,
// or sent with the project open in the web chat. An archived project's emoji
// brings it back.
async function fileTurn(userId, text, { projectId = null } = {}) {
  _turn.delete(userId);
  const rows = cached(userId);
  const { quoted, rest } = marks.splitReply(text);
  let project = byMark(rows, marks.firstMark(rest)), how = "emoji";
  if (!project && quoted) { project = byMark(rows, marks.firstMark(quoted)); how = "reply"; }
  // The answer to a project's own question (a goal's check-in) is a reply to
  // it, with or without the emoji: the next message only, within a day.
  const asked = _asked.get(userId);
  _asked.delete(userId);
  if (!project && !marks.firstMark(rest) && asked && asked.until > Date.now()) {
    project = rows.find((p) => p.id === asked.projectId && p.status === "active") || null;
    how = "reply";
  }
  if (!project && projectId) {
    project = rows.find((p) => p.id === projectId && p.status === "active") || null;
    how = "open";
  }
  if (!project) return null;
  if (project.status === "archived") {
    const taken = rows.some((p) => p.status === "active" && p.emoji && marks.markKey(p.emoji) === marks.markKey(project.emoji));
    if (taken) return null;
    await dbUpdate(userId, project.id, { status: "active", archived_at: null, expected_end: null, last_touched: new Date().toISOString() });
    project.status = "active"; project.archived_at = null; project.expected_end = null;
  }
  _turn.set(userId, { id: project.id, how });
  return { project, how };
}

// The text of the project's files, served with each of its messages up to a
// budget, as Claude serves a project's knowledge; a file past it, or one that
// is not a document, is listed for the model to open when it needs it. Read
// once per file and kept, since a stored file never changes.
const FILE_CHARS = 16000;
const READABLE = /\.(pdf|docx?|odt|rtf|txt|md|csv|tsv|xlsx?|pptx?|json|html?|eml|xml|ya?ml)$/i;
const _fileText = new Map(); // attachment id -> text, or null
async function fileTexts(p) {
  const out = [];
  let budget = FILE_CHARS;
  for (const c of (p.context || []).filter((x) => x.kind === "file" && READABLE.test(x.title || ""))) {
    if (!_fileText.has(c.id)) {
      let text = null;
      try {
        const got = await require("./attachments").loadAttachment(c.id);
        if (got && got._type === "text" && got.textContent && !/^\[/.test(got.textContent)) text = String(got.textContent);
      } catch (_) { /* listed instead */ }
      _fileText.set(c.id, text);
    }
    const text = _fileText.get(c.id);
    if (text && text.length <= budget) { out.push({ id: c.id, text }); budget -= text.length; }
  }
  return out;
}

const tailKey = (list) => list.length + ":" + (list.length ? String(list[list.length - 1].content || "").slice(0, 120) : "");

// The project's own conversation, in place of the person's other one for the
// length of the turn. close() keeps what was said there and puts the other
// one back. Null when it cannot be opened: the turn then runs where it is,
// still with the project's record.
async function enterConversation(userId, p) {
  const ctx = require("./context");
  const { data } = await supabase.from("conversation_threads").select("id, messages").eq("user_id", userId).eq("project_id", p.id).limit(1);
  let thread = data && data[0];
  if (!thread) {
    const made = await supabase.from("conversation_threads")
      .insert({ user_id: userId, project_id: p.id, is_active: false, title: `${p.emoji} ${p.name}`, messages: [], platform: ctx.activePlatform || "web" })
      .select("id, messages").single();
    if (made.error || !made.data) { console.error("[projects] conversation not opened:", made.error && made.error.message); return null; }
    thread = made.data;
  }
  const store = ctx.activeUserStore;
  const other = { messages: ctx.store.conversations[userId] || [], threadId: ctx.activeThreadId, count: store && store._savedCount, tail: store && store._savedTailKey };
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const at = messages.length;
  const put = (list, threadId, count, tail) => {
    ctx.store.conversations[userId] = list;
    ctx.activeThreadId = threadId;
    if (store) { store.conversations = list; store.activeThreadId = threadId; store._savedCount = count; store._savedTailKey = tail; }
  };
  put(messages, thread.id, at, tailKey(messages));
  return {
    threadId: thread.id,
    async close() {
      const kept = ctx.store.conversations[userId] || [];
      const now = new Date().toISOString();
      for (let i = at; i < kept.length; i++) if (kept[i] && typeof kept[i] === "object" && !kept[i].ts) kept[i].ts = now;
      const { error } = await supabase.from("conversation_threads").update({ messages: kept, updated_at: now }).eq("id", thread.id).eq("user_id", userId);
      if (error) console.error("[projects] conversation not kept:", error.message);
      put(other.messages, other.threadId, other.count, other.tail);
      _turn.delete(userId);
    },
  };
}

// Something Closedhand said in a project outside a turn (a goal's check-in):
// kept in the project's conversation, and when it asks something, the next
// message answers it there.
async function said(userId, p, text, { asks = false } = {}) {
  const now = new Date().toISOString();
  const { data } = await supabase.from("conversation_threads").select("id, messages").eq("user_id", userId).eq("project_id", p.id).limit(1);
  const thread = data && data[0];
  const line = { role: "assistant", content: text, ts: now };
  const done = thread
    ? await supabase.from("conversation_threads").update({ messages: [...(thread.messages || []), line], updated_at: now }).eq("id", thread.id).eq("user_id", userId)
    : await supabase.from("conversation_threads").insert({ user_id: userId, project_id: p.id, is_active: false, messages: [line], title: `${p.emoji} ${p.name}` });
  if (done.error) console.error("[projects] not kept in its conversation:", done.error.message);
  if (asks) _asked.set(userId, { projectId: p.id, until: Date.now() + 24 * 3600 * 1000 });
}

// The start of every message's turn (lib/engine.js queuedAsk): which project
// it belongs to, if any, and that project's conversation and files opened.
async function openTurn(userId, text, opts = {}) {
  await warm(userId);
  const filed = await fileTurn(userId, text, opts);
  if (!filed) return null;
  _turn.get(userId).files = await fileTexts(filed.project).catch(() => []);
  return enterConversation(userId, filed.project);
}

// The emoji alone: where the project stands, in two lines, and its page.
function onlyMarkProject(userId, text) {
  const mark = marks.onlyMark(text);
  const p = mark && byMark(cached(userId), mark);
  return p && p.status === "active" ? p : null;
}

function statusText(p, link, platform) {
  const s = p.state || {};
  const open = Array.isArray(s.open) ? s.open.filter(Boolean) : [];
  const first = `${p.emoji} ${p.name}: ${p.summary || "nothing has happened in it yet."}`;
  const second = open.length ? `Still open: ${open.slice(0, 2).join("; ")}.` : p.expected_end ? `Until ${shortDate(p.expected_end)}.` : "";
  const page = platform === "web" ? `[Open its page](${link})` : `Its page: ${link}`;
  return [first, second, page].filter(Boolean).join("\n");
}

// The record the model works from: the person's own words first.
function renderFull(p, files = []) {
  const s = p.state || {};
  const parts = [];
  if (p.about) parts.push(`What it is, in their words: ${p.about}`);
  if (p.instructions) parts.push(`Their instructions for it (follow these for anything in this project):\n${p.instructions.split(/\n+/).map((l) => "- " + l).join("\n")}`);
  if (p.summary) parts.push(`Where it stands: ${p.summary}`);
  if (p.goal) parts.push(`Its goal (record progress with goal_progress, change it with goal_set):\n${require("./goals").promptLines([p.goal]).join("\n")}`);
  if (Array.isArray(s.people) && s.people.length) {
    parts.push("People: " + s.people.map((x) => `${x.name}${x.position ? " (" + x.position + ")" : ""}${x.said ? ": " + x.said : ""}${x.when ? " [" + shortDate(x.when) + "]" : ""}`).join("; "));
  }
  if (Array.isArray(s.facts) && s.facts.length) parts.push("Facts: " + s.facts.join("; "));
  if (Array.isArray(s.open) && s.open.length) parts.push("Open: " + s.open.join("; "));
  if (Array.isArray(s.decisions) && s.decisions.length) parts.push("Decided: " + s.decisions.join("; "));
  if (p.expected_end) parts.push(`Until: ${shortDate(p.expected_end)}`);
  if (Array.isArray(p.context) && p.context.length) parts.push("Context they gave it (open a file with view_attachment, an app item with read_cached_record):\n" + p.context.map(contextLine).join("\n"));
  let text = parts.join("\n");
  if (text.length > MAX_CHARS_EACH) text = text.slice(0, MAX_CHARS_EACH - 1) + "…";
  // The files' own words, after the record and outside its limit.
  for (const f of files) {
    const c = (p.context || []).find((x) => x.id === f.id);
    text += `\n\nFILE ${JSON.stringify(c ? c.title : f.id)} (${f.id}), its text:\n${f.text}`;
  }
  return text;
}

function contextLine(c) {
  if (c.kind === "file") return `- File: ${c.title} (${c.id})`;
  if (c.kind === "note") {
    const text = c.text.length > NOTE_CHARS ? c.text.slice(0, NOTE_CHARS - 1) + "…" : c.text;
    return c.text.startsWith(c.title) ? `- Note: ${text}` : `- Note "${c.title}": ${text}`;
  }
  if (c.kind === "link") return `- Link: ${c.title ? c.title + " " : ""}${c.url}`;
  return `- ${c.kind.charAt(0).toUpperCase() + c.kind.slice(1)}${c.from ? " from " + c.from : ""}: "${c.title}"${c.at ? ", " + shortDate(c.at) : ""} (source ${c.source}, id ${c.ref})`;
}

// The whole record, so a message about "the parking permit form" finds the
// house move even when its summary does not mention the form.
const projectText = (p) => `${p.name}. ${renderFull(p)}`;
const _vec = new Map(); // project id -> { text, vec }
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
// Word overlap, weighted so a generic word or two ("send", "form") cannot
// pick a project on their own: a word from the name or a person's name
// counts double, and the bar is three.
function wordOverlap(message, p) {
  const words = (t) => new Set(String(t || "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
  const s = p.state || {};
  const strong = words(`${p.name} ${(Array.isArray(s.people) ? s.people.map((x) => x.name).join(" ") : "")}`);
  const all = words(projectText(p));
  let score = 0;
  for (const w of words(message)) { if (strong.has(w)) score += 2; else if (all.has(w)) score += 1; }
  return score;
}

// A message with no emoji never sees a project. It can still be the next
// message about something Closedhand noticed and has not offered yet: that
// one is found by meaning (the message's vector against each offer's
// record), with word overlap as the fallback and the tie-break.
async function pickTouched(userId, userMessage, { messageVector = null } = {}) {
  const filed = _turn.get(userId);
  if (filed && filed.how !== "offer") return filed.id;
  _turn.delete(userId);
  const candidates = cached(userId).filter((p) => p.status === "offered");
  if (!candidates.length || !userMessage || String(userMessage).trim().length < 8) return null;
  const pick = (p) => { _turn.set(userId, { id: p.id, how: "offer" }); return p.id; };
  try {
    const usi = require("./services/usi");
    // Recall has usually embedded this same message already; reuse it.
    const qv = await (messageVector || usi.embedText(String(userMessage), { quick: true }));
    if (qv) {
      const stale = candidates.filter((p) => _vec.get(p.id)?.text !== projectText(p));
      if (stale.length) {
        const vecs = await usi.embedBatch(stale.map(projectText), { urgent: true });
        stale.forEach((p, i) => { if (vecs[i]) _vec.set(p.id, { text: projectText(p), vec: vecs[i] }); });
      }
      const scored = candidates.filter((p) => _vec.get(p.id)).map((p) => ({ p, score: cosine(qv, _vec.get(p.id).vec) })).sort((a, b) => b.score - a.score);
      // Small embedders score everything alike, so an absolute floor is no
      // test. The pick must clearly lead; near-equals are settled by words.
      if (scored.length && scored[0].score >= 0.55) {
        const top = scored[0];
        const rivals = scored.slice(1).filter((x) => top.score - x.score < 0.06);
        if (!rivals.length) return pick(top.p);
        const byWords = [top, ...rivals].map((x) => ({ p: x.p, w: wordOverlap(userMessage, x.p) })).sort((a, b) => b.w - a.w);
        if (byWords[0].w >= 1 && (byWords.length < 2 || byWords[0].w > byWords[1].w)) return pick(byWords[0].p);
      }
    }
  } catch (_) { /* fall through to words */ }
  let best = null, bestScore = 0;
  for (const p of candidates) {
    const score = wordOverlap(userMessage, p);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best && bestScore >= 3 ? pick(best) : null;
}

// The line a reply ends with when its message made a project.
function madeText(p) {
  return `\nPROJECT JUST MADE: This message is about something that has come up before: ${p.name} (${p.summary || "several people or steps"}). Closedhand has just made it a project, ${p.emoji} ${p.name}. Answer the message as usual, then end with one short line saying so, for example: "I've made this a project: ${p.emoji} ${p.name}. Start a message with ${p.emoji} to pick it up from any chat, or archive it under Projects on the dashboard." Say it this once.\n`;
}

// An emoji for a project Closedhand makes: the one noticed with it, unless
// another project has it, then the first free one of a few plain marks.
const SPARE_MARKS = ["🗂️", "📌", "🧭", "📎", "🔖", "🧩", "🎯", "🪴"];
function freeMark(rows, wanted, id) {
  return [marks.onlyMark(wanted), ...SPARE_MARKS].find((m) => m && !marks.takenBy(rows, m, id)) || null;
}

// The block for this message's instructions. A message in a project gets
// that project whole; any other gets each project's emoji and name, so
// Closedhand knows what there is without carrying any of it. Empty when there
// are none.
function getProjectsBlock(userId) {
  const rows = cached(userId);
  const turn = _turn.get(userId);
  const p = turn && rows.find((r) => r.id === turn.id);
  if (p && p.status === "active" && turn.how !== "offer") {
    const why = turn.how === "emoji" ? "starts with its emoji" : turn.how === "reply" ? "replies to a message from it" : "was sent with the project open";
    return `\nTHIS MESSAGE IS IN THE PROJECT ${p.emoji} ${p.name} (it ${why}). The conversation above is this project's own. Work from the project's record, and follow its instructions for anything in it:\n${renderFull(p, turn.files || [])}\n`;
  }
  const names = activeOf(rows).map((r) => `${r.emoji} ${r.name}${r.goal && r.goal.status === "active" ? ` (goal: ${r.goal.title})` : ""}`);
  let out = names.length ? `\nTHEIR PROJECTS (each has a conversation of its own, reached by starting a message with its emoji; this message is in none of them): ${names.join(", ")}\n` : "";
  if (p && p.status === "offered") {
    // It has come up again: made a project now, and said once. The record
    // in memory changes at once, so it is not made twice.
    const same = activeOf(rows).find((r) => r.name.toLowerCase() === String(p.name).toLowerCase());
    const mark = !same && freeMark(rows, p.emoji, p.id);
    if (mark) {
      Object.assign(p, { status: "active", emoji: mark, last_touched: new Date().toISOString() });
      dbUpdate(userId, p.id, { status: "active", emoji: mark, last_touched: p.last_touched }).catch(() => {});
      console.log(`[projects] made: ${p.name}`);
      out += madeText(p);
    }
  }
  return out;
}

// A reply in a project starts with its emoji, once.
function markReply(userId, text) {
  const turn = _turn.get(userId);
  const p = turn && turn.how !== "offer" && cached(userId).find((r) => r.id === turn.id);
  if (!p || !p.emoji) return { text, projectId: null };
  const body = String(text || "").trimStart();
  return { text: marks.markKey(marks.firstMark(body)) === marks.markKey(p.emoji) ? body : `${p.emoji} ${body}`, projectId: p.id };
}

function turnOf(userId) { return _turn.get(userId) || null; }

// Whether the project tools ride with every message (lib/engine.js isCoreNow).
function hasProjects(userId) { return activeOf(cached(userId)).length > 0; }

// ---------------------------------------------------------------------------
// Starting and changing projects (chat tools and the dashboard)
// ---------------------------------------------------------------------------

const cleanText = (x, n) => require("./plain-dashes").noEmDashes(String(x || "")).trim().slice(0, n);
// Instructions, one a line, as written.
const lines = (x) => String(x || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).join("\n").slice(0, 4000);

// `context` takes notes and links as typed (project-rules.js typed).
async function create(userId, { name, emoji, about = "", instructions = "", context = [] }) {
  const rows = await warm(userId);
  const mark = marks.onlyMark(emoji);
  const title = cleanText(name, 80);
  if (!title) return { error: "A project needs a name." };
  if (!mark) return { error: "A project needs one emoji of its own." };
  const clash = marks.takenBy(rows, mark);
  if (clash) return { error: `${mark} already marks ${clash.name}. Choose another emoji.` };
  const now = new Date().toISOString();
  // Something already noticed, or a name deleted lately, becomes the project
  // asked for, keeping what was noticed, rather than a second one beside it.
  const offered = rows.find((p) => (p.status === "offered" || p.status === "declined") && String(p.name).toLowerCase() === title.toLowerCase()) || null;
  const fields = { name: title, emoji: mark, about: cleanText(about, 600), instructions: lines(instructions), status: "active", last_touched: now };
  let project;
  if (offered) {
    const { data, error } = await supabase.from("projects").update({ ...fields, context: marks.withContext(offered.context, marks.typed(context)) })
      .eq("user_id", userId).eq("id", offered.id).select(COLUMNS).single();
    if (error) return { error: "Could not save the project." };
    project = data;
  } else {
    const { data, error } = await supabase.from("projects").insert({ user_id: userId, ...fields, context: marks.typed(context) }).select(COLUMNS).single();
    if (error) return { error: "Could not save the project." };
    project = data;
  }
  invalidate(userId);
  console.log(`[projects] started: ${project.name}`);
  return { project };
}

// Everything a person can change. `add_instruction` adds a line to its
// instructions; context items (made by project-rules.js) are added to it, or
// taken out by id.
async function update(userId, id, patch = {}) {
  const rows = await warm(userId);
  const p = rows.find((r) => r.id === id);
  if (!p) return { error: "No such project." };
  const set = {};
  if (patch.name !== undefined) { set.name = cleanText(patch.name, 80); if (!set.name) return { error: "A project needs a name." }; }
  if (patch.emoji !== undefined) {
    const mark = marks.onlyMark(patch.emoji);
    if (!mark) return { error: "A project needs one emoji of its own." };
    const clash = marks.takenBy(rows, mark, p.id);
    if (clash) return { error: `${mark} already marks ${clash.name}. Choose another emoji.` };
    set.emoji = mark;
  }
  if (patch.about !== undefined) set.about = cleanText(patch.about, 600);
  if (patch.instructions !== undefined) set.instructions = lines(patch.instructions);
  if (patch.add_instruction) set.instructions = lines([set.instructions ?? p.instructions, patch.add_instruction].filter(Boolean).join("\n"));
  if (patch.add_context) set.context = marks.withContext(p.context, patch.add_context.filter(Boolean));
  if (patch.remove_context) set.context = (set.context || p.context || []).filter((c) => c.id !== patch.remove_context);
  if (patch.archived === true) Object.assign(set, { status: "archived", archived_at: new Date().toISOString() });
  if (patch.archived === false) {
    if (marks.takenBy(rows, set.emoji || p.emoji, p.id)) return { error: `${set.emoji || p.emoji} now marks another project. Give this one another emoji first.` };
    Object.assign(set, { status: "active", archived_at: null, expected_end: null });
  }
  if (!Object.keys(set).length) return { project: p };
  set.last_touched = new Date().toISOString();
  const { data, error } = await supabase.from("projects").update(set).eq("user_id", userId).eq("id", p.id).select(COLUMNS).single();
  if (error) return { error: "Could not save the project." };
  invalidate(userId);
  return { project: data };
}

// Two projects that turned out to be one: the second goes.
async function merge(userId, intoId, fromId) {
  if (intoId === fromId) return { error: "Choose two different projects." };
  const rows = await warm(userId);
  const into = rows.find((r) => r.id === intoId), from = rows.find((r) => r.id === fromId);
  if (!into || !from) return { error: "No such project." };
  const set = { ...marks.merged(into, from), last_touched: new Date().toISOString() };
  const { data, error } = await supabase.from("projects").update(set).eq("user_id", userId).eq("id", into.id).select(COLUMNS).single();
  if (error) return { error: "Could not merge them." };
  try { await marks.mergeConversations(supabase, userId, into.id, from.id); } catch (e) { return { error: e.message }; }
  const gone = await supabase.from("projects").delete().eq("user_id", userId).eq("id", from.id);
  if (gone.error) console.error("[projects] merge delete failed:", gone.error.message);
  invalidate(userId);
  return { project: data };
}

async function remove(userId, id) {
  const { error } = await marks.deleteProject(supabase, userId, id);
  if (error) console.error("[projects] delete failed:", error.message);
  invalidate(userId);
  return !error;
}

// A file sent with a project's emoji joins the project's context.
async function addFiles(userId, id, files) {
  const items = (files || []).map((f) => marks.file(f.id, f.name)).filter(Boolean);
  if (!id || !items.length) return;
  const r = await update(userId, id, { add_context: items });
  if (r.error) console.error("[projects] file not added:", r.error);
}

// ---------------------------------------------------------------------------
// The background pass after a turn
// ---------------------------------------------------------------------------

function compact(p) {
  return { id: String(p.id).slice(0, 8), name: p.name, ...(p.status === "offered" ? { offered: true } : {}), summary: p.summary || "", state: p.state || {}, expected_end: p.expected_end || null, last_touched: p.last_touched };
}

function trivial(userMessage) {
  const t = String(userMessage || "").trim();
  return t.length < 12 && !/\bno\b|\byes\b/i.test(t);
}

function cleanState(st) {
  if (!st || typeof st !== "object") return {};
  return {
    people: Array.isArray(st.people) ? st.people.slice(0, 30).map((x) => ({ name: cleanText(x.name, 60), position: x.position ? cleanText(x.position, 40) : null, said: x.said ? cleanText(x.said, 160) : null, when: x.when || null })) : [],
    facts: Array.isArray(st.facts) ? st.facts.slice(0, 20).map((x) => cleanText(x, 160)) : [],
    open: Array.isArray(st.open) ? st.open.slice(0, 12).map((x) => cleanText(x, 160)) : [],
    decisions: Array.isArray(st.decisions) ? st.decisions.slice(0, 12).map((x) => cleanText(x, 160)) : [],
  };
}

// Called after the reply has gone out, with the project the turn was in when
// it was in one. A turn in a project updates that project only; any other
// turn can only add to what Closedhand has noticed and not offered yet, or
// notice something new. Never on the critical path.
async function updateFromTurn(userId, userMessage, replyText, recent = [], { filedId = null } = {}) {
  try {
    invalidate(userId);
    const rows = await warm(userId);
    const filed = filedId && rows.find((p) => p.id === filedId && p.status === "active");
    const open = filed ? [filed] : rows.filter((p) => p.status === "offered");
    const declined = rows.filter((p) => p.status === "declined").map((p) => p.name);
    const theirs = rows.filter((p) => p.status === "active" || p.status === "archived").map((p) => p.name);
    if (!filed && !open.length && trivial(userMessage)) return;
    const { client, model } = getInternalClient(userId);
    const history = recent.slice(-8).map((m) => ({ role: m.role, text: (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "").slice(0, 600) }));
    let timer;
    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 1500,
        messages: [{ role: "user", content: `You keep the live picture of the projects a personal assistant follows for its user. A project is something with several people or several steps that unfolds over days or weeks: a party being organised, a move, a booking being arranged, a negotiation, a piece of work for a client or employer, a decision waiting on other people. Casual questions, one-off requests and general chat are NOT projects.

${require("./time-context").currentTimeContext(require("./context").activeUserStore).text}

${filed ? `THE PROJECT THIS CONVERSATION IS IN (the current picture):
${JSON.stringify(compact(filed))}
` : `NOTICED, NOT PROJECTS YET (the current picture):
${JSON.stringify(open.map(compact))}
${theirs.length ? `\nTHEIR PROJECTS (each kept in a conversation of its own; never return these, or a new one for the same thing): ${JSON.stringify(theirs)}\n` : ""}${declined.length ? `\nNOT TO NOTICE AGAIN (the user deleted these projects): ${JSON.stringify(declined)}\n` : ""}`}
RECENT CONVERSATION (oldest first; a message opening with [Forwarded: ...] was passed on by the user from someone else, so its words are that person's, not the user's):
${JSON.stringify(history)}

LATEST USER MESSAGE:
${JSON.stringify(String(userMessage || "").slice(0, 2000))}

ASSISTANT REPLY:
${JSON.stringify(String(replyText || "").slice(0, 1500))}

Decide what this turn changes. Return ONLY JSON: {"touched":[...]} where each item is
{"id":"<8-char id of a project above, or \\"new\\">","name":"short name","emoji":"one emoji that suits it (new only)","summary":"one line on where things stand","state":{"people":[{"name":"...","position":"yes|no|maybe|unknown|<role>","said":"what they said, briefly","when":"YYYY-MM-DD or null"}],"facts":["..."],"open":["what is still unresolved"],"decisions":["..."]},"expected_end":"YYYY-MM-DD or null (the day it is over, e.g. the party date)"}

Rules:
- Return the FULL updated state for a touched project, not a delta: carry forward everything still true and change only what this turn changed. Never drop a person's earlier answer unless they changed it.
${filed ? `- Return only the project above, and only if this turn changed its picture. Never "new".` : `- Use a noticed one when the turn is about the same thing. Use "new" only for a genuinely new thing with several people or steps that is none of the above and not in the list not to notice again.`}
- A personal goal or habit the user is setting for themselves (getting fit, learning a language) is not a new one: those are kept as goals.
- Attribute words to who wrote them: forwarded text is the sender's, not the user's.
- Be brief; every string under 160 characters. Do not invent names, dates or positions the messages do not contain.
- If nothing was touched and nothing new formed, return {"touched":[]}.` }],
      }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("projects update timeout")), 40000); }),
    ]).finally(() => clearTimeout(timer));
    const text = (responseText(resp) || "").trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
    let parsed;
    try { parsed = JSON.parse(text); } catch { console.error("[projects] update did not parse"); return; }
    const touched = Array.isArray(parsed.touched) ? parsed.touched : [];
    if (!touched.length) return;
    const now = new Date().toISOString();
    let offeredOne = false;
    for (const t of touched) {
      if (!t || !t.name) continue;
      const fields = {
        summary: cleanText(t.summary, 300),
        state: cleanState(t.state),
        expected_end: t.expected_end && !isNaN(new Date(t.expected_end).getTime()) ? new Date(t.expected_end).toISOString() : null,
        last_touched: now,
      };
      const existing = t.id && t.id !== "new" ? open.find((p) => String(p.id).startsWith(String(t.id))) : null;
      if (filed && !existing) continue;
      if (existing) {
        // The person's own name for a project stays; a note's may be refined.
        await dbUpdate(userId, existing.id, existing.status === "offered" ? { ...fields, name: cleanText(t.name, 80) } : fields);
        continue;
      }
      // One new note a turn, never for a project the person deleted.
      const name = cleanText(t.name, 80);
      if (offeredOne || !name || [...open.map((p) => p.name), ...theirs, ...declined].some((n) => n.toLowerCase() === name.toLowerCase())) continue;
      offeredOne = true;
      const { error } = await supabase.from("projects").insert({ user_id: userId, name, emoji: marks.onlyMark(t.emoji), status: "offered", ...fields });
      if (error) console.error("[projects] note not kept:", error.message);
      else console.log(`[projects] noticed: ${name}`);
    }
    invalidate(userId);
  } catch (e) {
    console.error("[projects] update failed:", e.message);
  }
}

module.exports = {
  warm, live, invalidate, find, fileTurn, openTurn, said, fileTexts, turnOf, hasProjects, onlyMarkProject, statusText, pickTouched, getProjectsBlock, markReply,
  create, update, merge, remove, addFiles, updateFromTurn, renderFull, _sweep: sweep, _cache,
};
