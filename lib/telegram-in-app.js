// Pages ClosedHand sends on Telegram open inside Telegram, signed in there by
// Telegram's own proof of who opened them (webapp: /tg/open and
// /api/telegram/session), so no password is asked inside Telegram.
//
// Wrapped once where the bot is made, so every send gets it:
// - any in-app button pointing at this ClosedHand goes through /tg/open;
// - a "Full report: <address>" line becomes an "Open report" button.
const { dashboardBase } = require("./config");

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function throughSignIn(base, url) {
  if (!base || typeof url !== "string" || !url.startsWith(base + "/")) return url;
  const path = url.slice(base.length);
  if (path.startsWith("/tg/open")) return url;
  return `${base}/tg/open?to=${encodeURIComponent(path)}`;
}

function rewriteButtons(base, options) {
  const rows = options?.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return options;
  const inline_keyboard = rows.map((row) => row.map((button) => button?.web_app?.url
    ? { ...button, web_app: { ...button.web_app, url: throughSignIn(base, button.web_app.url) } }
    : button));
  return { ...options, reply_markup: { ...options.reply_markup, inline_keyboard } };
}

// A message whose report link stands on its own line gets the link as a
// button that opens inside Telegram; a link inside a sentence stays as text.
function reportButton(base, text, options) {
  if (!base || typeof text !== "string" || options?.reply_markup) return { text, options };
  const line = new RegExp(`^[ \\t]*Full report: (${escape(base)}(/report/[0-9a-f-]{36}))[ \\t]*$`, "m");
  const m = text.match(line);
  if (!m) return { text, options };
  const rest = text.replace(line, "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: rest || "Your report is ready.",
    options: { ...(options || {}), reply_markup: { inline_keyboard: [[{ text: "Open report", web_app: { url: throughSignIn(base, m[1]) } }]] } },
  };
}

function telegramInApp(bot) {
  if (!bot || bot._inApp) return bot;
  const sendMessage = bot.sendMessage.bind(bot);
  const sendPhoto = bot.sendPhoto ? bot.sendPhoto.bind(bot) : null;
  const base = () => dashboardBase().catch(() => null);
  bot.sendMessage = async (chatId, text, options) => {
    const b = await base();
    const shaped = reportButton(b, text, options);
    return sendMessage(chatId, shaped.text, rewriteButtons(b, shaped.options));
  };
  if (sendPhoto) bot.sendPhoto = async (chatId, photo, options, fileOptions) => sendPhoto(chatId, photo, rewriteButtons(await base(), options), fileOptions);
  bot._inApp = true;
  return bot;
}

module.exports = { telegramInApp, throughSignIn, rewriteButtons, reportButton };
