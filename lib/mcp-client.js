// lib/mcp-client.js — one MCP client for every shape of server.
//
// Vendored: webapp/mcp-client.js must stay byte-identical (scripts/check-vendored-identical.js).
//
// A published MCP server is one of four things: a remote Streamable-HTTP
// endpoint, a remote endpoint on the older SSE transport, a command to run on
// this machine (npx, uvx, node, python), or any of those behind an API key or
// OAuth. This module turns a user_mcps row into a connected SDK client for all
// of them, discovers what the server offers (tools, resources, prompts), gives
// its tools names the model APIs accept, and renders results as text the
// model can read. It holds no state and touches no database: callers pass a
// row in and persist what comes back.

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { StdioClientTransport, getDefaultEnvironment } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");
const {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const CLIENT_INFO = { name: "ClosedHand", version: "1.0.0" };
const TOOL_PREFIX = "umcp_";
const MAX_TOOL_NAME = 64; // Anthropic and the OpenAI-compatible APIs agree on [a-zA-Z0-9_-]{1,64}

// stdio servers run on this machine, so only a self-host install can have
// them. The hosted bot is shared, and must never run a command a user typed.
function isSelfHost() {
  return process.env.DB_DRIVER === "pg" || (!!process.env.DATABASE_URL && !process.env.SUPABASE_URL);
}

// ---------------------------------------------------------------------------
// Parsing what the user pasted
// ---------------------------------------------------------------------------

const COMMAND_WORDS = /^(npx|uvx|uv|node|python3?|deno|bunx?|docker|pipx|cargo|java|dotnet|\.\/|\/)/i;

function splitArgs(line) {
  // Shell-style split: double and single quotes group, backslash escapes.
  const out = [];
  let cur = "", quote = null, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === "\\" && quote === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

function stdioAddress(command, args) {
  return "stdio:" + [command, ...(args || [])].join(" ");
}

function entryFromCommand(line) {
  const parts = splitArgs(line.trim());
  const env = {};
  while (parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])) {
    const [k, ...v] = parts.shift().split("=");
    env[k] = v.join("=");
  }
  if (!parts.length) return null;
  const command = parts.shift();
  return { transport: "stdio", command, args: parts, env, server_url: stdioAddress(command, parts) };
}

function entryFromConfig(name, cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const url = cfg.url || cfg.serverUrl || cfg.server_url || cfg.endpoint;
  if (url) {
    const type = String(cfg.type || cfg.transport || "").toLowerCase();
    return {
      name: name || null,
      transport: type === "sse" ? "sse" : "http",
      server_url: String(url).trim(),
      headers: cfg.headers && typeof cfg.headers === "object" ? cfg.headers : null,
    };
  }
  if (cfg.command) {
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    return {
      name: name || null,
      transport: "stdio",
      command: String(cfg.command),
      args,
      env: cfg.env && typeof cfg.env === "object" ? cfg.env : {},
      server_url: stdioAddress(String(cfg.command), args),
    };
  }
  return null;
}

