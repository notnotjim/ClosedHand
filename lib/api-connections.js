// lib/api-connections.js: services connected with a key.
//
// A key pasted in the dashboard's Connections box, for a service with no MCP
// of its own, is saved as a connection like any other (user_mcps, transport
// "api", the key sealed in auth_token) with the one address it may go to and
// how to send it (webapp/api-finder.js finds both). Here the bot uses it:
// api_request with the connection's name sends the key, and only to that
// address, so nothing Closedhand reads can send the key anywhere else.
// api_endpoints looks up how to do something in the service's own API
// description, when it publishes one; otherwise Closedhand reads its docs.

const { hostOf, readApiDescription, searchEndpoints, requestFor } = require("./api-keys");

// userId -> { sig, list }
const _cache = new Map();
// description url -> { at, read }
const _described = new Map();
const DESCRIBED_MS = 6 * 60 * 60 * 1000;
const MAX_DESCRIPTION = 20 * 1024 * 1024;
const MAX_RESPONSE = 25 * 1024 * 1024;
const TIMEOUT_MS = 60000;

function db() { return require("./db").supabase; }

// The person's key connections, read fresh when one changed. Called once a
// turn, before the prompt is written.
async function load(userId, deps = {}) {
  if (!userId) return [];
  const { data, error } = await (deps.db || db()).from("user_mcps")
    .select("id, name, server_url, updated_at, status, caps, auth_token, transport")
    .eq("user_id", userId).eq("transport", "api");
  if (error) { console.error("[api-connections] list failed:", error.message); return list(userId); }
  const rows = (data || []).filter((r) => r.status === "connected" && r.caps?.api?.auth);
  const sig = rows.map((r) => `${r.id}|${r.updated_at}`).join(",");
  const had = _cache.get(userId);
  if (had && had.sig === sig) return had.list;
  const open = deps.openRow || require("./mcp-client").openRow;
  const out = [];
  for (const row of rows) {
    try {
      const r = open(row);
      if (!r.auth_token) continue;
      out.push({ id: r.id, name: r.name, base: String(r.server_url).replace(/\/+$/, ""), host: hostOf(r.server_url), auth: r.caps.api.auth, key: r.auth_token, description: r.caps.api.openapi || null, docs: r.caps.api.docs || null, endpoints: r.caps.api.endpoints || 0 });
    } catch (e) { console.error(`[api-connections] ${row.name}: ${e.message}`); }
  }
  _cache.set(userId, { sig, list: out });
  return out;
}

function list(userId) { return _cache.get(userId)?.list || []; }
function has(userId) { return list(userId).length > 0; }

function forService(userId, service) {
  const want = String(service || "").trim().toLowerCase();
  if (!want || want === "none") return null;
  return list(userId).find((c) => c.name.toLowerCase() === want) || null;
}

