// lib/sign-in-hosts.js: where each sign-in may go.
//
// api_request and sandbox_gateway send a connected service's sign-in with a
// request to the address the model gives. The model reads mail and web pages
// all day, and any of them can tell it to send a request somewhere else, so a
// sign-in goes only to its own service's API addresses, listed here. A
// service with none listed has nothing sent for it. The rule holds for every
// service, including those whose code builds the address itself (Meta,
// Shopify), so it can't open up if that code changes. Services connected
// with a key are locked to their own address separately
// (lib/api-connections.js).

// "*.example.com" is any address under example.com, not example.com itself.
const HOSTS = {
  google: ["*.googleapis.com"],
  microsoft: ["graph.microsoft.com"],
  slack: ["slack.com", "*.slack.com"],
  whatsapp: ["graph.facebook.com"],
  meta: ["graph.facebook.com"],
  meta_ads: ["graph.facebook.com"],
  shopify: ["*.myshopify.com"],
  notion: ["api.notion.com"],
  atlassian: ["api.atlassian.com"],
  spotify: ["api.spotify.com"],
  stripe: ["api.stripe.com", "files.stripe.com"],
  dropbox: ["api.dropboxapi.com", "content.dropboxapi.com"],
  hubspot: ["api.hubapi.com"],
  salesforce: ["*.my.salesforce.com"],
  github: ["api.github.com", "uploads.github.com"],
  gitlab: ["gitlab.com"],
  line: ["api.line.me", "api-data.line.me"],
};

function hostOf(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "https:" && !u.username && !u.password ? u.hostname.toLowerCase() : null;
  } catch { return null; }
}

// Whether a request to url may carry service's sign-in.
function signInMayGo(service, url) {
  const name = String(service || "").toLowerCase();
  const host = hostOf(url);
  const hosts = HOSTS[name];
  if (!host || !hosts) return false;
  return hosts.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : h === host));
}

// What the model is told instead, so it can correct the call.
function refusal(service) {
  const name = String(service || "");
  const hosts = HOSTS[name.toLowerCase()];
  if (!hosts) return `There is no sign-in for "${name}" to send. For a request without one, use service "none".`;
  return `The ${name} sign-in is only ever sent to ${hosts.join(" or ")}, over https. For any other address, use service "none".`;
}

module.exports = { signInMayGo, refusal, HOSTS };
