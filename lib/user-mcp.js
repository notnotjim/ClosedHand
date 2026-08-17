// lib/user-mcp.js - Per-user MCP connections for remote HTTP servers
// Supports MCP Streamable HTTP transport with initialization handshake,
// session management, OAuth token refresh, and SSE response parsing.

const { supabase } = require("./db");

// In-memory cache: userId -> Map<serverUrl, { tools, lastUsed, sessionId }>
const _cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Build auth + MCP headers for a request
function buildHeaders(token, authType, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (token) {
    if (authType === "bearer" || authType === "oauth") {
      headers["Authorization"] = `Bearer ${token}`;
    } else if (authType === "header") {
      headers["x-api-key"] = token;
    }
  }
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  return headers;
}

// Parse an MCP HTTP response (handles both JSON and SSE)
async function parseMcpResponse(resp) {
  const contentType = resp.headers.get("content-type") || "";

  // Plain JSON response
  if (contentType.includes("application/json")) {
    return await resp.json();
  }

  // SSE stream - read incrementally (stream may stay open indefinitely)
  if (contentType.includes("text/event-stream")) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const results = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try { results.push(JSON.parse(line.slice(6))); } catch (e) {}
          }
        }
        // Return as soon as we get a JSON-RPC result or error
        const match = results.find(r => r.result !== undefined || r.error !== undefined);
        if (match) {
          reader.cancel();
          return match;
        }
      }
    } catch (e) {
      if (results.length === 0) throw e;
    }
    // Return the last JSON-RPC response (the actual result)
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].result !== undefined || results[i].error !== undefined) {
        return results[i];
      }
    }
    if (results.length > 0) return results[results.length - 1];
    throw new Error("No JSON-RPC response in SSE stream");
  }

  // Fallback: try parsing as JSON
  return await resp.json();
}

