// lib/outbound-guard.js — nothing of yours leaves for somewhere new without a yes.
//
// The model reads pages and mail all day, and a page can carry words telling
// it to post what it can see to an address of a stranger's choosing. Tokens
// and cards never enter the model's view, sends and spends are gated, so the
// route left is the plain request: a POST from the cloud computer, a raw
// request to an address with a long query string. This gate covers it in
// ClosedHand's own idiom: a request that carries content to a place the
// person has not approved is put to them first; "yes" allows it once,
// "always" adds the place to the approved list in Settings. Requests to a
// connected service go to the provider that already holds the data, and are
// not gated here. Reads without content are never gated: that is how it
// browses. No model call: this is regex and a list, so it costs nothing.

const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;
const LONG_QUERY = 120;

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

function approvedHosts(userStore) {
  const s = (userStore && userStore.profile && userStore.profile.settings) || {};
  return Array.isArray(s.allowed_hosts) ? s.allowed_hosts.map((h) => String(h).toLowerCase()) : [];
}

function isApproved(host, userStore) {
  if (!host) return true;
  const list = approvedHosts(userStore);
  return list.some((h) => host === h || host.endsWith("." + h));
}

function sizeOf(v) {
  if (v == null) return 0;
  return Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v));
}

function kb(n) { return n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`; }

function textOf(v) { return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v); }

// Returns { host, what } when this call would carry content to an
// unapproved place, else null.
function outboundIntent(toolName, input, userStore) {
  if (!input || typeof input !== "object") return null;

  if (toolName === "api_request" || toolName === "sandbox_gateway") {
    const service = String(input.service || "none");
    if (service !== "none") return null; // the provider already holds the data
    const method = String(input.method || "GET").toUpperCase();
    const host = hostOf(input.url);
    if (!host || isApproved(host, userStore)) return null;
    const bodyBytes = sizeOf(input.body);
    let query = "";
    try { query = new URL(String(input.url)).search; } catch { /* no url */ }
    if (WRITE_METHOD.test(method) || bodyBytes > 0) return { host, what: `a ${method} carrying ${kb(bodyBytes)}` };
    if (query.length > LONG_QUERY) return { host, what: `a request with ${query.length} characters of data in the address` };
    return null;
  }

  if (toolName === "web_fetch") {
    const host = hostOf(input.url);
    if (!host || isApproved(host, userStore)) return null;
    let query = "";
    try { query = new URL(String(input.url)).search; } catch { /* no url */ }
    if (query.length > LONG_QUERY) return { host, what: `a request with ${query.length} characters of data in the address` };
    return null;
  }

  if (toolName === "sandbox_exec") {
    const code = textOf(input.code);
    const sends = /\bcurl\b|\bwget\b|fetch\s*\(|requests\.(post|put|patch|delete)|\.post\s*\(|http\.request|axios|urllib|XMLHttpRequest|httpx|Invoke-WebRequest|urlopen/i.test(code);
    if (!sends) return null;
    const writes = /-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|-F\s|--form|method\s*[:=]\s*["']?(POST|PUT|PATCH|DELETE)|requests\.(post|put|patch|delete)|\.post\s*\(|axios\.(post|put|patch)|body\s*[:=]|data\s*=|json\s*=|files\s*=/i.test(code);
    const urls = code.match(/https?:\/\/[^\s"'`\\)]+/gi) || [];
    for (const u of urls) {
      const host = hostOf(u);
      if (!host || isApproved(host, userStore)) continue;
      if (/^(localhost|127\.|10\.|192\.168\.|bot$|sandbox$|db$)/.test(host)) continue;
      let query = "";
      try { query = new URL(u).search; } catch { /* skip */ }
      if (writes) return { host, what: "a request from code that sends data" };
      if (query.length > LONG_QUERY) return { host, what: `a request with ${query.length} characters of data in the address` };
    }
    return null;
  }
  return null;
}

function card(intent) {
  return `Just to confirm: this would send data to ${intent.host}, somewhere you have not approved: ${intent.what}.\n\nReply "yes" to allow it this once, "always" to let ClosedHand send to ${intent.host} from now on, or "no" to stop.`;
}

// Adds a host to the approved list on the profile.
async function approveHost(userStore, host) {
  if (!userStore || !userStore.profile || !host) return;
  const { supabase } = require("./db");
  const settings = userStore.profile.settings || {};
  const list = Array.isArray(settings.allowed_hosts) ? settings.allowed_hosts : [];
  if (!list.includes(host)) list.push(host);
  settings.allowed_hosts = list;
  userStore.profile.settings = settings;
  const { error } = await supabase.from("profiles").update({ settings }).eq("id", userStore.userId);
  if (error) console.error("[outbound-guard] could not save the approved host:", error.message);
}

module.exports = { outboundIntent, card, approveHost, isApproved, hostOf };
