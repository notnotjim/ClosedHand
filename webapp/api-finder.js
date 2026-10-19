// webapp/api-finder.js: where a service's API is, and how its key is sent.
//
// A key pasted in the Connections box, for a service with no MCP of its own,
// connects through the service's plain API (lib/api-connections.js uses it).
// This works out the API's address and how the key goes with each request.
// The person's own model names them, as it knows the public APIs of known
// services; the service's published API description (OpenAPI), when there is
// one, then corrects both and lists the endpoints. The address is shown to
// the person before the key goes anywhere, and the key is only ever sent
// there.

const { readApiDescription, searchEndpoints, endpointTool, hostOf } = require("./api-keys");
const { isBlockedUrl } = require("./ssrf");

const MAX_DESCRIPTION = 20 * 1024 * 1024;

const REPORT = {
  name: "report_api",
  description: "Report the official API of the named service.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "False when the service has no public API that takes a key, or you aren't sure of it." },
      name: { type: "string", description: "The service's usual name, as the company writes it." },
      api_base_url: { type: "string", description: "The address every endpoint starts with, as the documentation gives it, e.g. https://api.example.com/v1" },
      key_sent_as: { type: "string", enum: ["bearer", "header", "query"], description: "bearer: an Authorization: Bearer header. header: a header of its own. query: a parameter in the address." },
      key_name: { type: "string", description: "The header or parameter name, for header or query." },
      openapi_url: { type: "string", description: "The address of its OpenAPI (Swagger) description in JSON, only if you know it exists." },
      docs_url: { type: "string", description: "The address of its API documentation." },
      check_path: { type: "string", description: "A GET path, after the base address, that needs nothing but the key and says whose it is, such as the account or current user. Empty if you don't know one." },
      more_than_a_key: { type: "boolean", description: "True when each request needs more than the key, such as request signing or a second secret." },
    },
    required: ["found"],
  },
};

const SYSTEM = "You know the public APIs of well-known services. Someone has pasted a key for a service into Closedhand, their personal assistant, and wants it connected. Report the service's own official API, only addresses on the company's own domains, exactly as its documentation gives them. Never guess an address: if you aren't sure, leave it empty, and set found to false when you don't know the API. Report only with the report_api tool.";

function publicHttps(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "https:" && !u.username && !u.password && !isBlockedUrl(u.toString()) ? u : null;
  } catch { return null; }
}

// A header name a request may carry, and none that changes where it goes or
// whose session it is.
function headerOk(name) {
  return /^[A-Za-z0-9-]{1,64}$/.test(name) && !/^(host|cookie|content-length|content-type|connection|transfer-encoding|proxy-.*|x-forwarded-.*)$/i.test(name);
}

async function readDescription(url, fetcher) {
  const res = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  if (Number(res.headers.get("content-length")) > MAX_DESCRIPTION) return null;
  const parts = [];
  let size = 0;
  for await (const part of res.body) {
    size += part.length;
    if (size > MAX_DESCRIPTION) return null;
    parts.push(Buffer.from(part));
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return null; }
}