// Accepts: an https URL, a bare command line ("npx -y @x/server"), a JSON
// block in any of the shapes READMEs publish ({"mcpServers": {...}}, a single
// {"command": ...} or {"url": ...}, or {"name": {...}}), or a skill link.
function parseServerInput(text) {
  const raw = String(text || "").trim();
  if (!raw) return { kind: "empty", entries: [] };

  if (/github\.com\/.*\/(skill|SKILL|claude-skill|awesome-claude)/i.test(raw) || /\.md$/i.test(raw) || /raw\.githubusercontent/i.test(raw)) {
    return { kind: "skill", entries: [], url: raw };
  }

  if (raw.startsWith("{") || (raw.startsWith('"') && /^"[^"]+"\s*:\s*\{/.test(raw))) {
    let obj;
    try { obj = JSON.parse(raw); } catch {
      // A block copied from a README often arrives as `"name": {...}` without
      // the outer braces, or with a trailing comma. Try the lenient reads.
      try { obj = JSON.parse("{" + raw.replace(/,\s*}$/, "}") + "}"); } catch { return { kind: "invalid", entries: [], error: "That JSON did not parse." }; }
    }
    const entries = [];
    const servers = obj.mcpServers || obj.servers || obj;
    if (servers.command || servers.url || servers.serverUrl) {
      const e = entryFromConfig(null, servers);
      if (e) entries.push(e);
    } else {
      for (const [name, cfg] of Object.entries(servers)) {
        const e = entryFromConfig(name, cfg);
        if (e) entries.push(e);
      }
    }
    return { kind: "json", entries };
  }

  if (/^https?:\/\//i.test(raw) && !/\s/.test(raw)) {
    return { kind: "url", entries: [{ transport: "http", server_url: raw }] };
  }

  if (COMMAND_WORDS.test(raw) || (/\s/.test(raw) && !/:\/\//.test(raw))) {
    const e = entryFromCommand(raw);
    return e ? { kind: "command", entries: [e] } : { kind: "invalid", entries: [], error: "That does not look like a command." };
  }

  // A bare hostname, most likely: treat it as https.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(raw)) {
    return { kind: "url", entries: [{ transport: "http", server_url: "https://" + raw }] };
  }
  return { kind: "invalid", entries: [], error: "Paste an MCP server URL, a command, a JSON block, or a skill link." };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function requestHeaders(row) {
  const headers = {};
  if (row.headers && typeof row.headers === "object") {
    for (const [k, v] of Object.entries(row.headers)) if (v != null) headers[k] = String(v);
  }
  if (row.auth_token && row.auth_type !== "oauth") {
    if (row.auth_type === "header") headers["x-api-key"] = row.auth_token;
    else if (row.auth_type && row.auth_type.startsWith("header:")) headers[row.auth_type.slice(7)] = row.auth_token;
    else headers["Authorization"] = "Bearer " + row.auth_token;
  }
  return headers;
}

