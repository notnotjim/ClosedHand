// Links to ClosedHand's own pages (a report, the dashboard, a canvas) are
// written for the web chat, where a bare /report/<id> opens. Anywhere else
// that path leads nowhere, and the conversation is shared across apps, so a
// path the model saw in the web chat turns up in Telegram or WhatsApp. Each
// chat app gets the page in a form it can open: the personal URL in WhatsApp,
// a button that opens inside the app in Telegram (telegram-in-app.js).
const PATH = "\\/(?:report\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|canvas\\/[A-Za-z0-9_-]+|dashboard(?:#[A-Za-z0-9_-]+)?)";
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Finds each link to a ClosedHand page, as a Markdown link, the personal URL
// or a bare path, and puts back whatever found(path, label) returns for it.
function replacePages(text, base, found) {
  if (typeof text !== "string") return text;
  const host = base ? `(?:${escape(base)})?` : "";
  let out = text.replace(new RegExp(`\\[([^\\]\\n]+)\\]\\(\\s*${host}(${PATH})\\s*\\)`, "g"), (_, label, path) => found(path, label));
  if (base) out = out.replace(new RegExp(`${escape(base)}(${PATH})(?![\\w/-])`, "g"), (_, path) => found(path, null));
  return out.replace(new RegExp(`(^|[\\s(:])(${PATH})(?![\\w/-])`, "gm"), (_, before, path) => before + found(path, null));
}

// For apps that show links as text: every ClosedHand page as its full
// personal URL. With no personal URL there is nothing to make it into.
function absolutePageLinks(text, base) {
  if (!base) return text;
  return replacePages(text, base, (path, label) => label ? `[${label}](${base}${path})` : base + path);
}

module.exports = { replacePages, absolutePageLinks };
