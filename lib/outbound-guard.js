// lib/outbound-guard.js — your keys, cards and files never leave for somewhere new without a yes.
//
// The model reads pages and mail all day, and a page can carry words telling
// it to post what it can see to an address of a stranger's choosing. Sends
// and spends are gated elsewhere, so the route left is the plain request: a
// POST from the sandbox computer, a raw request to an unknown address. This
// gate asks first only when such a request carries something whose loss
// would really cost the person: one of their own keys or tokens, a card
// number, one of their files, or content in bulk. Everything else goes
// without a question: an email address in a lookup, a long id in an address,
// a script that reads a page it downloaded. A question that turns out to be
// needless teaches the person to answer "always" without reading, which
// leaves them less safe than no question, so the bar stays at real loss.
// "yes" allows it once, "always" adds the place to the trusted list.
// Requests to a connected service go to the provider that already holds the
// data, and a site the person named in chat counts as theirs. No model call:
// this is regex and a list, so it costs nothing.

// Content in bulk: a body this size is a document or a dataset, not a query.
const BULK_BODY = 16384;
// A file handed to a request: curl's upload flags (case-sensitive, as curl's
// are), a multipart form, or a file read straight into the request's body.
// Reading a file on its own is not sending it: a script that saves a page and
// then reads it back sends nothing.
const SENDS_FILE = new RegExp([
  String.raw`(?:-d|--data|--data-binary|--data-raw|--data-urlencode)\s*['"]?@`,
  String.raw`(?:-F|--form)\s*['"]?[^\s'"=]+=@`,
  String.raw`--upload-file|\s-T\s`,
  String.raw`[(,]\s*files\s*=`,
  String.raw`[({,]\s*(?:data|body|content)\s*[:=]\s*(?:open\s*\(|(?:fs\.)?(?:readFileSync|createReadStream)\s*\(|Path\s*\([^)]*\)\.read_(?:bytes|text)\s*\()`,
  String.raw`FormData|createReadStream`,
].join("|"));

function luhnOk(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

// The person's own keys and tokens, as ClosedHand holds them: connection
// tokens, keys in settings, model provider keys. Only these count as a key
// leaving; a long random-looking string in an address is usually an id.
function ownSecrets(userStore) {
  const secrets = new Set();
  const settings = userStore?.profile?.settings || {};
  for (const conn of Object.values(userStore?.connections || {})) {
    for (const t of Object.values(conn?.tokens || {})) if (typeof t === "string" && t.length >= 16) secrets.add(t);
  }
  for (const [k, v] of Object.entries(settings)) {
    if (/key|token|secret/i.test(k) && typeof v === "string" && v.length >= 8) secrets.add(v);
  }
  for (const c of Object.values(settings.model_config?.connections || {})) if (c?.apiKey) secrets.add(String(c.apiKey));
  return secrets;
}

// What in this text would really cost the person if it reached a stranger:
// one of their keys, or a card number (recognised by its check digit).
function secretIn(text, userStore) {
  let plain = String(text || "");
  try { plain = decodeURIComponent(plain); } catch { /* keep as is */ }
  for (const s of ownSecrets(userStore)) if (plain.includes(s)) return "one of your keys";
  for (const run of plain.match(/(?<!\d)(?:\d[\s-]?){13,19}(?!\d)/g) || []) {
    const d = run.replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhnOk(d)) return "a card number";
  }
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

// Returns { host, what } when this call would carry a key, a card, a file
// or content in bulk to a place the person has not trusted, else null.
function outboundIntent(toolName, input, userStore) {
  if (!input || typeof input !== "object") return null;

  if (toolName === "api_request" || toolName === "sandbox_gateway") {
    const service = String(input.service || "none");
    if (service !== "none") return null; // the provider already holds the data
    const host = hostOf(input.url);
    if (!host || isApproved(host, userStore)) return null;
    const method = String(input.method || "GET").toUpperCase();
    const bodyBytes = sizeOf(input.body);
    if (bodyBytes > BULK_BODY) return { host, what: `a ${method} carrying ${kb(bodyBytes)}` };
    const carried = secretIn([input.url, textOf(input.body), textOf(input.headers)].join("\n"), userStore);
    if (carried) return { host, what: `a request with ${carried} in it` };
    return null;
  }

  if (toolName === "web_fetch" || toolName === "watch_video") {
    const host = hostOf(input.url);
    if (!host || isApproved(host, userStore)) return null;
    const carried = secretIn(input.url, userStore);
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
    for (const u of urls) {
      const host = hostOf(u);
      if (!host || isApproved(host, userStore)) continue;
      if (/^(localhost|127\.|10\.|192\.168\.|bot$|sandbox$|db$)/.test(host)) continue;
      if (SENDS_FILE.test(bare)) return { host, what: "code that sends a file" };
      const carried = secretIn(code, userStore);
      if (carried) return { host, what: `a request with ${carried} in it` };
    }
    return null;
  }
  return null;
}

// The site itself, as a person writes it: example.com for api.example.com,
// example.co.uk for www.example.co.uk.
function siteOf(host) {
  const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2], tld = parts[parts.length - 1];
  const take = tld.length === 2 && /^(co|com|org|net|ac|gov|edu|ltd|plc|me)$/.test(sld) ? 3 : 2;
  return parts.slice(-take).join(".");
}

