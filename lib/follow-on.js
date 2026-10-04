// A long reply can go as two or three messages that follow on: the answer,
// then the detail, then a caveat or next step. The model marks each break
// with a line holding only [[next]]. Every chat sends the parts as separate
// messages a beat apart; anything that is not a chat (an email, a report, a
// PDF) shows the break as a paragraph. The web chat splits on the page, with
// the same mark (webapp/views/index.html, followOnParts).
const BREAK = /^[ \t]*\[\[next\]\][ \t]*$/m;
const GAP_MS = 900;

function parts(text) {
  const all = String(text == null ? "" : text).split(BREAK).map((p) => p.trim()).filter(Boolean);
  return all.length ? all : [String(text == null ? "" : text)];
}

function joined(text) {
  return parts(text).join("\n\n");
}

// When a long reply arrives with no breaks marked, mark them here: the
// opening answer on its own, then the rest in one or two parts split at the
// paragraph nearest the middle. Left alone when it is short, when the
// opening is not a self-contained answer (a lead-in ending in a colon, a
// heading, a list or a table), or when the model already marked breaks.
const LONG = 900;
const MARK = "\n\n[[next]]\n\n";
function isAnswer(block) {
  const b = block.trim();
  return b.length >= 40 && b.length <= 600 && !/:\s*$/.test(b) && !/^\s*(#{1,6}\s|[-*\u2022]\s|\d+[.)]\s|\|)/.test(b);
}
function withBreaks(text) {
  const t = String(text == null ? "" : text);
  if (BREAK.test(t) || t.length <= LONG) return t;
  const blocks = t.split(/\n[ \t]*\n/).filter((b) => b.trim());
  if (blocks.length < 3 || !isAnswer(blocks[0])) return t;
  const rest = blocks.slice(1);
  const restLength = rest.join("\n\n").length;
  let cut = -1;
  if (rest.length >= 2 && restLength > 700) {
    let best = Infinity, seen = 0;
    for (let k = 1; k < rest.length; k++) {
      seen += rest[k - 1].length + 2;
      if (/^\s*#{1,6}\s[^\n]*$/.test(rest[k - 1])) continue; // never end a part on a heading
      const gap = Math.abs(seen - restLength / 2);
      if (gap < best) { best = gap; cut = k; }
    }
  }
  const tail = cut > 0 ? rest.slice(0, cut).join("\n\n") + MARK + rest.slice(cut).join("\n\n") : rest.join("\n\n");
  return blocks[0] + MARK + tail;
}

// Send each part with sendOne, a beat apart. Returns what the first send
// returned, which is what callers tracking the reply's message id expect.
async function sendParts(text, sendOne, gapMs = GAP_MS) {
  const all = parts(text);
  let first;
  for (let i = 0; i < all.length; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, gapMs));
    const sent = await sendOne(all[i]);
    if (i === 0) first = sent;
  }
  return first;
}

// Telegram's client is used directly in many places, so its sendMessage is
// wrapped once where the bot is made.
function splitTelegram(bot) {
  if (!bot || bot._followOn) return bot;
  const send = bot.sendMessage.bind(bot);
  bot.sendMessage = (chatId, text, options) => typeof text === "string" && parts(text).length > 1
    ? sendParts(text, (part) => send(chatId, part, options))
    : send(chatId, text, options);
  bot._followOn = true;
  return bot;
}

module.exports = { parts, joined, withBreaks, sendParts, splitTelegram, GAP_MS };
