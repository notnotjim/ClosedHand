// Pages ClosedHand sends on Telegram open inside Telegram, signed in there by
// Telegram's own proof of who opened them (webapp: /tg/open and
// /api/telegram/session), so no password is asked inside Telegram.
//
// Wrapped once where the bot is made, so every send and edit gets it:
// - any in-app button pointing at this ClosedHand goes through /tg/open;
// - any link to a ClosedHand page in the text (a report, the dashboard, a
//   canvas; a bare path, the personal URL or a Markdown link) becomes a
//   button named after it, and the text keeps only its words;
// - Markdown becomes Telegram's own formatting, so **bold** and [a](link)
//   never show as symbols.
const { dashboardBase } = require("./config");
const { replacePages } = require("./page-links");
const { supabase } = require("../user-store");

const MARK = "\u0000";

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

// A report's button carries its title; the model's own words for the link
// come first, and a plain "Open report" when neither is to hand.
async function reportTitles(ids) {
  if (!ids.length) return {};
  try {
    const { data, error } = await supabase.from("reports").select("id, title").in("id", ids);
    if (error) throw new Error(error.message);
    return Object.fromEntries((data || []).map((r) => [r.id, r.title]));
  } catch (e) {
    console.error("[telegram] report titles:", e.message);
    return {};
  }
}

function buttonText(page, titles) {
  const id = page.path.startsWith("/report/") ? page.path.slice(8) : null;
  const text = page.label || (id && titles[id]) || (id ? "Open report" : page.path.startsWith("/dashboard") ? "Open dashboard" : "Open");
  return text.length > 40 ? text.slice(0, 40).replace(/\s+\S*$/, "") + "…" : text;
}

// Takes the page links out of the text and returns them as buttons. A bare
// link leaves its sentence behind without the dangling colon; a line that was
// only a pointer ("Full report: ...") goes, since the button replaces it.
async function pageButtons(base, text) {
  const pages = [];
  const body = replacePages(text, base, (path, label) => {
    if (!pages.some((p) => p.path === path)) pages.push({ path, label });
    return label || MARK;
  }).split("\n").map((line) => {
    if (!line.includes(MARK)) return line;
    const rest = line.split(MARK).join("").replace(/[ \t]*[:\-–][ \t]*$/, "").trimEnd();
    return /^\s*(?:full report|the report|report|your dashboard|dashboard|here)?\s*$/i.test(rest) ? null : rest;
  }).filter((line) => line !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!pages.length) return { text, buttons: [] };
  const titles = await reportTitles(pages.map((p) => p.path.startsWith("/report/") ? p.path.slice(8) : null).filter(Boolean));
  const buttons = base ? pages.slice(0, 6).map((p) => [{ text: buttonText(p, titles), web_app: { url: throughSignIn(base, base + p.path) } }]) : [];
  const note = base ? "" : "\n\nTo open ClosedHand's pages from your phone, turn on Your phone in the dashboard's Settings on the computer running ClosedHand.";
  return { text: (body || "Here it is.") + note, buttons };
}

// Telegram's HTML formatting from the Markdown models write.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function telegramHtml(text) {
  return String(text).split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return part.startsWith("```") ? `<pre>${esc(part.replace(/^```[\w-]*\n?/, "").replace(/```$/, ""))}</pre>` : `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, (_, label, url) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
      .replace(/^ {0,3}#{1,6}\s+(.+)$/gm, "<b>$1</b>")
      .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, "$1<i>$2</i>");
  }).join("");
}

// Everything a message needs before Telegram sees it. A caller that chose
// its own formatting keeps it.
async function shape(base, text, options) {
  if (typeof text !== "string" || options?.parse_mode) return { text, options: rewriteButtons(base, options), plain: text };
  const markup = options?.reply_markup;
  const inline = !markup || Array.isArray(markup.inline_keyboard);
  const pages = inline ? await pageButtons(base, text) : { text, buttons: [] };
  const rows = [...(markup?.inline_keyboard || []), ...pages.buttons];
  const shaped = { ...(options || {}), parse_mode: "HTML" };
  if (rows.length) shaped.reply_markup = { ...(markup || {}), inline_keyboard: rows };
  return { text: telegramHtml(pages.text), options: rewriteButtons(base, shaped), plain: pages.text };
}

// Formatting Telegram cannot read is sent as plain text rather than lost.
async function withFallback(send, shaped, rest) {
  try { return await send(shaped.text, shaped.options, ...rest); }
  catch (e) {
    if (!/can't parse entities|unsupported start tag|can't find end tag/i.test(e.message || "")) throw e;
    const { parse_mode, ...plain } = shaped.options || {};
    return send(shaped.plain, plain, ...rest);
  }
}

function telegramInApp(bot) {
  if (!bot || bot._inApp) return bot;
  const sendMessage = bot.sendMessage.bind(bot);
  const editMessageText = bot.editMessageText ? bot.editMessageText.bind(bot) : null;
  const sendPhoto = bot.sendPhoto ? bot.sendPhoto.bind(bot) : null;
  const base = () => dashboardBase().catch(() => null);
  bot.sendMessage = async (chatId, text, options) =>
    withFallback((t, o) => sendMessage(chatId, t, o), await shape(await base(), text, options), []);
  if (editMessageText) bot.editMessageText = async (text, options) =>
    withFallback((t, o) => editMessageText(t, o), await shape(await base(), text, options), []);
  if (sendPhoto) bot.sendPhoto = async (chatId, photo, options, fileOptions) => sendPhoto(chatId, photo, rewriteButtons(await base(), options), fileOptions);
  bot._inApp = true;
  return bot;
}

module.exports = { telegramInApp, throughSignIn, rewriteButtons, pageButtons, telegramHtml };
