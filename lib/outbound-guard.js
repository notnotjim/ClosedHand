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
// A query sent as a POST body is still a lookup. What makes a request a send
// is what it carries: the person's identifiers, a lot of content, or a file.
const BIG_BODY = 4096;
const SENDS_FILE = /(?:-d|--data|--data-binary|--data-raw|--data-urlencode)\s*['"]?@|--upload-file|\s-T\s|files\s*=|FormData|createReadStream|readFile(?:Sync)?\s*\(|\bopen\s*\([^)]*['"]\s*,\s*['"]r|\bcat\s+\/|\.read\(\)/;

// A lookup is a read, however long its address. It is put to the person only
// when the address carries something that is theirs: an email address, a
// phone or card number, or a key. A map query full of place names is not.
// "Is this theirs?" is the question, not "does this look like a number". A
// date, a coordinate or a file name full of digits is nobody's phone number.
// The guard knows the person's own addresses, phone and keys from their
// profile, connections and settings, and asks when one of those leaves; a
// card number is recognised by its check digit; any email address counts,
// since someone else's is still personal data leaving.
function luhnOk(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}
function ownIdentifiers(userStore) {
  const emails = new Set(), phones = new Set(), secrets = new Set();
  const profile = userStore?.profile || {};
  const settings = profile.settings || {};
  if (profile.email) emails.add(String(profile.email).toLowerCase());
  for (const conn of Object.values(userStore?.connections || {})) {
    const meta = conn?.metadata || {};
    for (const v of [meta.email, meta.account, meta.jid]) {
      if (!v) continue;
      if (/@/.test(v) && !/@s\.whatsapp\.net$/.test(v)) emails.add(String(v).toLowerCase());
      const digits = String(v).replace(/@.*$/, "").replace(/\D/g, "");
      if (digits.length >= 9) phones.add(digits);
    }
    for (const t of Object.values(conn?.tokens || {})) if (typeof t === "string" && t.length >= 16) secrets.add(t);
  }
  for (const [k, v] of Object.entries(settings)) {
    if (/key|token|secret/i.test(k) && typeof v === "string" && v.length >= 8) secrets.add(v);
  }
  for (const c of Object.values(settings.model_config?.connections || {})) if (c?.apiKey) secrets.add(String(c.apiKey));
  for (const [k, raw] of Object.entries(userStore?.facts || {})) {
    const v = raw && typeof raw === "object" ? raw.value : raw;
    if (typeof v !== "string") continue;
    if (/email/i.test(k) && /@/.test(v)) emails.add(v.trim().toLowerCase());
    if (/phone|mobile/i.test(k)) { const d = v.replace(/\D/g, ""); if (d.length >= 9) phones.add(d); }
  }
  return { emails, phones, secrets };
}
function identifierIn(text, userStore) {
  let plain = String(text || "");
  try { plain = decodeURIComponent(plain); } catch { /* keep as is */ }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(plain)) return "an email address";
  const own = ownIdentifiers(userStore);
  for (const s of own.secrets) if (plain.includes(s)) return "one of your keys";
  const digitsOnly = plain.replace(/\D/g, "");
  for (const p of own.phones) if (digitsOnly.includes(p)) return "your phone number";
  for (const run of plain.match(/(?<!\d)(?:\d[\s-]?){13,19}(?!\d)/g) || []) {
    const d = run.replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhnOk(d)) return "a card number";
  }
  // A long token outside an address's path: hashes in asset paths are
  // everyday; a token in a query string, body or header is a key leaving.
  const outsideUrls = plain.replace(/https?:\/\/[^\s"'`\\)?]+/gi, "");
  if (/(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/.test(outsideUrls)) return "what looks like a key or token";
  return null;
}

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
    if (bodyBytes > BIG_BODY) return { host, what: `a ${method} carrying ${kb(bodyBytes)}` };
    const carried = identifierIn(query + "\n" + textOf(input.body), userStore);
    if (carried) return { host, what: `a request with ${carried} in it` };
    return null;
  }

  if (toolName === "web_fetch") {
    const host = hostOf(input.url);
    if (!host || isApproved(host, userStore)) return null;
    let query = "";
    try { query = new URL(String(input.url)).search; } catch { /* no url */ }
    const carried = identifierIn(query, userStore);
    if (carried) return { host, what: `a lookup with ${carried} in the address` };
    return null;
  }

  if (toolName === "sandbox_exec") {
    const code = textOf(input.code);
    const sends = /\bcurl\b|\bwget\b|fetch\s*\(|requests\.(post|put|patch|delete)|\.post\s*\(|http\.request|axios|urllib|XMLHttpRequest|httpx|Invoke-WebRequest|urlopen/i.test(code);
    if (!sends) return null;
    const urls = code.match(/https?:\/\/[^\s"'`\\)]+/gi) || [];
    // Judge the code with its addresses removed: "?data=" in a lookup's
    // address is a query, not a body.
    const bare = code.replace(/https?:\/\/[^\s"'`\\)]+/gi, "");
    const writes = /-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|-F\s|--form|method\s*[:=]\s*["']?(POST|PUT|PATCH|DELETE)|requests\.(post|put|patch|delete)|\.post\s*\(|axios\.(post|put|patch)|body\s*[:=]|data\s*=|json\s*=|files\s*=/i.test(bare);
    for (const u of urls) {
      const host = hostOf(u);
      if (!host || isApproved(host, userStore)) continue;
      if (/^(localhost|127\.|10\.|192\.168\.|bot$|sandbox$|db$)/.test(host)) continue;
      if (writes && SENDS_FILE.test(bare)) return { host, what: "code that sends a file" };
      if (writes && bare.length > BIG_BODY) return { host, what: `code that sends ${kb(bare.length)} of content` };
      const carried = identifierIn(code, userStore);
      if (carried) return { host, what: `a request with ${carried} in it` };
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

module.exports = { outboundIntent, card, approveHost, isApproved, hostOf, identifierIn, ownIdentifiers };