// The SDK drives the whole OAuth dance (resource metadata, WWW-Authenticate,
// server metadata, dynamic registration, PKCE, refresh) through this
// interface. It reads and writes the row; io.save persists a patch, and
// io.onRedirect receives the authorisation URL the user has to visit.
function makeOAuthProvider(row, io) {
  return {
    get redirectUrl() { return io.redirectUrl; },
    get clientMetadata() {
      return {
        client_name: "ClosedHand",
        client_uri: "https://closedhand.com",
        redirect_uris: [io.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: row.oauth_client_secret ? "client_secret_post" : "none",
      };
    },
    state() { return io.state || crypto.randomBytes(16).toString("hex"); },
    clientInformation() {
      if (!row.oauth_client_id) return undefined;
      const info = { client_id: row.oauth_client_id };
      if (row.oauth_client_secret) info.client_secret = row.oauth_client_secret;
      return info;
    },
    async saveClientInformation(info) {
      row.oauth_client_id = info.client_id;
      row.oauth_client_secret = info.client_secret || null;
      await io.save({ oauth_client_id: row.oauth_client_id, oauth_client_secret: row.oauth_client_secret });
    },
    tokens() {
      if (!row.auth_token) return undefined;
      const t = { access_token: row.auth_token, token_type: "Bearer" };
      if (row.oauth_refresh_token) t.refresh_token = row.oauth_refresh_token;
      if (row.oauth_token_expiry) {
        const left = Math.floor((Number(row.oauth_token_expiry) - Date.now()) / 1000);
        t.expires_in = left > 0 ? left : 0;
      }
      if (row.oauth_scope) t.scope = row.oauth_scope;
      return t;
    },
    async saveTokens(t) {
      row.auth_token = t.access_token;
      if (t.refresh_token) row.oauth_refresh_token = t.refresh_token;
      row.oauth_token_expiry = t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null;
      if (t.scope) row.oauth_scope = t.scope;
      await io.save({
        auth_token: row.auth_token,
        auth_type: "oauth",
        oauth_refresh_token: row.oauth_refresh_token || null,
        oauth_token_expiry: row.oauth_token_expiry,
        oauth_scope: row.oauth_scope || null,
      });
    },
    redirectToAuthorization(url) {
      if (io.onRedirect) io.onRedirect(url.toString());
    },
    async saveCodeVerifier(v) {
      row.oauth_code_verifier = v;
      if (io.saveVerifier) await io.saveVerifier(v);
    },
    codeVerifier() {
      if (!row.oauth_code_verifier) throw new Error("No code verifier saved for this authorisation");
      return row.oauth_code_verifier;
    },
    async invalidateCredentials(scope) {
      if (scope === "all" || scope === "tokens") {
        row.auth_token = null; row.oauth_refresh_token = null; row.oauth_token_expiry = null;
        await io.save({ auth_token: null, oauth_refresh_token: null, oauth_token_expiry: null });
      }
      if (scope === "all" || scope === "client") {
        row.oauth_client_id = null; row.oauth_client_secret = null;
        await io.save({ oauth_client_id: null, oauth_client_secret: null });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Opening a client
// ---------------------------------------------------------------------------

function stdioWorkDir() {
  const base = process.env.STORAGE_DIR ? path.join(process.env.STORAGE_DIR, "mcp") : path.join(os.tmpdir(), "closedhand-mcp");
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* the spawn will say */ }
  return base;
}

// The child gets the SDK's scrubbed environment (PATH, HOME and the like,
// never this process's database URL or keys), the package caches so a
// restart does not re-download, and whatever the user set for this server.
function stdioEnv(row) {
  const env = { ...getDefaultEnvironment() };
  for (const k of ["npm_config_cache", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "XDG_CACHE_HOME", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  if (row.env && typeof row.env === "object") {
    for (const [k, v] of Object.entries(row.env)) if (v != null) env[k] = String(v);
  }
  return env;
}

function newClient() {
  return new Client(CLIENT_INFO, { capabilities: {} });
}

async function connectWith(transport, timeoutMs) {
  const client = newClient();
  let timer;
  const race = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Timed out connecting to the server"), { code: "ETIMEOUT" })), timeoutMs); });
  try {
    await Promise.race([client.connect(transport), race]);
  } catch (e) {
    try { await transport.close(); } catch { /* already gone */ }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return client;
}

function isAuthError(e) {
  if (e instanceof UnauthorizedError) return true;
  const m = String(e && e.message || "");
  // The SDK's own OAuth errors (a discovery page that was not JSON, a
  // registration the server refused) mean the same thing to the person:
  // this server wants credentials, and they have to supply them.
  return /\b401\b|unauthori[sz]ed|invalid oauth|oauth error|client registration|authorization server|invalid_client/i.test(m);
}

// Does the server publish OAuth metadata at all? Decides whether a 401 means
// "sign in through the service" or "paste a key".
async function oauthMetadataExists(serverUrl) {
  try {
    const origin = new URL(serverUrl).origin;
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      const r = await fetch(origin + p, { signal: AbortSignal.timeout(4000) }).catch(() => null);
      if (r && r.ok) { const t = await r.text(); if (t.trim().startsWith("{")) return true; }
    }
  } catch { /* not a URL */ }
  return false;
}

// A plain unauthenticated initialize, to learn whether the server wants
// credentials before handing the SDK an OAuth flow that may not apply.
async function probeAuth(serverUrl, headers) {
  try {
    const r = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: CLIENT_INFO } }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: r.status, wwwAuth: r.headers.get("www-authenticate") || "" };
  } catch { return null; }
}

// Returns { client, transport, transportKind, stderr }. Throws with
// err.needsAuth when the server wants OAuth and none has been granted yet.
async function openClient(row, io = {}) {
  const kind = row.transport || "http";

  if (kind === "stdio") {
    if (!isSelfHost()) throw Object.assign(new Error("Command-style servers run on your own machine. This install cannot start one."), { code: "ENOSTDIO" });
    if (!row.command) throw new Error("This connection has no command to run");
    const stderrChunks = [];
    const transport = new StdioClientTransport({
      command: row.command,
      args: Array.isArray(row.args) ? row.args : [],
      env: stdioEnv(row),
      cwd: stdioWorkDir(),
      stderr: "pipe",
    });
    // The first start of an npx or uvx server downloads the package, which
    // can take a while on a slow line; later starts come from the cache.
    const client = await connectWithStderr(transport, io.connectTimeoutMs || 180000, stderrChunks);
    return { client, transport, transportKind: "stdio", stderr: () => stderrChunks.join("").slice(-4000) };
  }

  const url = new URL(row.server_url);
  const headers = requestHeaders(row);
  let wantsOAuth = row.auth_type === "oauth";
  if (!wantsOAuth && io.oauth && !row.auth_token) {
    const probe = await probeAuth(row.server_url, headers);
    if (probe && (probe.status === 401 || probe.status === 403)) {
      if (/resource_metadata|bearer/i.test(probe.wwwAuth) || await oauthMetadataExists(row.server_url)) wantsOAuth = true;
      else throw Object.assign(new Error("This server wants a key"), { needsAuth: true, wantsKey: true });
    }
  }
  const authProvider = wantsOAuth ? makeOAuthProvider(row, io) : undefined;
  const opts = { requestInit: { headers } };
  if (authProvider) opts.authProvider = authProvider;
  const timeout = io.connectTimeoutMs || 20000;

  // Try the transport the row names first, then the other one. A server on
  // the older SSE transport answers a Streamable-HTTP POST with 404 or 405,
  // and a Streamable-HTTP server answers a GET /sse the same way, so one
  // failed attempt is the signal to try the other. Auth is different: the
  // server has been reached and wants a token, so stop and say so.
  const order = kind === "sse" ? ["sse", "http"] : ["http", "sse"];
  let firstErr = null;
  for (const t of order) {
    const transport = t === "sse" ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
    try {
      const client = await connectWith(transport, timeout);
      return { client, transport, transportKind: t, stderr: () => "" };
    } catch (e) {
      if (isAuthError(e)) throw Object.assign(e, { needsAuth: true });
      if (!firstErr) firstErr = e;
    }
  }
  throw firstErr || new Error("Could not connect");
}

async function connectWithStderr(transport, timeoutMs, chunks) {
  const client = newClient();
  let timer;
  const race = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Timed out starting the server"), { code: "ETIMEOUT" })), timeoutMs); });
  try {
    const p = client.connect(transport);
    if (transport.stderr) transport.stderr.on("data", (d) => { chunks.push(String(d)); if (chunks.length > 200) chunks.splice(0, chunks.length - 200); });
    await Promise.race([p, race]);
  } catch (e) {
    try { await transport.close(); } catch { /* already gone */ }
    // Say what happened in the child's words, not the protocol's: the first
    // line of its output that mentions an error is usually the one.
    const lines = chunks.join("").split("\n").map((l) => l.trim()).filter(Boolean);
    const hit = lines.find((l) => /error|not found|cannot|no such|denied|failed/i.test(l)) || lines[lines.length - 1] || "";
    let why = hit.replace(/^npm (error|ERR!)\s*/i, "").slice(0, 200);
    if (/\b404\b/.test(hit) && /npm/i.test(hit)) why = "no package by that name on npm";
    if (/closed|ETIMEOUT|Timed out/i.test(String(e.message))) e.message = "The server did not start" + (why ? ": " + why : "");
    else if (why) e.message = e.message + " (" + why + ")";
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function listAll(fn, key) {
  const out = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const page = await fn(cursor ? { cursor } : undefined);
    out.push(...(page[key] || []));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

async function discover(client) {
  const caps = client.getServerCapabilities() || {};
  const serverInfo = client.getServerVersion() || null;
  const found = { serverInfo, capabilities: caps, tools: [], resources: [], resourceTemplates: [], prompts: [] };
  if (caps.tools) {
    found.tools = (await listAll((p) => client.listTools(p, { timeout: 30000 }), "tools")).map((t) => ({
      name: t.name,
      title: t.title || (t.annotations && t.annotations.title) || null,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
      outputSchema: t.outputSchema || null,
      annotations: t.annotations || null,
    }));
  }
  if (caps.resources) {
    try { found.resources = await listAll((p) => client.listResources(p, { timeout: 30000 }), "resources"); } catch { /* optional */ }
    try { found.resourceTemplates = await listAll((p) => client.listResourceTemplates(p, { timeout: 30000 }), "resourceTemplates"); } catch { /* optional */ }
  }
  if (caps.prompts) {
    try { found.prompts = await listAll((p) => client.listPrompts(p, { timeout: 30000 }), "prompts"); } catch { /* optional */ }
  }
  return found;
}

// Ask to be told when the server's lists change; the caller marks its cache
// stale. Servers that do not send these are simply never heard from.
function watchChanges(client, onChange) {
  try { client.setNotificationHandler(ToolListChangedNotificationSchema, () => onChange("tools")); } catch { /* not supported */ }
  try { client.setNotificationHandler(ResourceListChangedNotificationSchema, () => onChange("resources")); } catch { /* not supported */ }
  try { client.setNotificationHandler(PromptListChangedNotificationSchema, () => onChange("prompts")); } catch { /* not supported */ }
}

// ---------------------------------------------------------------------------
// Naming tools for the model
// ---------------------------------------------------------------------------

function slugOf(name, max = 12) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max).replace(/_+$/g, "") || "mcp";
}

// One short slug per connection, unique within the install. Two connections
// that slug the same get the first four characters of their id appended.
function assignSlugs(rows) {
  const used = new Map();
  const out = new Map();
  for (const row of rows) {
    let slug = slugOf(row.name);
    if (used.has(slug)) slug = slug.slice(0, 7).replace(/_+$/g, "") + "_" + String(row.id || "").replace(/-/g, "").slice(0, 4);
    used.set(slug, row.id);
    out.set(row.id, slug);
  }
  return out;
}

function shortHash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 3);
}

// Model-facing names: umcp_<slug>_<tool>, only [a-zA-Z0-9_-], at most 64
// characters, unique within the server. A tool name too long to fit is cut
// and gets a short hash so two long names never collapse into one.
function modelToolNames(slug, tools) {
  const seen = new Set();
  return tools.map((t) => {
    const head = TOOL_PREFIX + slug + "_";
    let tail = String(t.name || "tool").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+/, "");
    const room = MAX_TOOL_NAME - head.length;
    if (tail.length > room) tail = tail.slice(0, Math.max(1, room - 4)) + "_" + shortHash(t.name);
    let name = head + tail;
    let n = 2;
    while (seen.has(name)) {
      const suffix = "_" + n++;
      name = (head + tail).slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
    }
    seen.add(name);
    return name;
  });
}

// ---------------------------------------------------------------------------
// Judging tools
// ---------------------------------------------------------------------------

const DESTRUCTIVE_NAME = /(^|[_\-.])(delete|remove|destroy|drop|purge|erase|wipe|reset|cancel|send|pay|transfer|charge|refund|publish|post|deploy|revoke|ban|kick|archive|merge|force)($|[_\-.])/i;

// Whether calling this tool should be put to the user first. The server's own
// annotations win where it gave any; a bare name is judged by its verb.
function isDestructive(tool) {
  const a = tool && tool.annotations;
  if (a) {
    if (a.readOnlyHint === true) return false;
    if (a.destructiveHint === true) return true;
    if (a.destructiveHint === false) return false;
  }
  return DESTRUCTIVE_NAME.test(String(tool && tool.name || ""));
}

// ---------------------------------------------------------------------------
// Rendering results for the model
// ---------------------------------------------------------------------------

const MAX_RESOURCE_TEXT = 20000;

function kb(n) { return Math.max(1, Math.round(n / 1024)) + " KB"; }

// Turns a tools/call result into text. Images go through opts.describeImages
// when a vision model is available, so the model gets a description rather
// than a wall of base64. Returns { text, isError }.
async function renderToolResult(result, opts = {}) {
  const parts = [];
  const images = [];
  for (const c of (result && result.content) || []) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text") parts.push(String(c.text || ""));
    else if (c.type === "image" && c.data) images.push({ mediaType: c.mimeType || "image/png", base64: c.data, slot: parts.push(null) - 1 });
    else if (c.type === "audio") parts.push(`[audio, ${c.mimeType || "unknown type"}, ${kb(Buffer.byteLength(String(c.data || ""), "base64"))}]`);
    else if (c.type === "resource" && c.resource) parts.push(renderResource(c.resource));
    else if (c.type === "resource_link") parts.push(`[link] ${c.name || c.uri}${c.description ? ": " + c.description : ""} (${c.uri})`);
    else parts.push(JSON.stringify(c).slice(0, 2000));
  }
  if (images.length) {
    let described = null;
    if (opts.describeImages) {
      try { described = await opts.describeImages(images.map((i) => ({ mediaType: i.mediaType, base64: i.base64 })), { detailed: true }); } catch { described = null; }
    }
    const lines = described ? String(described).split(/\n(?=\d+[.)]\s)/) : [];
    images.forEach((img, i) => {
      const bytes = Buffer.byteLength(img.base64, "base64");
      const d = described ? (images.length > 1 ? (lines[i] || described) : described) : null;
      parts[img.slot] = d ? `[Image ${images.length > 1 ? i + 1 + " " : ""}(${img.mediaType}, ${kb(bytes)}): ${String(d).trim()}]`
        : `[image, ${img.mediaType}, ${kb(bytes)}; no vision model is configured to read it]`;
    });
  }
  let text = parts.filter((p) => p != null && p !== "").join("\n");
  if (!text && result && result.structuredContent) text = JSON.stringify(result.structuredContent);
  else if (text && result && result.structuredContent && text.length < 200 && !text.startsWith("{") && !text.startsWith("[")) {
    text += "\n" + JSON.stringify(result.structuredContent);
  }
  if (!text) text = "(the tool returned nothing)";
  return { text, isError: !!(result && result.isError) };
}

