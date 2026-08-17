// lib/services/usi-connector.js -- Generic service connector for USI
// When ANY service is connected, this determines how to sync and index it.
// No service-specific code. Works with OAuth services, MCP tools, and future integrations.

const { supabase } = require("../../user-store");

// ============================================================================
// SERVICE CLASSIFICATION
// ============================================================================

/**
 * When a new service is connected, classify it and set up sync.
 * Uses the LLM to determine: does it need caching? how often to sync?
 * Stores sync config on the connections row (no separate table).
 */
async function classifyAndSetup(userId, serviceName, availableMethods) {
  // Check if sync config already exists on the connection
  const { data: conn } = await supabase
    .from("connections")
    .select("sync_should_cache, sync_strategy, sync_interval_minutes, sync_data_types, sync_list_method, sync_read_method")
    .eq("user_id", userId)
    .eq("service", serviceName)
    .single();

  if (conn && conn.sync_should_cache !== null) {
    return {
      should_cache: conn.sync_should_cache,
      sync_strategy: conn.sync_strategy || "interval",
      sync_interval_minutes: conn.sync_interval_minutes || 15,
      data_types: conn.sync_data_types || [],
      list_method: conn.sync_list_method,
      read_method: conn.sync_read_method,
    };
  }

  // Ask the LLM to classify the service. Store passed explicitly: writing it
  // to the ctx singleton from a background job clobbers whoever else is active.
  const { getUserLLMClient } = require("../llm");
  const UserStore = require("../../user-store").UserStore;
  const store = await UserStore.load(userId);

  let config = {
    should_cache: true,
    sync_interval_minutes: 15,
    sync_strategy: "interval", // "interval" | "event_driven" | "low_frequency" | "none"
    data_types: [],
    list_method: null,
    read_method: null,
  };

  try {
    const { client, model } = getUserLLMClient(userId, store);
    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 512,
        system: "You classify services for a data sync system. Return ONLY valid JSON.",
        messages: [{ role: "user", content: `Service: "${serviceName}"
Available API methods/tools: ${JSON.stringify(availableMethods || []).substring(0, 2000)}

Known API endpoints for common services:
- GitHub: https://api.github.com/user/repos, /user/events
- Shopify: use api_request with service=shopify
- Asana: https://app.asana.com/api/1.0/tasks, /workspaces
- HubSpot: https://api.hubapi.com/crm/v3/objects/contacts, /deals
- Salesforce: /services/data/v59.0/query?q=SELECT...
- Zoom: https://api.zoom.us/v2/users/me/meetings
- Dropbox: https://api.dropboxapi.com/2/files/list_folder
- GitLab: https://gitlab.com/api/v4/projects
- Notion: https://api.notion.com/v1/search
- Jira: https://your-domain.atlassian.net/rest/api/3/search
- Slack: use api_request with service=slack

Classify this service:
1. should_cache (boolean): Does this service have data worth caching for semantic search?
2. sync_strategy: "interval" | "event_driven" | "low_frequency" | "none"
3. sync_interval_minutes: 5 for comms, 15 for project tools, 60 for reference, 1440 for static
4. data_types: Array of item types (e.g. ["ticket", "project"], ["page", "database"])
5. list_url: Full API URL to list/search items (e.g. "https://api.github.com/user/repos")
6. list_params: Query params as JSON object (e.g. {"per_page": 100})
7. read_url_template: URL template for single item with {id} placeholder (e.g. "https://api.github.com/repos/{id}")

Return JSON: {"should_cache": bool, "sync_strategy": string, "sync_interval_minutes": number, "data_types": string[], "list_url": string|null, "list_params": object|null, "read_url_template": string|null}` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
    ]);

    const text = resp.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      config = { ...config, ...parsed };
    }
  } catch (e) {
    console.log(`[USI-Connector] Classification failed for ${serviceName}: ${e.message}`);
  }

  // Store sync config on the connections row
  await supabase.from("connections").update({
    sync_should_cache: config.should_cache,
    sync_strategy: config.sync_strategy,
    sync_interval_minutes: config.sync_interval_minutes,
    sync_data_types: config.data_types || [],
    sync_list_method: config.list_url || config.list_method,
    sync_read_method: config.read_url_template || config.read_method,
  }).eq("user_id", userId).eq("service", serviceName).catch(e => {
    console.log(`[USI-Connector] Config save failed: ${e.message}`);
  });

  console.log(`[USI-Connector] Classified ${serviceName}: strategy=${config.sync_strategy}, interval=${config.sync_interval_minutes}min, types=${config.data_types.join(",")}`);
  return config;
}

