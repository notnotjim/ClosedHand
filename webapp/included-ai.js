// included-ai.js: vendored. lib/included-ai.js and webapp/included-ai.js are
// byte-identical (scripts/vendored-manifest.json).
//
// Closedhand Managed Models: an OpenRouter API key of the person's own,
// made by closedhand.com when they claimed their personal URL
// (closedhand-com/lib/included-ai.js). It is kept sealed in the settings
// (included_api_key) and used like any key the person pastes in. What is
// left on it is read from OpenRouter with the key itself, so closedhand.com
// never sees it being used.
const { openKey } = require("./model-policy");

// Closedhand is answering with its Managed Models right now.
function inUse(settings) {
  return !!(settings?.model_config?.included && settings?.included_api_key);
}

// What is left on the key, { limit, used, left } in dollars, or null when
// that can't be read just now.
async function credit(settings) {
  const key = openKey(settings?.included_api_key);
  if (!key) return null;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: "Bearer " + key, "HTTP-Referer": "https://closedhand.com", "X-Title": "Closedhand" },
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (!response.ok) return null;
    const data = (await response.json())?.data || {};
    const limit = Number(data.limit), used = Number(data.usage);
    if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return null;
    const remaining = Number(data.limit_remaining);
    return { limit, used, left: Math.max(0, Number.isFinite(remaining) ? remaining : limit - used) };
  } catch (_) {
    return null;
  }
}

// The person is told once, when this share of the credit is used.
const NEARLY_USED = 0.8;

// Where to go: the dashboard's Settings, as a link the chat can show (the
// web chat shows links on words; chat apps show the address).
function dashboard(link, web) {
  return link ? (web ? `[dashboard](${link})` : `dashboard (${link})`) : "dashboard's Settings";
}

// What the person is told, in fixed words: when the credit has run out there
// is no model left to write them.
function nearlyUsedText(link, web) {
  return `You've used most of your free use of Closedhand Managed Models. To carry on without a break, connect your own LLM provider in the ${dashboard(link, web)}.`;
}
function usedUpText(link, web) {
  return `Your free use of Closedhand Managed Models has run out, so I can't reply for now. Connect your own LLM provider in the ${dashboard(link, web)} and I'll carry on.`;
}
// The person's own LLM provider refused: out of credit, or the key rejected.
function accountProblemText(status, link, web) {
  return status === 402
    ? `Your LLM provider says the account needs payment or more credit, so I can't reply for now. Top it up with them, or connect another LLM provider in the ${dashboard(link, web)}.`
    : `Your LLM provider rejected Closedhand's API key, so I can't reply for now. Check the key under Models in the ${dashboard(link, web)}.`;
}

module.exports = { inUse, credit, NEARLY_USED, nearlyUsedText, usedUpText, accountProblemText };
