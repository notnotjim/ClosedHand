// lib/pulse-facts.js: what code can work out exactly for Pulse's picture, so
// the person's LLM spends itself on judgement instead of arithmetic and
// searching: which conversations are waiting on the person, whether they have
// written since, how long something has waited, how soon something starts,
// and which coming entries overlap. These are notes beside items, never
// triggers: the LLM still decides what matters. Without them the writer
// searched chat by chat to find out whether a question had been answered.

const HOUR = 3600000;

function span(ms) {
  const h = ms / HOUR;
  if (h < 1) return "under an hour";
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

const at = (r) => Date.parse(r?.data?.date || r?.received_at || "") || 0;
const threadOf = (r) => r?.data?.threadId || r?.data?.thread_id || r?.data?.conversationId || null;

// When the person last wrote, by chat and by mail thread: their own messages
// and their sent mail.
function lastWritten({ mine = [], sentMail = [] } = {}) {
  const chats = new Map(), threads = new Map();
  for (const m of mine) { const k = m?.data?.chat; if (k) chats.set(k, Math.max(chats.get(k) || 0, at(m))); }
  for (const e of sentMail) { const k = threadOf(e); if (k) threads.set(k, Math.max(threads.get(k) || 0, at(e))); }
  return { chats, threads };
}

// Whether they have written in a message's chat, or an email's thread, since
// it came, and how long it has waited if not.
function replyNote(row, written, now = Date.now()) {
  const t = at(row);
  if (row?.type === "message" && row.data?.chat) {
    return (written.chats.get(row.data.chat) || 0) > t ? "you have written in this chat since" : `nothing from you in this chat since, ${span(now - t)}`;
  }
  if (row?.type === "email" && threadOf(row)) {
    return (written.threads.get(threadOf(row)) || 0) > t ? "you have replied in this thread since" : `no reply from you in this thread, ${span(now - t)}`;
  }
  return "";
}

// The conversations waiting on the person: the latest message from someone
// else in each chat and each mail thread they have not written in since,
// newest first.
function waiting(rows, written, now = Date.now()) {
  const latest = new Map();
  for (const r of rows || []) {
    const k = r?.type === "message" ? (r.data?.chat ? "c:" + r.data.chat : null) : threadOf(r) ? "t:" + threadOf(r) : null;
    if (k && (!latest.has(k) || at(r) > at(latest.get(k)))) latest.set(k, r);
  }
  return [...latest.values()].filter((r) => !replyNote(r, written, now).startsWith("you have")).sort((a, b) => at(b) - at(a));
}

// How soon a coming entry starts. An all-day entry's date says enough.
function untilNote(row, now = Date.now()) {
  const start = String(row?.data?.start || row?.data?.starts_at || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return "";
  const t = Date.parse(start || row?.received_at || "");
  return Number.isFinite(t) && t > now ? `starts in ${span(t - now)}` : "";
}

// Pairs of coming entries, by index, whose times overlap. All-day entries
// are left out: they overlap everything that day by design.
function overlaps(rows) {
  const timed = (rows || []).map((r, i) => {
    const s = String(r?.data?.start || r?.data?.starts_at || ""), e = String(r?.data?.end || r?.data?.ends_at || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const a = Date.parse(s), b = Date.parse(e);
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? { i, a, b } : null;
  }).filter(Boolean);
  const pairs = [];
  for (let x = 0; x < timed.length; x++) for (let y = x + 1; y < timed.length; y++) {
    if (timed[x].a < timed[y].b && timed[y].a < timed[x].b) pairs.push([timed[x].i, timed[y].i]);
  }
  return pairs;
}

module.exports = { span, lastWritten, replyNote, waiting, untilNote, overlaps, threadOf };