// For the prompt: what is connected, where, and how to use it. Never the key.
function promptLines(userId) {
  return list(userId).map((c) => `- ${c.name}: ${c.base}${c.endpoints ? ", with its endpoint list (api_endpoints)" : c.docs ? `, documentation at ${c.docs}` : ""}`);
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

const FILE_TYPES = /^(audio|video|image)\/|^application\/(pdf|zip|octet-stream|vnd\.)/i;
const EXT = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/opus": "opus", "audio/flac": "flac", "audio/mp4": "m4a", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "application/pdf": "pdf", "application/zip": "zip" };
// Headers the model may not set: the key's own, and ones that would change
// who is asking or where the request goes.
const KEPT = /^(authorization|cookie|host|proxy-authorization|content-length|x-forwarded-.*)$/i;

async function readCapped(res, cap) {
  const declared = Number(res.headers.get("content-length"));
  if (declared > cap) throw new Error(`the answer is larger than ${Math.round(cap / 1048576)} MB`);
  const parts = [];
  let size = 0;
  for await (const part of res.body) {
    size += part.length;
    if (size > cap) throw new Error(`the answer is larger than ${Math.round(cap / 1048576)} MB`);
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

function deliverToChat() {
  const ctx = require("./context");
  if (!ctx.activePlatform || !ctx.activeChatId) return null;
  return ({ buffer, mimeType, name }) => require("./messaging").sendDocument(ctx.activeChatId, buffer, name, mimeType, "connection");
}

// One request to the connection's own address, with its key. Anything else
// is refused before a byte is sent. Redirects are not followed, so the key
// can't be carried on to a second address either. Returns { status, type,
// buffer, said }, with said() the answer as text and the key taken out.
async function send(conn, { method = "GET", url, body = null, headers = {} }, deps = {}) {
  let u;
  try { u = new URL(String(url || "")); } catch { throw new Error(`Give the full address, starting ${conn.base}`); }
  if (u.protocol !== "https:" || u.host.toLowerCase() !== conn.host || u.username || u.password) {
    throw new Error(`The ${conn.name} key is only ever sent to ${conn.host}. Use an address starting ${conn.base}`);
  }
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (KEPT.test(k) || k.toLowerCase() === String(conn.auth.name).toLowerCase()) continue;
    out[k] = String(v);
  }
  if (conn.auth.in === "query") u.searchParams.set(conn.auth.name, conn.key);
  else out[conn.auth.name] = (conn.auth.prefix || "") + conn.key;
  const m = String(method).toUpperCase();
  let payload;
  if (body != null && m !== "GET") {
    // A form sets its own type, with the boundary between its parts.
    payload = typeof body === "string" || body instanceof FormData ? body : JSON.stringify(body);
    if (!(body instanceof FormData) && !Object.keys(out).some((k) => k.toLowerCase() === "content-type")) out["Content-Type"] = "application/json";
  }
  if (!Object.keys(out).some((k) => k.toLowerCase() === "accept")) out.Accept = "application/json, */*";
  const res = await (deps.fetch || fetch)(u.toString(), { method: m, headers: out, body: payload, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (res.status >= 300 && res.status < 400) throw new Error(`${conn.name} answered with a move to another address (${res.status}), which Closedhand doesn't follow with the key`);
  const buffer = await readCapped(res, MAX_RESPONSE);
  // Some services repeat the key back, in an error most of all.
  const said = () => buffer.toString("utf8").split(conn.key).join("[key]");
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${conn.name} refused the key (${res.status}): ${said().slice(0, 300)}. If it was replaced or removed, paste a new one under Connections on the dashboard.`);
  }
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${said().slice(0, 500)}`);
  return { status: res.status, type, buffer, said };
}

// api_request for a key connection: JSON comes back parsed, and a file goes
// to the chat the request came from.
async function request(conn, req, deps = {}) {
  const { status, type, buffer, said } = await send(conn, req, deps);
  if (FILE_TYPES.test(type)) {
    const name = `${conn.name.replace(/[^\w.-]+/g, "-").toLowerCase()}-${Date.now()}.${EXT[type] || "bin"}`;
    const deliver = deps.deliver === undefined ? deliverToChat() : deps.deliver;
    if (deliver) {
      await deliver({ buffer, mimeType: type, name });
      return { file_sent: name, type, bytes: buffer.length, note: "Sent to the person in this chat. Don't send it again." };
    }
    return { file_received: type, bytes: buffer.length, note: "A file came back, and there's no chat here to send it to." };
  }
  const text = said();
  if (/json/.test(type) || /^[\s]*[[{]/.test(text)) { try { return JSON.parse(text); } catch { /* not JSON after all */ } }
  return { status, text };
}

// One endpoint called by Closedhand itself, by its name ("POST /v1/speech"),
// for the connection's voice (lib/voice-connections.js). The answer comes
// back in the shape a connected MCP tool's does: sound as audio, anything
// else as text.
async function callEndpoint(userId, rowId, name, args, deps = {}) {
  const conn = (await load(userId, deps)).find((c) => c.id === rowId);
  if (!conn) throw new Error("that connection isn't working right now");
  const read = await described(conn, deps);
  const e = read && read.endpoints.find((x) => `${x.method} ${x.path}` === name);
  if (!e) throw new Error(`${conn.name} no longer lists ${name}`);
  const audio = Object.values(args || {}).find((v) => Buffer.isBuffer(v));
  const ext = audio ? ({ "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/webm": "webm" })[require("./voice-connections").sniff(audio)] || "ogg" : undefined;
  const { type, buffer, said } = await send(conn, requestFor(e, read.base, { ...args, _fileExt: ext }), deps);
  if (/^audio\//.test(type) || (type === "application/octet-stream" && require("./voice-connections").sniff(buffer))) {
    return { content: [{ type: "audio", data: buffer.toString("base64"), mimeType: type }] };
  }
  return { content: [{ type: "text", text: said() }] };
}

// ---------------------------------------------------------------------------
// Finding endpoints
// ---------------------------------------------------------------------------

async function described(conn, deps = {}) {
  const url = conn.description;
  if (!url) return null;
  const had = _described.get(url);
  if (had && Date.now() - had.at < DESCRIBED_MS) return had.read;
  const res = await (deps.fetch || fetch)(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`its API description didn't load (${res.status})`);
  const read = readApiDescription(JSON.parse((await readCapped(res, MAX_DESCRIPTION)).toString("utf8")), conn.base);
  if (!read) throw new Error("its API description no longer describes this address");
  _described.set(url, { at: Date.now(), read });
  return read;
}

function describeEndpoint(e, base) {
  return {
    call: `${e.method} ${base}${e.path}`,
    does: e.summary + (e.about && e.about !== e.summary ? `. ${e.about}` : ""),
    parameters: e.params.map((p) => `${p.name} (${p.in}${p.required ? ", required" : ""}, ${p.type})${p.about ? ": " + p.about : ""}`),
    ...(e.body ? { body: `${e.body.kind}: ` + e.body.fields.map((f) => `${f.name}${f.required ? " (required)" : ""}: ${f.type}${f.about ? ", " + f.about : ""}`).join("; ") } : {}),
    ...(e.returns ? { returns: e.returns } : {}),
  };
}

async function endpoints(conn, what, deps = {}) {
  const tail = "Call it with api_request: method and full address as given, service set to " + JSON.stringify(conn.name) + ", body as JSON. The key is added for you; never put it in yourself.";
  if (!conn.description) {
    return conn.docs
      ? { service: conn.name, docs: conn.docs, note: `${conn.name} publishes no endpoint list. Read its documentation with web_fetch to find the endpoint. ${tail}` }
      : { service: conn.name, note: `${conn.name} publishes no endpoint list. Search the web for its API documentation, read it with web_fetch, then call it. ${tail}` };
  }
  let read;
  try { read = await described(conn, deps); }
  catch (e) { return { service: conn.name, error: `Couldn't read ${conn.name}'s endpoint list: ${e.message}.`, ...(conn.docs ? { docs: conn.docs } : {}) }; }
  const found = searchEndpoints(read.endpoints, what);
  if (!found.length) return { service: conn.name, note: `Nothing in ${conn.name}'s ${read.endpoints.length} endpoints matched. Try other words for it.` };
  return { service: conn.name, endpoints: found.map((e) => describeEndpoint(e, read.base)), note: tail };
}

module.exports = { load, list, has, forService, promptLines, request, callEndpoint, endpoints };