// ============================================================================
// GENERIC SYNC
// ============================================================================

/**
 * Sync data from any connected service into data_cache.
 * Uses whatever list/read methods the service provides.
 */
async function syncService(userId, serviceName, config) {
  if (!config.should_cache || config.sync_strategy === "none") return { synced: 0 };

  const UserStore = require("../../user-store").UserStore;
  const store = await UserStore.load(userId);
  if (!store) return { synced: 0 };
  // No ctx writes here: this runs inside the parallel per-user sync loop, and
  // writing the singleton would clobber other users' active context. The tool
  // call below threads _userId, and api_request loads the store from that.

  // Get the service's tools/methods using classified config
  const tools = getServiceTools(store, serviceName, config);
  if (!tools.listTool) {
    console.log(`[USI-Connector] No list tool found for ${serviceName}`);
    return { synced: 0 };
  }

  let synced = 0;

  try {
    // Call the list method to get items
    const { handleInternalTool } = require("../tools/handlers");
    const listResult = await handleInternalTool(tools.listTool.name, {
      ...tools.listParams,
      _userId: userId,
      _chatId: "usi-sync",
    });

    // Extract items from the result (generic: look for arrays in the response)
    const items = extractItemsFromResponse(listResult, config.data_types);

    if (items.length === 0) return { synced: 0 };

    // Cache each item into data_cache (same table as email/calendar sync)
    for (const item of items) {
      const row = {
        user_id: userId,
        source: serviceName,
        type: item.type || config.data_types[0] || "item",
        external_id: item.id || item.external_id || String(Math.random()),
        data: {
          raw_content: item.text || item.content || JSON.stringify(item.raw || item).substring(0, 10000),
          metadata: item.metadata || {},
          attachment_refs: item.attachments || [],
          ...(item.raw || {}),
        },
        synced_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("data_cache")
        .upsert(row, { onConflict: "user_id,source,external_id" });
      if (!error) synced++;
    }

    console.log(`[USI-Connector] Synced ${synced}/${items.length} items from ${serviceName}`);

    // Index into USI vectors
    if (synced > 0) {
      const { indexItems } = require("./usi");
      const usiItems = items.map(item => ({
        external_id: item.id || item.external_id || "",
        text: item.text || item.content || JSON.stringify(item.raw || item).substring(0, 5000),
        metadata: { ...item.metadata, service: serviceName },
      })).filter(i => i.external_id && i.text.length > 10);

      await indexItems(userId, serviceName, config.data_types[0] || "item", usiItems);
    }
  } catch (e) {
    console.error(`[USI-Connector] Sync error for ${serviceName}: ${e.message}`);
  }

  return { synced };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Find the right tool to list items for a service.
 * Looks at connected service's available tools/skills.
 */
function getServiceTools(store, serviceName, config) {
  const connections = store.connections || {};
  const conn = connections[serviceName];
  if (!conn) return {};

  // Use the classified list_url from the connection's sync config
  const listUrl = config?.list_method || conn?.sync_list_method;
  if (!listUrl || listUrl === "/") {
    console.log(`[USI-Connector] No list URL for ${serviceName}, skipping`);
    return {};
  }

  return {
    listTool: { name: "api_request" },
    listParams: { service: serviceName, method: "GET", url: listUrl },
  };
}

/**
 * Extract meaningful items from an API response.
 * Generic: looks for arrays, objects with common patterns.
 */
function extractItemsFromResponse(result, expectedTypes) {
  if (!result || result.error) return [];

  // If result is already an array, use it
  if (Array.isArray(result)) return result.map(normaliseItem);

  // Look for common array keys in the response
  const arrayKeys = ["items", "results", "data", "messages", "records", "entries",
    "orders", "tickets", "pages", "contacts", "events", "files", "channels",
    "conversations", "tasks", "issues", "products", "customers", "value"];

  for (const key of arrayKeys) {
    if (result[key] && Array.isArray(result[key])) {
      return result[key].map(normaliseItem);
    }
  }

  // If it's a single object with meaningful content, wrap it
  if (result.id || result.title || result.name || result.subject) {
    return [normaliseItem(result)];
  }

  return [];
}

/**
 * Normalise any item into a consistent format for caching and indexing.
 */
function normaliseItem(item) {
  if (!item || typeof item !== "object") return { raw: item, text: String(item) };

  // Extract common fields regardless of service
  const id = item.id || item.external_id || item.uid || item.key || "";
  const title = item.title || item.subject || item.name || item.summary || "";
  const body = item.body || item.content || item.description || item.text || item.message || "";
  const author = item.from || item.author || item.creator || item.sender || item.user || "";
  const date = item.date || item.created_at || item.updated_at || item.timestamp || item.receivedDateTime || "";
  const type = item.type || item.item_type || item.kind || "";

  // Build searchable text from all available fields
  const textParts = [title, body];
  if (author) textParts.push(`By: ${typeof author === "object" ? JSON.stringify(author) : author}`);
  if (date) textParts.push(`Date: ${date}`);

  // Include any other string fields that might be useful
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === "string" && v.length > 5 && v.length < 2000 && !textParts.includes(v)) {
      if (!["id", "external_id", "uid", "key", "_id"].includes(k)) {
        textParts.push(v);
      }
    }
  }

  return {
    id,
    type,
    text: textParts.filter(Boolean).join("\n").substring(0, 10000),
    content: body,
    metadata: {
      title,
      author: typeof author === "object" ? JSON.stringify(author) : author,
      date,
      type,
    },
    raw: item,
    attachments: item.attachments || item.files || [],
  };
}

