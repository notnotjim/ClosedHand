// bank-feeds.js: read-only bank feeds from SimpleFIN (US banks) and Lunch Flow
// (UK and EU banks).
//
// SHARED FILE, DO NOT DIVERGE. Identical copies live at lib/bank-feeds.js and
// webapp/bank-feeds.js: the dashboard claims and checks a connection, the bot
// syncs it, and the two services cannot import each other.
// scripts/check-vendored-identical.js keeps them the same.
//
// Nothing here logs, and no error thrown here carries an address, a token or
// a key: callers may show err.message to the person and log err.kind and
// err.status. Every request refuses redirects, so a credential never follows
// one somewhere else.
//
// SimpleFIN, from the protocol (https://www.simplefin.org/protocol.html,
// 2.0.0-draft of 2026-03-19) and the Bridge's developer page
// (https://beta-bridge.simplefin.org/info/developers):
//   - The Setup Token is a base64 claim URL. POST to it once; the body is the
//     Access URL, https://user:pass@host/path. A 403 means it was claimed
//     already or never existed, and the person must be told it may be
//     compromised.
//   - GET {access}/accounts?start-date=&end-date=&pending=1&balances-only=1
//     with Basic auth from the Access URL. 402 means payment required, 403
//     that access was revoked. Errors come in errlist ({code, msg, conn_id,
//     account_id}, version 2) or errors (display strings, version 1), and must
//     be shown to the person, cleaned first.
//   - The Bridge asks for 24 requests a day or fewer, 90 days per request,
//     at a random minute; its data updates daily.
//
// Lunch Flow Personal API, from its reference
// (https://www.lunchflow.app/docs/api/personal-api-overview and the pages under
// /docs/api/personal-api/) and Lunch Flow's own MCP server (@lunchflow/mcp,
// src/contracts/api-destination-contract.ts):
//   - Base https://www.lunchflow.app/api/v1 (lunchflow.app answers 308 to www,
//     checked 2026-10-11). The key goes in the x-api-key header: 401 when it
//     is missing, 403 when it is wrong.
//   - GET /accounts -> {accounts: [{id, name, institution_name, provider,
//     currency, status: ACTIVE | DISCONNECTED | ERROR}], total}
//   - GET /accounts/{id}/balance -> {balance: {amount, currency}}
//   - GET /accounts/{id}/transactions?include_pending=true&from=YYYY-MM-DD
//     -> {transactions: [{id, accountId, amount, currency, date, merchant,
//     description, isPending}], total}. Negative amounts are money out.
//     Pending rows come without an id. No rate limit is published.

const LUNCHFLOW_API = "https://www.lunchflow.app/api/v1";
const TIMEOUT_MS = 30000;

// kind: token | claimed | auth | payment | rate | missing | unavailable | invalid
class FeedError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// A display string from a provider, safe to show and to send: no control
// characters, one line, a sensible length.
function clean(value, max = 300) {
  const text = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

// Only public https addresses. Tests pass allowLocal to reach a mock on
// 127.0.0.1; nothing else does.
function publicUrl(value, allowLocal) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch (_) { return null; }
  const host = url.hostname.toLowerCase();
  if (allowLocal && url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost")) return url;
  if (url.protocol !== "https:") return null;
  if (!host.includes(".") || host.startsWith("[") || /(^|\.)(localhost|local|internal)$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  return url;
}

async function call(url, init, opts, provider) {
  const doFetch = opts.fetch || fetch;
  try {
    return await doFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS) });
  } catch (_) {
    throw new FeedError("unavailable", `Couldn't reach ${provider}.`, { status: 0 });
  }
}

