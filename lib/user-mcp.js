// lib/user-mcp.js - The user's MCP connections, live in the bot.
//
// Every shape of server (remote Streamable HTTP, legacy SSE, a command run on
// this machine, with or without a key or OAuth) is opened through
// lib/mcp-client.js. This module owns the cache: one open client per
// connection, revalidated against the database on every turn with a single
// small query, so a connection added or removed in the dashboard takes
// effect on the next message rather than after a timer. Command-style
// servers stay running between turns and are stopped after half an hour idle.

const { supabase } = require("./db");
const mcp = require("./mcp-client");

// userId -> Map<rowId, entry>
// entry: { row, sig, client, transport, transportKind, tools, prompts, resources, slug, stale, lastUsed, stderr }
const _cache = new Map();
const IDLE_MS = 30 * 60 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;

async function dbUpdate(id, patch) {
  const { error } = await supabase.from("user_mcps").update(patch).eq("id", id);
  if (error) console.error("[user-mcp] update failed:", error.message);
}

function describeImages(images, opts) {
  try { return require("./services/usi").describeImages(images, opts); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

async function openEntry(row, slug) {
  const io = {
    save: (patch) => dbUpdate(row.id, patch),
    connectTimeoutMs: row.transport === "stdio" ? 180000 : 20000,
  };
  const { client, transport, transportKind, stderr } = await mcp.openClient(row, io);
  const found = await mcp.discover(client);
  const names = mcp.modelToolNames(slug, found.tools);
  const tools = found.tools.map((t, i) => ({
    ...t,
    originalName: t.name,
    name: names[i],
    _rowId: row.id,
    _server: row.name,
  }));
  const entry = {
    row, slug, client, transport, transportKind, stderr,
    tools,
    prompts: found.prompts,
    resources: found.resources,
    resourceTemplates: found.resourceTemplates,
    serverInfo: found.serverInfo,
    capabilities: found.capabilities,
    stale: false,
    lastUsed: Date.now(),
  };
  mcp.watchChanges(client, (what) => { entry.stale = true; console.log(`[user-mcp] ${row.name}: ${what} changed`); });
  transport.onclose = () => { entry.client = null; };
  transport.onerror = (e) => { console.error(`[user-mcp] ${row.name} transport error:`, e && e.message); };

  const patch = {
    tools_discovered: found.tools.map((t) => t.name),
    prompts_discovered: found.prompts.map((p) => ({ name: p.name, description: p.description || "" })),
    caps: {
      tools: found.tools.length,
      resources: found.resources.length + found.resourceTemplates.length,
      prompts: found.prompts.length,
      server: found.serverInfo ? { name: found.serverInfo.name, version: found.serverInfo.version } : null,
    },
  };
  if (transportKind !== (row.transport || "http") && transportKind !== "stdio") patch.transport = transportKind;
  if (row.status !== "connected") patch.status = "connected";
  await dbUpdate(row.id, patch);
  return entry;
}

async function closeEntry(entry) {
  if (!entry) return;
  await mcp.closeQuietly(entry.client, entry.transport);
  entry.client = null;
}

async function refreshLists(entry) {
  if (!entry.client) return;
  try {
    const found = await mcp.discover(entry.client);
    const names = mcp.modelToolNames(entry.slug, found.tools);
    entry.tools = found.tools.map((t, i) => ({ ...t, originalName: t.name, name: names[i], _rowId: entry.row.id, _server: entry.row.name }));
    entry.prompts = found.prompts;
    entry.resources = found.resources;
    entry.resourceTemplates = found.resourceTemplates;
    entry.stale = false;
    await dbUpdate(entry.row.id, {
      tools_discovered: found.tools.map((t) => t.name),
      prompts_discovered: found.prompts.map((p) => ({ name: p.name, description: p.description || "" })),
    });
  } catch (e) {
    console.error(`[user-mcp] ${entry.row.name}: refresh failed:`, e.message);
  }
}

// ---------------------------------------------------------------------------
// The cache, revalidated per turn
// ---------------------------------------------------------------------------

// Loads and caches a user's MCP tools. One small query says which
// connections exist and when each last changed; only the ones that are new
// or changed are (re)opened, and ones that vanished are closed.
async function getUserMcpTools(userId) {
  if (!userId) return [];
  const { data: rows, error } = await supabase
    .from("user_mcps")
    .select("id, name, updated_at, status, transport")
    .eq("user_id", userId)
    .eq("status", "connected");
  if (error) { console.error("[user-mcp] list failed:", error.message); return cachedTools(userId); }

  const userCache = _cache.get(userId) || new Map();
  _cache.set(userId, userCache);

  const live = new Set((rows || []).map((r) => r.id));
  for (const [id, entry] of userCache) {
    if (!live.has(id)) { await closeEntry(entry); userCache.delete(id); }
  }

  const slugs = mcp.assignSlugs(rows || []);
  const toOpen = [];
  for (const r of rows || []) {
    const sig = `${r.updated_at || ""}|${r.name}`;
    const entry = userCache.get(r.id);
    if (entry && entry.sig === sig && entry.client) {
      if (entry.stale) await refreshLists(entry);
      continue;
    }
    toOpen.push({ r, sig });
  }

  if (toOpen.length) {
    const { data: full, error: e2 } = await supabase
      .from("user_mcps")
      .select("*")
      .in("id", toOpen.map((x) => x.r.id));
    if (e2) console.error("[user-mcp] load failed:", e2.message);
    await Promise.all((full || []).map(async (row) => {
      const sig = toOpen.find((x) => x.r.id === row.id).sig;
      const old = userCache.get(row.id);
      if (old) await closeEntry(old);
      try {
        const entry = await openEntry(row, slugs.get(row.id));
        entry.sig = sig;
        userCache.set(row.id, entry);
        console.log(`[user-mcp] ${row.name}: ${entry.tools.length} tools, ${entry.prompts.length} prompts, ${entry.resources.length} resources (${entry.transportKind})`);
      } catch (e) {
        userCache.delete(row.id);
        console.error(`[user-mcp] ${row.name}: ${e.message}`);
        // Auth that lapsed needs the person; anything else may clear on the
        // next attempt, which the dashboard's Test and Fix buttons trigger.
        await dbUpdate(row.id, { status: e.needsAuth ? "needs_auth" : "error" });
      }
    }));
  }

  return cachedTools(userId);
}

function cachedTools(userId) {
  const userCache = _cache.get(userId);
  if (!userCache) return [];
  const out = [];
  for (const entry of userCache.values()) out.push(...entry.tools);
  return out;
}

function findTool(userId, toolName) {
  const userCache = _cache.get(userId);
  if (!userCache) return null;
  for (const entry of userCache.values()) {
    const tool = entry.tools.find((t) => t.name === toolName);
    if (tool) return { tool, entry };
  }
  return null;
}

function findEntryByServer(userId, serverName) {
  const userCache = _cache.get(userId);
  if (!userCache) return null;
  const want = String(serverName || "").toLowerCase().trim();
  for (const entry of userCache.values()) {
    if (entry.row.name.toLowerCase() === want || entry.slug === want || entry.row.id === want) return entry;
  }
  for (const entry of userCache.values()) {
    if (entry.row.name.toLowerCase().includes(want) || entry.slug.includes(mcp.slugOf(want))) return entry;
  }
  return null;
}

async function ensureOpen(entry) {
  if (entry.client) return entry;
  const fresh = await openEntry(entry.row, entry.slug);
  Object.assign(entry, fresh);
  return entry;
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

async function callUserMcpTool(userId, toolName, toolInput) {
  const hit = findTool(userId, toolName);
  if (!hit) throw new Error(`MCP tool '${toolName}' not found`);
  const { tool, entry } = hit;
  await ensureOpen(entry);
  entry.lastUsed = Date.now();

  const args = {};
  for (const [k, v] of Object.entries(toolInput || {})) if (!k.startsWith("_")) args[k] = v;

  let result;
  try {
    result = await entry.client.callTool({ name: tool.originalName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  } catch (e) {
    if (mcp.isAuthError(e)) {
      await dbUpdate(entry.row.id, { status: "needs_auth" });
      await closeEntry(entry);
      throw new Error(`${entry.row.name} needs authorising again. Open the dashboard, find it under connections, and reconnect.`);
    }
    // A dropped session (server restarted, stdio process died) is worth one
    // reopen before giving up.
    if (/closed|not connected|ECONNRESET|EPIPE|session/i.test(String(e.message || ""))) {
      await closeEntry(entry);
      await ensureOpen(entry);
      result = await entry.client.callTool({ name: tool.originalName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    } else {
      throw e;
    }
  }
  const rendered = await mcp.renderToolResult(result, { describeImages });
  if (rendered.isError) throw new Error(rendered.text);
  return rendered.text;
}

async function listUserMcpResources(userId, serverName) {
  const entry = findEntryByServer(userId, serverName);
  if (!entry) throw new Error(`No connected server called '${serverName}'`);
  await ensureOpen(entry);
  if (entry.stale) await refreshLists(entry);
  return {
    server: entry.row.name,
    resources: entry.resources.map((r) => ({ uri: r.uri, name: r.name, description: r.description || "", mimeType: r.mimeType || null })),
    templates: entry.resourceTemplates.map((r) => ({ uriTemplate: r.uriTemplate, name: r.name, description: r.description || "" })),
  };
}

async function readUserMcpResource(userId, serverName, uri) {
  const entry = findEntryByServer(userId, serverName);
  if (!entry) throw new Error(`No connected server called '${serverName}'`);
  await ensureOpen(entry);
  entry.lastUsed = Date.now();
  const result = await entry.client.readResource({ uri }, { timeout: CALL_TIMEOUT_MS });
  return mcp.renderReadResource(result);
}

async function getUserMcpPrompt(userId, serverName, promptName, args) {
  const entry = findEntryByServer(userId, serverName);
  if (!entry) throw new Error(`No connected server called '${serverName}'`);
  await ensureOpen(entry);
  entry.lastUsed = Date.now();
  const strArgs = {};
  for (const [k, v] of Object.entries(args || {})) strArgs[k] = typeof v === "string" ? v : JSON.stringify(v);
  const result = await entry.client.getPrompt({ name: promptName, arguments: strArgs }, { timeout: CALL_TIMEOUT_MS });
  return mcp.renderPrompt(result);
}

// ---------------------------------------------------------------------------
// What the model sees
// ---------------------------------------------------------------------------

function isUserMcpTool(toolName) {
  return typeof toolName === "string" && toolName.startsWith(mcp.TOOL_PREFIX);
}

function getUserMcpToolDefs(userId) {
  const userCache = _cache.get(userId);
  if (!userCache) return [];
  const defs = [];
  for (const entry of userCache.values()) {
    for (const tool of entry.tools) {
      defs.push({
        name: tool.name,
        description: (tool.description || tool.title || "") + (entry.row.name ? ` (${entry.row.name})` : ""),
        input_schema: tool.inputSchema || { type: "object", properties: {} },
      });
    }
  }
  return defs;
}

// The server and action behind a model-facing name, for wording a question.
function describeUserMcpTool(userId, toolName) {
  const hit = findTool(userId, toolName);
  if (!hit) return { server: null, action: toolName };
  return { server: hit.entry.row.name, action: hit.tool.title || hit.tool.originalName };
}

// Whether a call to this tool should be put to the user before it runs.
function needsMcpConfirmation(userId, toolName) {
  const hit = findTool(userId, toolName);
  return !!(hit && mcp.isDestructive(hit.tool));
}

// Servers that publish prompts and resources are listed for the model so it
// knows to reach for mcp_prompt and mcp_resources.
function getUserMcpExtras(userId) {
  const userCache = _cache.get(userId);
  if (!userCache) return [];
  const out = [];
  for (const entry of userCache.values()) {
    if (!entry.prompts.length && !entry.resources.length && !entry.resourceTemplates.length) continue;
    out.push({
      server: entry.row.name,
      prompts: entry.prompts.map((p) => ({ name: p.name, description: p.description || "", args: (p.arguments || []).map((a) => a.name) })),
      resourceCount: entry.resources.length + entry.resourceTemplates.length,
    });
  }
  return out;
}

function disconnectUserMcp(userId, rowId) {
  const userCache = _cache.get(userId);
  if (!userCache) return;
  if (rowId) {
    const entry = userCache.get(rowId);
    if (entry) { closeEntry(entry); userCache.delete(rowId); }
  } else {
    for (const entry of userCache.values()) closeEntry(entry);
    _cache.delete(userId);
  }
}

// Stop servers nobody has used for a while. Remote sessions are cheap to
// reopen; a stdio process is a whole runtime sitting in memory.
setInterval(() => {
  const now = Date.now();
  for (const userCache of _cache.values()) {
    for (const entry of userCache.values()) {
      if (entry.client && now - entry.lastUsed > IDLE_MS) closeEntry(entry);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  getUserMcpTools,
  callUserMcpTool,
  isUserMcpTool,
  disconnectUserMcp,
  getUserMcpToolDefs,
  getUserMcpExtras,
  needsMcpConfirmation,
  describeUserMcpTool,
  listUserMcpResources,
  readUserMcpResource,
  getUserMcpPrompt,
};
