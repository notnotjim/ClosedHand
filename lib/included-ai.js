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
// that can't be read just now. A key whose limit OpenRouter resets every month
// (Closedhand+) counts this month's use; never shown, only compared.
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
    const limit = Number(data.limit), used = Number(data.limit_reset === "monthly" ? data.usage_monthly : data.usage);
    if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return null;
    const remaining = Number(data.limit_remaining);
    return { limit, used, left: Math.max(0, Number.isFinite(remaining) ? remaining : limit - used) };
  } catch (_) {
    return null;
  }
}

// The person is told once a period, when this share of the fair use is used.
const NEARLY_USED = 0.8;

// What a period of fair use is called, so each is warned about once: a first
// month by when it ends, Closedhand+ by the month OpenRouter resets it in
// (UTC), and again once the person paid to carry on in it. None otherwise.
function period(plan, now = new Date()) {
  if (plan?.name === "first-month") return "first-month:" + (plan.ends_at || "");
  if (plan?.name === "plus") return "plus:" + now.toISOString().slice(0, 7) + (plan.extended ? ":extended" : "");
  return null;
}

// The day as people say it ("21 November"), where they are.
function day(iso, timeZone) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "the end of the month";
  try { return at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone }); }
  catch (_) { return at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }); }
}
// When the fair use of Closedhand+ comes back: the turn of the month (UTC),
// as OpenRouter resets the key.
function nextMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}
// Closedhand+ is taken out and managed on the person's account on
// closedhand.com.
function account(web) {
  return web ? "[closedhand.com/account](https://closedhand.com/account)" : "closedhand.com/account";
}

// Where to go: the dashboard's Settings, as a link the chat can show (the
// web chat shows links on words; chat apps show the address).
function dashboard(link, web) {
  return link ? (web ? `[dashboard](${link})` : `dashboard (${link})`) : "dashboard's Settings";
}

// What the person is told, in fixed words: when the fair use is reached there
// is no model left to write them. Their own LLM provider comes first: that is
// what Closedhand is built for, free ones included.
function endingText(plan, link, web, timeZone) {
  return `Closedhand Managed Models, the LLM I've been using since you set me up, stays on until ${day(plan?.ends_at, timeZone)}. After that, connect your own LLM provider in the ${dashboard(link, web)} (free ones work too), or keep Managed Models with Closedhand+${plan?.email ? ", which also gives Closedhand's own email with no monthly limit" : ""}.`;
}
function nearlyUsedText(plan, link, web) {
  if (plan?.name === "plus" && plan.extended) return `You've used most of this month's fair use of Closedhand+. To carry on without a break, connect your own LLM provider in the ${dashboard(link, web)}.`;
  if (plan?.name === "plus") return `You've used most of this month's fair use of Closedhand+. To carry on without a break, carry on to the end of the month at ${account(web)}, or connect your own LLM provider in the ${dashboard(link, web)}.`;
  return `You've used most of the fair use of Closedhand Managed Models. To carry on without a break, connect your own LLM provider in the ${dashboard(link, web)} (free ones work too), or get Closedhand+ at ${account(web)}.`;
}
// The key was refused for its limit: by what the plan was last known to be.
function usedUpText(plan, link, web, timeZone) {
  if (plan?.name === "plus" && plan.extended) return `You've reached this month's fair use of Closedhand+, so I can't reply until ${day(nextMonth(), timeZone)}. Connect your own LLM provider in the ${dashboard(link, web)} to carry on before then.`;
  if (plan?.name === "plus") return `You've reached this month's fair use of Closedhand+, so I can't reply until ${day(nextMonth(), timeZone)}. Carry on to the end of the month at ${account(web)}, or connect your own LLM provider in the ${dashboard(link, web)}.`;
  if (plan?.name === "ended" && plan.was === "plus") return `Your Closedhand+ has ended, so I can't reply for now. Connect your own LLM provider in the ${dashboard(link, web)} (free ones work too) and I'll carry on, or subscribe again at ${account(web)}.`;
  if (plan?.name === "ended") return `Closedhand Managed Models has ended, so I can't reply for now. Connect your own LLM provider in the ${dashboard(link, web)} (free ones work too) and I'll carry on, or keep Managed Models with Closedhand+ at ${account(web)}.`;
  return `You've reached the fair use of Closedhand Managed Models, so I can't reply for now. Connect your own LLM provider in the ${dashboard(link, web)} (free ones work too) and I'll carry on, or get Closedhand+ at ${account(web)}.`;
}
// The person's own LLM provider refused: out of credit, or the key rejected.
function accountProblemText(status, link, web) {
  return status === 402
    ? `Your LLM provider says the account needs payment or more credit, so I can't reply for now. Top it up with them, or connect another LLM provider in the ${dashboard(link, web)}.`
    : `Your LLM provider rejected Closedhand's API key, so I can't reply for now. Check the key under Models in the ${dashboard(link, web)}.`;
}

module.exports = { inUse, credit, NEARLY_USED, period, day, nextMonth, endingText, nearlyUsedText, usedUpText, accountProblemText };
