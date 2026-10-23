// lib/fold-in.js: a message sent while Closedhand is still working on the
// person's last one joins that work, as frontier chat apps do, instead of
// waiting to be answered on its own. The reply that comes covers both.
//
// Each platform says what a new message is before it joins the queue
// (lib/context.js queueUserMessage), so a reply already running can take it
// in at its next step (lib/engine.js). Its own turn, when it comes, finds it
// answered and says nothing. Only plain text from the same chat is taken in:
// a file or a voice note is read when its turn comes, a command or a
// project's emoji means something of its own, and while a question waits
// for a yes or no the message may be the answer. Those wait their turn, and
// the reply running steps aside for them as before.
//
// /bug, and the yes or no to sending it, do not wait at all: a report must go
// through when the thing being reported is the reply still running, and it
// touches nothing that reply saves (lib/bug-reports.js).

const waiting = new Map(); // userId -> [{ text, platform, chatId, folded }]

const COMMAND = /^\s*(\/|start\s*$|voice\s+replies?\s+(on|off)\s*$)/i;

function goesStraight(userId, text) {
  if (typeof text !== "string") return false;
  const bugs = require("./bug-reports");
  return bugs.isBugReport(text) || bugs.answersBugQuestion(userId, text);
}

// A new message, before it waits for its turn: kept where a reply already
// running can take it in. Returns its entry, or null when it waits as before.
function arrive(userId, { text, platform, chatId } = {}) {
  if (typeof text !== "string" || !text.trim() || !platform || chatId == null) return null;
  if (COMMAND.test(text)) return null;
  const ctx = require("./context");
  if (ctx.pendingConfirmations?.[userId]) return null;
  const marks = require("./project-rules");
  if (marks.firstMark(marks.splitReply(text).rest)) return null;
  const entry = { text: text.trim(), platform, chatId: String(chatId), folded: false };
  if (!waiting.has(userId)) waiting.set(userId, []);
  waiting.get(userId).push(entry);
  return entry;
}

// Its turn has come: from here it is answered on its own, or not at all.
function leave(userId, entry) {
  const list = waiting.get(userId);
  if (!entry || !list) return;
  const at = list.indexOf(entry);
  if (at >= 0) list.splice(at, 1);
  if (!list.length) waiting.delete(userId);
}

// For the reply running in this chat: the messages sent to it since, marked
// as taken in.
function take(userId, platform, chatId) {
  const taken = [];
  for (const entry of waiting.get(userId) || []) {
    if (entry.folded || entry.platform !== platform || entry.chatId !== String(chatId)) continue;
    entry.folded = true;
    taken.push(entry.text);
  }
  return taken;
}

// Messages already taken in but whose turn has not come yet: the reply that
// took them must not step aside for them.
function takenWaiting(userId) {
  return (waiting.get(userId) || []).filter((e) => e.folded).length;
}

module.exports = { goesStraight, arrive, leave, take, takenWaiting };