// service: what the person called it. selected: their model (model-policy
// getRole). Returns { found: false, why } or { found: true, service, base,
// auth, openapi, docs, endpoints, check }.
async function findApi(service, selected, deps = {}) {
  const name = String(service || "").trim().slice(0, 80);
  if (!name) return { found: false, why: "Say which service the key is for." };
  if (!selected) return { found: false, why: "Closedhand needs its AI set up under Models before it can work out a service's API." };
  const request = deps.request || require("./model-wire").request;
  const fetcher = deps.fetch || fetch;
  let report;
  try {
    const response = await request(selected, {
      model: selected.model, effort: "fast", system: SYSTEM, max_tokens: 1024,
      messages: [{ role: "user", content: `The service: ${name}` }],
      tools: [REPORT], tool_choice: { type: "tool", name: REPORT.name },
    }, { signal: AbortSignal.timeout(45000) });
    report = response.content?.find((b) => b.type === "tool_use" && b.name === REPORT.name)?.input || null;
  } catch (e) {
    console.log("[api-finder] could not ask: " + e.message);
    return { found: false, why: "Closedhand couldn't work that out just now. Try again in a moment." };
  }
  const called = String(report?.name || name).trim().slice(0, 60) || name;
  // A name typed a bit off ("elevn labs") comes back spelled right but often
  // unanswered, so it's asked once more by its proper name.
  const plain = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (report?.found !== true && plain(called) !== plain(name) && !deps.retried) return findApi(called, selected, { ...deps, retried: true });
  if (!report || report.found !== true) return { found: false, why: `Closedhand doesn't know an API for ${called} that works with a key.` };
  if (report.more_than_a_key) return { found: false, why: `${called} needs more than a key on each request, so it can't be connected with a key alone. Use its own sign-in under Apps, if it has one.` };
  const baseUrl = publicHttps(report.api_base_url);
  if (!baseUrl) return { found: false, why: `Closedhand couldn't find where ${called}'s API is.` };
  let base = (baseUrl.origin + baseUrl.pathname).replace(/\/+$/, "");

  let auth = report.key_sent_as === "bearer" ? { in: "header", name: "Authorization", prefix: "Bearer " }
    : (report.key_sent_as === "header" || report.key_sent_as === "query") && report.key_name ? { in: report.key_sent_as, name: String(report.key_name).trim() }
    : null;

  // The service's own description, where the model named one or where APIs
  // usually keep it, outranks the model on how the key is sent.
  let openapi = null;
  let endpoints = [];
  const tries = [publicHttps(report.openapi_url), publicHttps(`${baseUrl.origin}/openapi.json`)].filter(Boolean).map(String);
  for (const url of [...new Set(tries)]) {
    const spec = await readDescription(url, fetcher).catch(() => null);
    const read = spec && readApiDescription(spec, base);
    if (!read || !read.endpoints.length) continue;
    openapi = url;
    base = read.base;
    endpoints = read.endpoints;
    if (read.auth) auth = read.auth;
    break;
  }
  if (!auth || (auth.in === "header" && !headerOk(auth.name)) || !/^[A-Za-z0-9_.-]{1,64}$/.test(auth.name)) {
    return { found: false, why: `Closedhand couldn't tell how ${called}'s API takes a key.` };
  }

  // A request that needs nothing but the key says whether the key works.
  let check = null;
  const asked = String(report.check_path || "").trim();
  if (/^\/[A-Za-z0-9/_.-]*$/.test(asked) && !asked.includes("..")) {
    if (!endpoints.length || endpoints.some((e) => e.method === "GET" && e.path === asked && !e.params.some((p) => p.required))) check = asked;
  }
  if (!check && endpoints.length) {
    const plain = endpoints.filter((e) => e.method === "GET" && !e.path.includes("{") && !e.params.some((p) => p.required));
    check = (plain.find((e) => /\/(me|user|users\/me|account|whoami|profile)$/i.test(e.path)) || {}).path || null;
  }

  const docs = publicHttps(report.docs_url);
  return {
    found: true,
    service: called,
    base,
    auth,
    openapi,
    docs: docs ? docs.toString() : null,
    endpoints: endpoints.length,
    list: endpoints,
    check,
  };
}

// A saved connection's endpoints, read again from its description.
async function describe(url, base, deps = {}) {
  const spec = await readDescription(url, deps.fetch || fetch);
  const read = spec && readApiDescription(spec, base);
  return read ? read.endpoints : [];
}

// One GET to the API's own address with the key, for a listing the voice
// needs (its voices, say). Nothing follows a redirect.
async function getWithKey(plan, key, path, deps = {}) {
  const u = new URL(plan.base + path);
  if (hostOf(u.toString()) !== hostOf(plan.base) || u.protocol !== "https:") return null;
  const headers = { Accept: "application/json" };
  if (plan.auth.in === "query") u.searchParams.set(plan.auth.name, key);
  else headers[plan.auth.name] = (plan.auth.prefix || "") + key;
  const res = await (deps.fetch || fetch)(u.toString(), { headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (res.status < 200 || res.status >= 300) return null;
  return JSON.parse(await res.text());
}

// The first list of things in a listing that carry arg: its values and names.
function itemsWith(json, arg) {
  const queue = [json];
  for (let n = 0; queue.length && n < 500; n++) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      const items = node.filter((x) => x && typeof x === "object" && typeof x[arg] === "string");
      if (items.length) return items;
      queue.push(...node.slice(0, 50));
    } else if (node && typeof node === "object") queue.push(...Object.values(node));
  }
  return [];
}

