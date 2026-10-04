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

module.exports = { parts, joined, sendParts, splitTelegram, GAP_MS };