// ============================================================================
// SYNC SCHEDULER
// ============================================================================

const _syncTimers = {}; // userId:service -> timer

/**
 * Start sync scheduling for all services a user has connected.
 * Called when user connects a new service or on app startup.
 */
async function startSyncForUser(userId) {
  const { data: conns } = await supabase
    .from("connections")
    .select("service, sync_should_cache, sync_strategy, sync_interval_minutes, sync_data_types, sync_list_method, sync_read_method")
    .eq("user_id", userId)
    .eq("sync_should_cache", true);

  if (!conns || conns.length === 0) return;

  for (const conn of conns) {
    if (conn.sync_strategy === "none") continue;
    const config = {
      should_cache: true,
      sync_strategy: conn.sync_strategy || "interval",
      sync_interval_minutes: conn.sync_interval_minutes || 15,
      data_types: conn.sync_data_types || [],
      list_method: conn.sync_list_method,
      read_method: conn.sync_read_method,
    };
    const key = `${userId}:${conn.service}`;
    if (_syncTimers[key]) clearInterval(_syncTimers[key]);

    const intervalMs = (config.sync_interval_minutes || 15) * 60 * 1000;
    _syncTimers[key] = setInterval(() => {
      syncService(userId, conn.service, config).catch(e =>
        console.log(`[USI-Connector] Scheduled sync error for ${conn.service}: ${e.message}`)
      );
    }, intervalMs);

    console.log(`[USI-Connector] Scheduled ${conn.service} sync every ${config.sync_interval_minutes}min for ${userId}`);
  }
}

/**
 * Handle a new service connection. Classify, setup, and run initial sync.
 */
async function onServiceConnected(userId, serviceName, availableMethods) {
  const config = await classifyAndSetup(userId, serviceName, availableMethods);
  if (config.should_cache) {
    // Run initial sync
    await syncService(userId, serviceName, config);
    // Start scheduled sync
    startSyncForUser(userId);
  }
}

/**
 * One-shot sync of all connected services with sync_should_cache=true,
 * excluding google/microsoft (handled by dedicated sync functions).
 * Called from data-sync.js after the hardcoded syncs.
 */
async function syncConnectedServices(userId) {
  const { data: conns } = await supabase
    .from("connections")
    .select("service, sync_should_cache, sync_strategy, sync_data_types, sync_list_method, sync_read_method")
    .eq("user_id", userId)
    .eq("sync_should_cache", true);

  if (!conns || conns.length === 0) return;

  // Skip services handled by dedicated sync (google = Gmail/GCal, microsoft = Outlook,
  // slack/notion = dedicated message/page-level syncs in data-sync.js)
  const skip = new Set(["google", "microsoft", "slack", "notion"]);
  const toSync = conns.filter(c => !skip.has(c.service) && c.sync_strategy !== "none");

  for (const conn of toSync) {
    const config = {
      should_cache: true,
      sync_strategy: conn.sync_strategy || "interval",
      data_types: conn.sync_data_types || [],
      list_method: conn.sync_list_method,
      read_method: conn.sync_read_method,
    };
    try {
      await Promise.race([
        syncService(userId, conn.service, config),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
      ]);
    } catch (e) {
      console.log(`[USI-Connector] Sync failed for ${conn.service}: ${e.message}`);
    }
  }
}

module.exports = {
  classifyAndSetup,
  syncService,
  syncConnectedServices,
  startSyncForUser,
  onServiceConnected,
};