// What a service connected with a key can do in Closedhand's place, as for an
// MCP connection (webapp/connection-jobs.js), from the endpoints most likely
// to: speak, write out speech, list voices, and each other job. An id the
// speech needs from the person's own account (a voice, say) is picked from
// the service's own list: the one picked before, else the one its
// documentation gives as the example, else the first. Returns { voice, jobs }
// as saved in caps.
async function jobsFor(plan, key, selected, previousCaps, deps = {}) {
  const jobs = require("./connection-jobs");
  const keep = { voice: previousCaps?.voice || null, jobs: previousCaps?.jobs || {} };
  if (!plan.list || !plan.list.length) return keep;
  const likely = new Map();
  const asks = ["text to speech", "speech to text transcription", "list voices", ...Object.values(jobs.TOOL_JOBS).map((j) => j.findWith)];
  for (const q of asks) for (const e of searchEndpoints(plan.list, q, 6)) likely.set(`${e.method} ${e.path}`, e);
  const tools = [...likely.values()].map(endpointTool);
  const found = await jobs.findJobs(tools, selected, deps);
  for (const job of ["speak", "hear"]) {
    const p = found.voice && found.voice[job];
    if (!p || !p.choose) continue;
    const from = likely.get(p.choose.from);
    const items = from ? itemsWith(await getWithKey(plan, key, from.path, deps).catch(() => null), p.choose.arg) : [];
    const examples = tools.find((t) => t.name === p.tool)?.inputSchema?.properties?.[p.choose.arg]?.examples || [];
    const want = [previousCaps?.voice?.[job]?.chosen?.value, ...examples].filter(Boolean);
    const item = want.map((v) => items.find((x) => x[p.choose.arg] === v)).find(Boolean) || items[0];
    if (!item) { found.voice[job] = null; continue; }
    p.fixed = { ...p.fixed, [p.choose.arg]: item[p.choose.arg] };
    p.chosen = { arg: p.choose.arg, value: item[p.choose.arg], name: typeof item.name === "string" ? item.name.slice(0, 60) : null };
  }
  if (found.voice && !found.voice.speak && !found.voice.hear) found.voice = null;
  return jobs.saved(found, previousCaps?.voice, previousCaps?.jobs);
}

// A service saying the key itself is wrong, whatever status it picks for it:
// ElevenLabs answers a bad key with a 400 and "invalid_api_key".
const BAD_KEY = /invalid[\s_-]*(?:api[\s_-]*)?(?:key|token|credentials)|(?:api[\s_-]*)?key[\s_-]*(?:is[\s_-]*)?(?:invalid|not[\s_-]*valid|revoked|expired)|authentication[\s_-]*(?:error|failed)/i;

// Whether the service takes the key: { ok: true }, { ok: false } when it
// refused it, or { ok: null } when it couldn't be told. A 403 alone is not
// a refusal: a key limited to some parts of an API gets one for the rest.
// Nothing follows a redirect, so the key goes nowhere but the API's own
// address.
async function testKey(plan, key, deps = {}) {
  if (!plan.check) return { ok: null };
  const fetcher = deps.fetch || fetch;
  const u = new URL(plan.base + plan.check);
  if (hostOf(u.toString()) !== hostOf(plan.base) || u.protocol !== "https:") return { ok: null };
  const headers = { Accept: "application/json" };
  if (plan.auth.in === "query") u.searchParams.set(plan.auth.name, key);
  else headers[plan.auth.name] = (plan.auth.prefix || "") + key;
  try {
    const res = await fetcher(u.toString(), { headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 401) return { ok: false };
    if (res.status === 400 || res.status === 403) {
      const said = await res.text().catch(() => "");
      if (BAD_KEY.test(said.slice(0, 4000))) return { ok: false };
    }
    return { ok: null };
  } catch { return { ok: null }; }
}

module.exports = { findApi, testKey, describe, jobsFor, REPORT };