function renderResource(r) {
  const head = `[resource ${r.uri}${r.mimeType ? ", " + r.mimeType : ""}]`;
  if (typeof r.text === "string") {
    const t = r.text.length > MAX_RESOURCE_TEXT ? r.text.slice(0, MAX_RESOURCE_TEXT) + `\n...[cut, ${r.text.length} chars in total]` : r.text;
    return head + "\n" + t;
  }
  if (r.blob) return head + ` binary, ${kb(Buffer.byteLength(String(r.blob), "base64"))}`;
  return head;
}

async function renderReadResource(result) {
  const parts = [];
  for (const r of (result && result.contents) || []) parts.push(renderResource(r));
  return parts.join("\n\n") || "(empty resource)";
}

function renderPrompt(result) {
  const lines = [];
  if (result && result.description) lines.push(result.description, "");
  for (const m of (result && result.messages) || []) {
    const c = m.content;
    const body = !c ? "" : c.type === "text" ? c.text : c.type === "resource" && c.resource ? renderResource(c.resource) : `[${c.type}]`;
    lines.push(`${m.role}: ${body}`);
  }
  return lines.join("\n");
}

async function closeQuietly(client, transport) {
  try { if (client) await client.close(); } catch { /* gone */ }
  try { if (transport) await transport.close(); } catch { /* gone */ }
}

module.exports = {
  isSelfHost,
  parseServerInput,
  splitArgs,
  stdioAddress,
  requestHeaders,
  makeOAuthProvider,
  openClient,
  discover,
  watchChanges,
  assignSlugs,
  slugOf,
  modelToolNames,
  isDestructive,
  renderToolResult,
  renderReadResource,
  renderPrompt,
  closeQuietly,
  isAuthError,
  oauthMetadataExists,
  UnauthorizedError,
  TOOL_PREFIX,
};