function retryAfterMs(res) {
  const header = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function refused(res, provider) {
  if (res.status === 401 || res.status === 403) return new FeedError("auth", `${provider} refused access.`, { status: res.status });
  if (res.status === 402) return new FeedError("payment", `${provider} says the subscription needs paying.`, { status: 402 });
  if (res.status === 404) return new FeedError("missing", `${provider} no longer has that account.`, { status: 404 });
  if (res.status === 429) return new FeedError("rate", `${provider} asked Closedhand to slow down.`, { status: 429, retryAfterMs: retryAfterMs(res) });
  return new FeedError("unavailable", `${provider} isn't answering properly right now.`, { status: res.status });
}

async function json(res, provider) {
  try { return await res.json(); } catch (_) { throw new FeedError("invalid", `${provider} sent back something Closedhand couldn't read.`, { status: res.status }); }
}

const amount = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const epochDay = (s) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? isoDay(n * 1000) : null; };

// ---------------------------------------------------------------- SimpleFIN

function decodeSetupToken(token, opts = {}) {
  const raw = String(token || "").replace(/\s+/g, "");
  const bad = new FeedError("token", "That doesn't look like a SimpleFIN Setup Token.");
  if (!raw || raw.length > 4096 || !/^[A-Za-z0-9+/_-]+=*$/.test(raw)) throw bad;
  const text = Buffer.from(raw, "base64").toString("utf8").trim();
  const url = publicUrl(text, opts.allowLocal);
  if (!url || url.username || url.password) throw bad;
  return url.href;
}

// Claims the Setup Token. It works once, so this is never retried.
async function claimSimplefin(claimUrl, opts = {}) {
  const res = await call(claimUrl, { method: "POST", headers: { "Content-Length": "0" } }, opts, "SimpleFIN");
  if (res.status === 403) throw new FeedError("claimed", "SimpleFIN says this Setup Token was already used or doesn't exist.", { status: 403 });
  if (!res.ok) throw refused(res, "SimpleFIN");
  const access = (await res.text().catch(() => "")).trim();
  const url = publicUrl(access, opts.allowLocal);
  if (!url || !url.username || !url.password) throw new FeedError("invalid", "SimpleFIN sent back something Closedhand couldn't use.", { status: res.status });
  return url.href;
}

function parseSimplefin(body) {
  if (!body || !Array.isArray(body.accounts)) throw new FeedError("invalid", "SimpleFIN sent back something Closedhand couldn't read.");
  const connections = new Map((Array.isArray(body.connections) ? body.connections : []).map((c) => [String(c.conn_id), c]));
  const accounts = body.accounts.filter((a) => a && a.id != null).map((a) => {
    const conn = connections.get(String(a.conn_id));
    return {
      id: String(a.id),
      name: clean(a.name, 120) || "Account",
      institution: clean((a.org && a.org.name) || (conn && (conn.name || conn.org_name)) || "", 120),
      connId: a.conn_id != null ? String(a.conn_id) : null,
      currency: clean(a.currency, 60) || "USD",
      balance: amount(a.balance),
      available: amount(a["available-balance"]),
      asOf: epochDay(a["balance-date"]),
      transactions: (Array.isArray(a.transactions) ? a.transactions : []).filter((t) => t && t.id != null).map((t) => ({
        id: String(t.id),
        date: epochDay(t.posted) || epochDay(t.transacted_at),
        amount: amount(t.amount),
        payee: clean(t.payee, 160),
        description: clean(t.description, 300),
        memo: clean(t.memo, 300),
        pending: t.pending === true || Number(t.posted) === 0,
      })).filter((t) => t.date && t.amount !== null),
    };
  });
  const errors = [];
  const seen = new Set();
  for (const e of Array.isArray(body.errlist) ? body.errlist : []) {
    const message = clean(e && e.msg);
    if (!message || seen.has(message)) continue;
    seen.add(message);
    errors.push({ code: clean(e.code, 40), message, connId: e.conn_id != null ? String(e.conn_id) : null, accountId: e.account_id != null ? String(e.account_id) : null });
  }
  for (const e of Array.isArray(body.errors) ? body.errors : []) {
    const message = clean(e);
    if (!message || seen.has(message)) continue;
    seen.add(message);
    errors.push({ code: "", message, connId: null, accountId: null });
  }
  return { accounts, errors };
}

