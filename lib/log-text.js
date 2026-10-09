// What a log line may say about something a person wrote, said or was sent:
// how long it is, never its words. A message can hold a password or a card
// number, and logs are kept, and shared when reporting a bug.
// CLOSEDHAND_LOG_TEXT=1 shows a short preview, digit runs and key-shaped
// strings masked, for debugging on your own computer.
const KEYISH = /\b(?:sk-|sk_|xai-|gsk_|AIza|pplx-|hf_|r8_|nvapi-|fw_|csk-)[A-Za-z0-9_-]{8,}|[A-Za-z0-9]{32,}/g;

function peek(text, n = 60) {
  const s = String(text ?? "");
  if (process.env.CLOSEDHAND_LOG_TEXT !== "1") return `(${s.length} chars)`;
  return JSON.stringify(s.slice(0, n).replace(/\d[\d -]{4,}\d/g, "[digits]").replace(KEYISH, "[key]"));
}

// An address as a log line may show it: where it goes, never its query,
// fragment or sign-in part, which can carry a token or a key.
function peekUrl(url) {
  const s = String(url ?? "");
  try {
    const u = new URL(s);
    return u.origin === "null" ? u.protocol : u.origin + u.pathname;
  } catch { return s.split(/[?#]/)[0]; }
}

module.exports = { peek, peekUrl };
