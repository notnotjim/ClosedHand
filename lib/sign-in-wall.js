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

async function signInNote(page) {
  let site = "";
  try { site = new URL(String(page.url)).hostname.replace(/^www\./, ""); } catch { /* no site */ }
  let base = null;
  try { base = await dashboardBase(); } catch { /* no public address */ }
  const where = base ? `${base}/#computers (the Computers tab of the web chat)` : "the Computers tab of the web chat";
  return `This is a sign-in page${site ? ` (${site})` : ""}: the site needs the person signed in. Ask them to sign in to it themselves in Closedhand's sandbox computer, at ${where}; it stays signed in for later tasks. Then carry on from where you are. Offer this before any other way round it. Never type their details, and never look for another way past the sign-in (other addresses, a direct request, the browser's own files).`;
}

module.exports = { isSignInPage, signInNote };