// One request for every account. start and end are Unix seconds.
async function simplefinAccounts(accessUrl, params = {}, opts = {}) {
  const url = publicUrl(accessUrl, opts.allowLocal);
  if (!url || !url.username) throw new FeedError("auth", "SimpleFIN refused access.", { status: 0 });
  const auth = "Basic " + Buffer.from(decodeURIComponent(url.username) + ":" + decodeURIComponent(url.password)).toString("base64");
  url.username = "";
  url.password = "";
  const query = new URLSearchParams();
  if (params.start) query.set("start-date", String(Math.floor(params.start)));
  if (params.end) query.set("end-date", String(Math.floor(params.end)));
  if (params.pending) query.set("pending", "1");
  if (params.balancesOnly) query.set("balances-only", "1");
  const address = url.href.replace(/\/+$/, "") + "/accounts" + (query.toString() ? "?" + query : "");
  const res = await call(address, { headers: { Authorization: auth, Accept: "application/json" } }, opts, "SimpleFIN");
  if (!res.ok) throw refused(res, "SimpleFIN");
  return parseSimplefin(await json(res, "SimpleFIN"));
}

// --------------------------------------------------------------- Lunch Flow

function validLunchflowKey(key) {
  return typeof key === "string" && /^[\x21-\x7e]{8,512}$/.test(key.trim());
}

async function lunchflowGet(apiKey, path, query, opts) {
  if (!validLunchflowKey(apiKey)) throw new FeedError("auth", "Lunch Flow refused access.", { status: 0 });
  const base = opts.lunchflowBase || LUNCHFLOW_API;
  const q = query && query.toString() ? "?" + query : "";
  const res = await call(base + path + q, { headers: { "x-api-key": apiKey.trim(), Accept: "application/json" } }, opts, "Lunch Flow");
  if (!res.ok) throw refused(res, "Lunch Flow");
  return json(res, "Lunch Flow");
}

async function lunchflowAccounts(apiKey, opts = {}) {
  const body = await lunchflowGet(apiKey, "/accounts", null, opts);
  if (!body || !Array.isArray(body.accounts)) throw new FeedError("invalid", "Lunch Flow sent back something Closedhand couldn't read.");
  return body.accounts.filter((a) => a && a.id != null).map((a) => ({
    id: String(a.id),
    name: clean(a.name, 120) || "Account",
    institution: clean(a.institution_name, 120),
    currency: clean(a.currency, 12) || null,
    status: clean(a.status, 20).toUpperCase() || null,
  }));
}

async function lunchflowBalance(apiKey, accountId, opts = {}) {
  const body = await lunchflowGet(apiKey, "/accounts/" + encodeURIComponent(accountId) + "/balance", null, opts);
  const b = body && body.balance;
  return b ? { amount: amount(b.amount), currency: clean(b.currency, 12) || null } : { amount: null, currency: null };
}

async function lunchflowTransactions(apiKey, accountId, params = {}, opts = {}) {
  const query = new URLSearchParams();
  if (params.includePending) query.set("include_pending", "true");
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  const body = await lunchflowGet(apiKey, "/accounts/" + encodeURIComponent(accountId) + "/transactions", query, opts);
  if (!body || !Array.isArray(body.transactions)) throw new FeedError("invalid", "Lunch Flow sent back something Closedhand couldn't read.");
  return body.transactions.filter(Boolean).map((t) => ({
    id: t.id != null && String(t.id).trim() ? String(t.id).trim() : null,
    date: /^\d{4}-\d{2}-\d{2}/.test(String(t.date || "")) ? String(t.date).slice(0, 10) : null,
    amount: amount(t.amount),
    currency: clean(t.currency, 12) || null,
    payee: clean(t.merchant, 160),
    description: clean(t.description, 300),
    memo: "",
    pending: t.isPending === true,
  })).filter((t) => t.date && t.amount !== null);
}

module.exports = {
  FeedError, clean, publicUrl, isoDay, LUNCHFLOW_API,
  decodeSetupToken, claimSimplefin, simplefinAccounts, parseSimplefin,
  validLunchflowKey, lunchflowAccounts, lunchflowBalance, lunchflowTransactions,
};
