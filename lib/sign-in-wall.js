// A sign-in page in the sandbox browser means the person has to sign in there
// themselves, once: the browser keeps them signed in for later tasks. Left to
// work that out, an agent emailed the restaurant instead, told the person the
// browser was "signed into a different account" when nobody was signed in,
// and went reading the browser's cookie file. The tool's own result now says
// what to do at the moment it lands on the page, with the link to where the
// person signs in.
const { dashboardBase } = require("./config");

const SIGN_IN_HOST = /^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|login\.yahoo\.com)$/i;
const SIGN_IN_PATH = /\/(sign[-_]?in|log[-_]?in|signin|login|sso|oauth2?)(\/|\?|$|#)/i;
const SIGN_IN_TITLE = /\b(sign in|log in|login)\b/i;

function isSignInPage(page) {
  if (!page || !page.url) return false;
  let u;
  try { u = new URL(String(page.url)); } catch { return false; }
  return SIGN_IN_HOST.test(u.hostname) || SIGN_IN_PATH.test(u.pathname) || SIGN_IN_TITLE.test(String(page.title || ""));
}

function siteOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function signInNote(page) {
  const site = siteOf(page.url);
  let base = null;
  try { base = await dashboardBase(); } catch { /* no public address */ }
  const where = base ? `${base}/#computers (the Computers tab of the web chat)` : "the Computers tab of the web chat";
  return `This is a sign-in page${site ? ` (${site})` : ""}: the site needs the person signed in. Ask them to sign in to it themselves in Closedhand's sandbox computer, at ${where}; it stays signed in for later tasks. Then carry on from where you are. Offer this before any other way round it. Never type their details, and never look for another way past the sign-in (other addresses, a direct request, the browser's own files).`;
}

// A job running in the background stops on a sign-in page and asks in the chat
// it came from (lib/agents.js), with the page already open in the sandbox
// computer's browser; a reply that says it is done carries the job on.
async function signInQuestion(site) {
  let base = null;
  try { base = await dashboardBase(); } catch { /* no public address */ }
  const where = base ? `on Closedhand's sandbox computer: ${base}/#computers` : "on Closedhand's sandbox computer, on the Computers tab of the web chat";
  return `${site || "This site"} needs you signed in before I can carry on. Sign in ${where}. It's open on the page, and it stays signed in for next time. Reply done when you have, and I'll pick up where I left off.`;
}

// "done", "signed in", "I've logged in now": carry on. "no", "skip", "can't":
// go on without. "not yet", "one sec": keep waiting.
const WAIT = /\b(not yet|wait|hold on|hang on|one (sec|second|moment|min|minute)|in a (sec|second|bit|minute)|still|later)\b/i;
const DONE = /\b(done|signed|logged|finished|ready|yes|yep|yeah|ok|okay|sure|go)\b/i;
const NOT = /\b(no|nope|nah|skip|can'?t|cannot|won'?t|don'?t|not|never|stop|cancel)\b/i;
function signInAnswer(text) {
  const t = String(text || "").replace(/[’]/g, "'").trim();
  if (!t || t.split(/\s+/).length > 8) return null;
  if (WAIT.test(t)) return "wait";
  if (NOT.test(t)) return "no";
  if (DONE.test(t)) return "done";
  return null;
}

module.exports = { isSignInPage, signInNote, siteOf, signInQuestion, signInAnswer };