// Send an MCP JSON-RPC request over HTTP
async function mcpRequest(url, method, params, token, authType, sessionId, timeout = 15000) {
  const headers = buildHeaders(token, authType, sessionId);
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1000000),
      method,
      params: params || {},
    }),
    signal: AbortSignal.timeout(timeout),
  });

  // Extract session ID from response headers
  const newSessionId = resp.headers.get("mcp-session-id") || null;

  if (!resp.ok) {
    const err = new Error(`MCP server returned ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  const data = await parseMcpResponse(resp);
  return { data, sessionId: newSessionId };
}

// Send an MCP notification (no response expected)
async function mcpNotify(url, method, params, token, authType, sessionId) {
  const headers = buildHeaders(token, authType, sessionId);
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: params || {},
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {}); // Notifications may return 202 with no body
}

// Initialize an MCP session (required before tools/list)
async function initializeMcpSession(url, token, authType) {
  // Step 1: Send initialize request
  const { data, sessionId } = await mcpRequest(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "ClosedHand", version: "1.0.0" },
  }, token, authType, null);

  if (data.error) {
    throw new Error("MCP initialize failed: " + (data.error.message || JSON.stringify(data.error)));
  }

  // Step 2: Send initialized notification
  await mcpNotify(url, "notifications/initialized", {}, token, authType, sessionId);

  console.log(`[user-mcp] MCP session initialized for ${url}${sessionId ? ` (session: ${sessionId.substring(0, 12)}...)` : ""}`);
  return sessionId;
}

// Refresh an OAuth-based MCP token
async function refreshMcpToken(mcp) {
  if (!mcp.oauth_refresh_token || !mcp.oauth_token_url || !mcp.oauth_client_id) {
    throw new Error("Cannot refresh: missing OAuth credentials");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: mcp.oauth_refresh_token,
    client_id: mcp.oauth_client_id,
  });
  if (mcp.oauth_client_secret) {
    body.set("client_secret", mcp.oauth_client_secret);
  }

  const resp = await fetch(mcp.oauth_token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error("Token refresh failed: " + resp.status);
  }

  const tokens = await resp.json();
  mcp.auth_token = tokens.access_token;
  if (tokens.refresh_token) mcp.oauth_refresh_token = tokens.refresh_token;
  mcp.oauth_token_expiry = tokens.expires_in ? Date.now() + (tokens.expires_in * 1000) : null;

  await supabase.from("user_mcps").update({
    auth_token: mcp.auth_token,
    oauth_refresh_token: mcp.oauth_refresh_token,
    oauth_token_expiry: mcp.oauth_token_expiry,
  }).eq("id", mcp.id);

  console.log(`Refreshed MCP OAuth token for ${mcp.name}`);
  return mcp.auth_token;
}

// Load and cache a user's MCP tools
async function getUserMcpTools(userId) {
  // Check cache
  if (_cache.has(userId)) {
    const userCache = _cache.get(userId);
    const allTools = [];
    for (const [url, entry] of userCache) {
      if (Date.now() - entry.lastUsed < CACHE_TTL) {
        allTools.push(...entry.tools);
      } else {
        userCache.delete(url);
      }
    }
    if (allTools.length > 0) return allTools;
  }

  // Load from Supabase
  const { data: mcps } = await supabase
    .from("user_mcps")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "connected");

  if (!mcps || mcps.length === 0) return [];

  const allTools = [];
  const userCache = _cache.has(userId) ? _cache.get(userId) : new Map();

  for (const mcp of mcps) {
    try {
      const { tools, sessionId } = await discoverTools(mcp);
      const prefix = mcp.name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 15);
      const prefixedTools = tools.map(t => ({
        ...t,
        originalName: t.name,
        name: `umcp_${prefix}_${t.name}`,
        _userMcp: true,
        _userId: userId,
        _serverUrl: mcp.server_url,
        _authToken: mcp.auth_token,
        _authType: mcp.auth_type,
        _sessionId: sessionId,
      }));
      allTools.push(...prefixedTools);
      userCache.set(mcp.server_url, { tools: prefixedTools, lastUsed: Date.now(), sessionId });

      const toolNames = tools.map(t => t.name);
      await supabase.from("user_mcps").update({ tools_discovered: toolNames }).eq("id", mcp.id);
    } catch (e) {
      console.error(`User MCP error (${mcp.name}):`, e.message);
      await supabase.from("user_mcps").update({ status: "error" }).eq("id", mcp.id);
    }
  }

  _cache.set(userId, userCache);
  return allTools;
}

// Discover tools from a remote MCP server
async function discoverTools(mcp) {
  // Proactively refresh if token is expiring soon
  if (mcp.auth_type === "oauth" && mcp.oauth_token_expiry && mcp.oauth_refresh_token) {
    if (Date.now() > mcp.oauth_token_expiry - 5 * 60 * 1000) {
      try { await refreshMcpToken(mcp); } catch (e) { console.error("Proactive MCP token refresh failed:", e.message); }
    }
  }

  const baseUrl = mcp.server_url.replace(/\/+$/, "");

  // Initialize MCP session first
  let sessionId;
  try {
    sessionId = await initializeMcpSession(baseUrl, mcp.auth_token, mcp.auth_type);
  } catch (e) {
    // If 401/406 and OAuth, try refreshing and re-initializing
    if ((e.status === 401 || e.status === 406) && mcp.auth_type === "oauth" && mcp.oauth_refresh_token) {
      const newToken = await refreshMcpToken(mcp);
      sessionId = await initializeMcpSession(baseUrl, newToken, mcp.auth_type);
    } else {
      throw e;
    }
  }

  // Now list tools
  const { data } = await mcpRequest(baseUrl, "tools/list", {}, mcp.auth_token, mcp.auth_type, sessionId);

  if (data.error) {
    throw new Error("tools/list failed: " + (data.error.message || JSON.stringify(data.error)));
  }

  const tools = (data.result?.tools || data.tools || []).map(t => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  }));

  return { tools, sessionId };
}

// Call a tool on a user's MCP server
async function callUserMcpTool(userId, toolName, toolInput) {
  const userCache = _cache.get(userId);
  if (!userCache) throw new Error("No MCP connections for user");

  let targetTool = null;
  let cacheEntry = null;
  for (const [url, entry] of userCache) {
    const tool = entry.tools.find(t => t.name === toolName);
    if (tool) { targetTool = tool; cacheEntry = entry; break; }
  }

  if (!targetTool) throw new Error(`MCP tool '${toolName}' not found`);

  const baseUrl = targetTool._serverUrl.replace(/\/+$/, "");
  const sessionId = targetTool._sessionId || cacheEntry?.sessionId || null;

  let resp;
  try {
    resp = await mcpRequest(baseUrl, "tools/call", {
      name: targetTool.originalName,
      arguments: toolInput,
    }, targetTool._authToken, targetTool._authType, sessionId, 30000);
  } catch (e) {
    // If 401/406 on OAuth MCP, try refreshing token and re-initializing
    if ((e.status === 401 || e.status === 406) && targetTool._authType === "oauth") {
      const { data: mcp } = await supabase
        .from("user_mcps")
        .select("*")
        .eq("user_id", userId)
        .eq("server_url", targetTool._serverUrl)
        .single();
      if (mcp && mcp.oauth_refresh_token) {
        const newToken = await refreshMcpToken(mcp);
        targetTool._authToken = newToken;
        for (const [url, entry] of userCache) {
          for (const t of entry.tools) {
            if (t._serverUrl === targetTool._serverUrl) t._authToken = newToken;
          }
        }
        // Re-initialize session
        const newSessionId = await initializeMcpSession(baseUrl, newToken, targetTool._authType);
        if (cacheEntry) cacheEntry.sessionId = newSessionId;
        resp = await mcpRequest(baseUrl, "tools/call", {
          name: targetTool.originalName,
          arguments: toolInput,
        }, newToken, targetTool._authType, newSessionId, 30000);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const data = resp.data;
  if (data.result) {
    if (data.result.content) {
      return data.result.content.map(c => c.text || JSON.stringify(c)).join("\n");
    }
    return data.result;
  }
  if (data.error) {
    throw new Error(data.error.message || "MCP tool error");
  }
  return data;
}

// Check if a tool name is a user MCP tool
function isUserMcpTool(toolName) {
  return toolName.startsWith("umcp_");
}

// Disconnect a user's MCP connections (cache cleanup)
function disconnectUserMcp(userId, serverUrl) {
  if (serverUrl) {
    const userCache = _cache.get(userId);
    if (userCache) userCache.delete(serverUrl);
  } else {
    _cache.delete(userId);
  }
}

// Get tool definitions formatted for the LLM
function getUserMcpToolDefs(userId) {
  const userCache = _cache.get(userId);
  if (!userCache) return [];
  const defs = [];
  for (const [url, entry] of userCache) {
    for (const tool of entry.tools) {
      defs.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.inputSchema || { type: "object", properties: {} },
      });
    }
  }
  return defs;
}

module.exports = {
  getUserMcpTools,
  callUserMcpTool,
  isUserMcpTool,
  disconnectUserMcp,
  getUserMcpToolDefs,
  discoverTools,
};
