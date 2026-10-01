// lib/otp-guard.js — one-time codes and password-reset links stay out of the
// model's view unless the person asked for one just now.
//
// An inbox holds the keys to every other account: sign-in codes, reset links,
// "confirm this purchase" one-time passwords. An agent that reads them can
// finish things it was never asked to finish, and a page it is browsing can
// tell it to. So every path by which mail reaches the model drops those
// messages, with a line saying so, unless the person's own message in the
// last few minutes asked for a code. Then, and only then, the code is shown.

const CODE_SUBJECT = /\b(one[-\s]?time\s+(?:code|password|passcode|pin)|verification\s+code|verify\s+your\s+(?:email|sign[-\s]?in|login|identity|account)|security\s+code|login\s+code|sign[-\s]?in\s+code|authentication\s+code|access\s+code|confirmation\s+code|your\s+code(?:\s+is)?|passcode|\bOTP\b|2fa|two[-\s]?factor|magic\s+link|sign\s+in\s+to\s+your\s+account)\b/i;
const CODE_BODY = /\b(?:code|passcode|password|pin|OTP)\b[^\n]{0,60}?\b\d{4,8}\b|\b\d{4,8}\b[^\n]{0,40}?\b(?:is\s+your|verif\w*|one[-\s]?time|code|sign[-\s]?in|log[-\s]?in|authenticat\w*)\b/i;
const RESET = /\b(reset\s+(?:your\s+)?password|password\s+reset|change\s+(?:your\s+)?password|forgot(?:ten)?\s+(?:your\s+)?password|reset\s+link|set\s+a\s+new\s+password|recover\s+your\s+account)\b/i;

const WITHHELD = "[withheld: a sign-in code or password-reset message. ClosedHand does not read these unless you ask for the code yourself.]";

// userId -> until (ms). Set when the person's own message asks for a code.
const _allowUntil = new Map();
const ALLOW_MS = 3 * 60 * 1000;

const ASKS_FOR_CODE = /\b(what(?:'s| is) the code|the code|my code|otp|passcode|verification code|login code|sign[-\s]?in code|2fa|two[-\s]?factor|security code|code (?:from|in) (?:my )?(?:email|inbox|mail|sms|text)|read (?:me )?the code|reset (?:my )?password|password reset (?:link|email))\b/i;

function noteUserMessage(userId, text) {
  if (!userId) return;
  if (ASKS_FOR_CODE.test(String(text || ""))) _allowUntil.set(userId, Date.now() + ALLOW_MS);
}

function allowed(userId) {
  const until = _allowUntil.get(userId);
  return !!until && Date.now() < until;
}

function isSensitive(subject, body) {
  const s = String(subject || "");
  const b = String(body || "").slice(0, 4000);
  if (RESET.test(s) || RESET.test(b.slice(0, 600))) return "reset";
  if (CODE_SUBJECT.test(s)) return "code";
  if (CODE_BODY.test(b) && /\b(verif|sign[-\s]?in|login|one[-\s]?time|security|authenticat|confirm)/i.test(s + " " + b.slice(0, 400))) return "code";
  return null;
}

// Redact one search result / cache item in place-safe fashion (returns a copy).
function redactEmail(item, userId) {
  if (!item || allowed(userId)) return item;
  const kind = isSensitive(item.subject, item.body || item.snippet || item.summary);
  if (!kind) return item;
  return { ...item, body: WITHHELD, snippet: undefined, summary: undefined, _withheld: kind };
}

// Redact a recall / semantic result whose text carries a code.
function redactRecall(row, userId) {
  if (!row || allowed(userId)) return row;
  const meta = row.metadata || row.source_metadata || {};
  const kind = isSensitive(meta.subject || meta.title || "", row.content);
  if (!kind) return row;
  return { ...row, content: WITHHELD, _withheld: kind };
}

module.exports = { noteUserMessage, allowed, isSensitive, redactEmail, redactRecall, WITHHELD };