// The person named this site in what they typed ("sign me up on
// example.com"), so their own words approve this send and it goes without
// a second question. Only the person's typed messages are passed in: a page
// or an email ClosedHand read is never among them, so it cannot approve a
// place. The site must be written out; a lookalike word does not count.
function namedByOwner(host, texts) {
  const site = siteOf(host);
  if (!site || !site.includes(".")) return false;
  const re = new RegExp("(^|[^a-z0-9.-])(?:[a-z0-9-]+\\.)*" + site.replace(/\./g, "\\.") + "(?![a-z0-9-])", "i");
  return (texts || []).map(typedPart).some((t) => re.test(t));
}

// What the person typed themselves: a forward is someone else's words, and a
// quoted reply ("[Replying to: ...]") quotes an earlier message, so neither
// counts.
function typedPart(text) {
  if (typeof text !== "string" || require("./forwarded").isForwardedText(text)) return "";
  return text.replace(/^\[Replying to: "[\s\S]*?"\]\s*/, "");
}

function card(intent) {
  return `Just to confirm: this would send data to ${intent.host}, a site you haven't trusted: ${intent.what}.\n\nReply "yes" to allow it this once, "always" to trust ${intent.host} so ClosedHand can send there without confirming with you, or "no" to stop. You can say "stop trusting ${intent.host}" any time.`;
}

// Adds a host to the approved list on the profile.
async function approveHost(userStore, host) {
  if (!userStore || !userStore.profile || !host) return;
  try {
    await require("./profile-settings").updateSettings(userStore.userId, (s) => {
      const list = Array.isArray(s.allowed_hosts) ? s.allowed_hosts : [];
      if (!list.includes(host)) list.push(host);
      s.allowed_hosts = list;
    }, { store: userStore });
  } catch (e) { console.error("[outbound-guard] could not save the approved host:", e.message); }
}

// Stops trusting a site, when the person asks in chat. Returns the list after.
async function forgetHost(userStore, host) {
  const target = String(host || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  let before = [], after = [];
  try {
    await require("./profile-settings").updateSettings(userStore.userId, (s) => {
      before = Array.isArray(s.allowed_hosts) ? s.allowed_hosts : [];
      after = before.filter((h) => h !== target && !h.endsWith("." + target));
      s.allowed_hosts = after;
    }, { store: userStore });
  } catch (e) { throw new Error("Could not save that. Try again."); }
  return after.length === before.length ? { removed: false, sites: before } : { removed: true, sites: after };
}

module.exports = { outboundIntent, card, approveHost, forgetHost, approvedHosts, isApproved, hostOf, secretIn, ownSecrets, siteOf, namedByOwner };
