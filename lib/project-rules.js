// What holds for a project however it is changed, from a chat or from the
// dashboard (lib/projects.js, webapp/projects.js). Vendored byte-identical in
// lib/ and webapp/ (scripts/check-vendored-identical.js).
//
// A project's mark is one emoji, and it marks the project in every chat app:
// a message starting with it, or replying to a message that does, belongs to
// that project. Chat apps and keyboards send the same emoji in several
// spellings (with or without the colour selector, with a skin tone), so marks
// are compared by a key with those taken out.

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function isMark(g) {
  const s = String(g || "");
  return /\p{Extended_Pictographic}/u.test(s) || /^\p{Regional_Indicator}{2}$/u.test(s) || /⃣/.test(s);
}

// The same emoji however it was typed.
function markKey(g) {
  return String(g || "").replace(/[︎️\u{1F3FB}-\u{1F3FF}]/gu, "");
}

function firstGrapheme(text) {
  for (const { segment } of segmenter.segment(String(text || "").trimStart())) return segment;
  return "";
}

// The emoji a message starts with, or null.
function firstMark(text) {
  const g = firstGrapheme(text);
  return isMark(g) ? g : null;
}

// One emoji and nothing else: a message that asks how a project stands, or
// what a mark typed into a form becomes.
function onlyMark(text) {
  const t = String(text || "").trim();
  const g = firstGrapheme(t);
  return isMark(g) && g === t ? g : null;
}

// Chat apps hand a reply over with the message it answers in front
// ("[Replying to: "..."]", "[replying to Closedhand's message: "..."]").
const REPLY = /^\s*\[replying to[^"\]]*"([\s\S]*?)"\]\s*/i;
function splitReply(text) {
  const s = String(text || "");
  const m = s.match(REPLY);
  return m ? { quoted: m[1], rest: s.slice(m[0].length) } : { quoted: null, rest: s };
}

// One emoji marks one project at a time; an archived one keeps its emoji
// until another project takes it.
function takenBy(rows, emoji, exceptId = null) {
  const key = markKey(emoji);
  return rows.find((p) => p.status === "active" && p.id !== exceptId && p.emoji && markKey(p.emoji) === key) || null;
}

// A project's context: what the person gave it to work from. Files sent or
// added (attachment ids), notes in their own words, links, and items from
// their connected apps (an email, an event, a message), kept by id so the
// original is read when needed. Notes and links are taken as typed; a file or
// an app item is only ever made here from a stored record, never from what a
// form sent.
const MAX_CONTEXT = 100;
const clip = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
const newId = (kind) => `${kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function note(title, text) {
  const body = String(text || "").trim().slice(0, 20000);
  if (!body) return null;
  return { kind: "note", id: newId("note"), title: clip(title, 120) || clip(body.split("\n")[0], 80), text: body };
}

function link(url, title = "") {
  const u = String(url || "").trim();
  if (!/^https?:\/\/\S+$/i.test(u)) return null;
  return { kind: "link", id: newId("link"), title: clip(title, 120), url: u.slice(0, 600) };
}

function file(id, name) {
  if (!/^att_[\w-]{1,80}$/.test(String(id || ""))) return null;
  return { kind: "file", id: String(id), title: clip(name, 160) || "file" };
}

// A synced record (a data_cache row) as a context item.
function synced(row) {
  if (!row || !row.source || !row.external_id) return null;
  const d = row.data || {};
  const kind = String(row.type || "item");
  const title = kind === "email" ? d.subject || "(no subject)"
    : kind === "event" ? d.summary || "Event"
    : kind === "message" ? `${d.chat_name || "Chat"}: ${d.text || ""}`
    : d.title || d.subject || d.summary || d.name || "Item";
  // A sender as people say it: the name, without the address when there is one.
  const from = String((kind === "email" ? d.from : kind === "message" ? d.sender : "") || "").replace(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/, "$1");
  const at = [kind === "event" ? d.start : null, d.date, row.received_at].find((v) => v && !isNaN(new Date(v).getTime()));
  const web = /^https:\/\/\S+$/.test(String(d.webLink || "")) ? d.webLink : null;
  return { kind, id: `${row.source}:${row.external_id}`, source: row.source, ref: String(row.external_id), title: clip(title, 160), ...(from ? { from: clip(from, 120) } : {}), ...(at ? { at: new Date(at).toISOString() } : {}), ...(web ? { web } : {}) };
}

// Notes and links as a form or a chat gave them: [{ kind: "note", title,
// text }, { kind: "link", url, title }] or bare addresses.
function typed(list) {
  return (Array.isArray(list) ? list : []).map((x) => {
    if (typeof x === "string") return link(x);
    if (x && x.kind === "note") return note(x.title, x.text);
    if (x && (x.kind === "link" || x.url)) return link(x.url, x.title);
    return null;
  }).filter(Boolean);
}

function withContext(have, add) {
  const out = [...(have || [])];
  for (const item of add || []) {
    if (!item || out.some((x) => x.id === item.id || (item.url && x.url === item.url))) continue;
    out.push(item);
  }
  return out.slice(-MAX_CONTEXT);
}

// Two projects that turned out to be one: the second's record and context
// join the first.
function merged(into, from) {
  const a = into.state || {}, b = from.state || {};
  const list = (k) => [...new Set([...(a[k] || []), ...(b[k] || [])])];
  const people = [...(a.people || [])];
  for (const x of b.people || []) if (!people.some((y) => y.name === x.name)) people.push(x);
  return {
    about: into.about || from.about || "",
    instructions: [into.instructions, from.instructions].filter(Boolean).join("\n").slice(0, 4000),
    state: { people, facts: list("facts"), open: list("open"), decisions: list("decisions") },
    context: withContext(into.context, from.context),
  };
}

// Their conversations become one: the merged one's first, then the kept
// one's, so the latest exchange stays last. Done before the merged project
// goes, since its conversation goes with it.
async function mergeConversations(db, userId, intoId, fromId) {
  const { data, error } = await db.from("conversation_threads").select("id, project_id, messages").eq("user_id", userId).in("project_id", [intoId, fromId]);
  if (error) throw new Error("Could not merge their conversations.");
  const into = (data || []).find((t) => t.project_id === intoId), from = (data || []).find((t) => t.project_id === fromId);
  if (!from) return;
  const done = into
    ? await db.from("conversation_threads").update({ messages: [...(from.messages || []), ...(into.messages || [])] }).eq("id", into.id).eq("user_id", userId)
    : await db.from("conversation_threads").update({ project_id: intoId }).eq("id", from.id).eq("user_id", userId);
  if (done.error) throw new Error("Could not merge their conversations.");
}

module.exports = { isMark, markKey, firstMark, onlyMark, splitReply, takenBy, note, link, file, synced, typed, withContext, merged, mergeConversations, MAX_CONTEXT };
