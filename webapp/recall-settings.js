// Shared between bot and webapp. Descriptions contain no credentials or code.
// The bot validates and executes them; the webapp only persists user choices.
function unchanged(query, field, value) {
  // Compare the JSON we are replacing, not a timestamp rounded to milliseconds
  // by node-postgres. This also catches edits that do not touch updated_at.
  return value == null ? query.is(field, null) : query.eq(field, JSON.stringify(value));
}
function location(kind) {
  if (kind === "connection") return { table: "connections", field: "config", source: row => `connected:${row.service}` };
  if (kind === "mcp") return { table: "user_mcps", field: "caps", source: row => `mcp:${row.id}` };
  throw new Error("Unknown connection type");
}
async function getRow(db, userId, kind, id) {
  const where = location(kind);
  const { data, error } = await db.from(where.table).select("*").eq("user_id", userId).eq("id", id);
  if (error) throw new Error("Could not read the connection");
  if (!data?.[0]) throw new Error("Connection not found");
  return data[0];
}
function validateDescription(description, row, kind) {
  if (!description || typeof description !== "object" || Array.isArray(description) || JSON.stringify(description).length > 512000) throw new Error("Invalid source description");
  const allowed = new Set(["enabled", "openapi", "openapiUrl", "collections"]);
  if (Object.keys(description).some(k => !allowed.has(k))) throw new Error("A source description accepts only schemas and collection recipes");
  if (description.enabled !== undefined && typeof description.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (description.collections && (!Array.isArray(description.collections) || description.collections.length > 100)) throw new Error("Invalid collection recipes");
  if (kind === "mcp" && (description.openapi || description.openapiUrl)) throw new Error("MCP connections describe their own tools");
  const origins = row.config?.recall_api?.origins || [];
  if (kind === "connection" && (description.openapi || description.openapiUrl) && !origins.length) throw new Error("This connection has no approved API address yet");
  if (description.openapiUrl) {
    const url = new URL(description.openapiUrl);
    if (url.protocol !== "https:" || url.username || url.password || !origins.includes(url.origin)) throw new Error("The API description must be on the connection's approved address");
  }
  if (description.openapi && (!description.openapi.openapi || !description.openapi.paths)) throw new Error("Supply an OpenAPI document with paths");
  return structuredClone(description);
}
async function configure(db, userId, kind, id, description) {
  const where = location(kind), row = await getRow(db, userId, kind, id);
  const value = { ...(row[where.field] || {}), recall: validateDescription(description, row, kind) };
  delete value.recall_state;
  const query = db.from(where.table).update({ [where.field]: value, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("id", id);
  const { data, error } = await unchanged(query, where.field, row[where.field]).select("id");
  if (error || !data?.length) throw new Error("The connection changed; reload it and try again");
  const { error: progressError } = await db.from("index_progress").delete().eq("user_id", userId).eq("service", `recall:${where.source(row)}`);
  if (progressError) throw new Error("Description saved, but the next sync could not be scheduled");
  return { saved: true, status: description.enabled === false ? "disabled" : "pending", message: description.enabled === false ? "Automatic recall is off for this connection." : "The connection will be checked on the next sync." };
}
async function list(db, userId) {
  const sources = [];
  for (const kind of ["connection", "mcp"]) {
    const where = location(kind);
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from(where.table).select("*").eq("user_id", userId).order("id").range(offset, offset + 499);
      if (error) throw new Error("Could not read source status");
      for (const row of data || []) {
        const state = row[where.field]?.recall_state, enabled = row[where.field]?.recall?.enabled !== false && row.sync_should_cache !== false;
        sources.push({ kind, id: row.id, name: row.name || row.service, enabled, status: enabled ? state?.status || "pending" : "disabled",
          checked_at: state?.checked_at, reason: state?.reason, collections: state?.collections || [], omitted: state?.plan?.skipped || [],
          apiOrigins: row.config?.recall_api?.origins || [] });
      }
      if (!data || data.length < 500) break;
    }
  }
  return sources;
}
function apiDescription(service, svc) {
  const origins = [...new Set([svc.apiBaseUrl, svc.profileUrl, svc.tokenUrl].filter(Boolean).flatMap(address => {
    try { const url = new URL(address); return url.protocol === "https:" ? [url.origin] : []; } catch { return []; }
  }))];
  if (!origins.length) return null;
  return { origins, ...(svc.openapiUrl ? { openapiUrl: svc.openapiUrl } : {}), ...(svc.tokenUrl ? { refresh: { url: svc.tokenUrl, auth: svc.tokenAuthMethod || "body", envPrefix: service.toUpperCase() } } : {}) };
}
async function backfill(db, services) {
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from("connections").select("id, user_id, service, config, updated_at").order("id").range(offset, offset + 499);
    if (error) throw new Error("Could not load connection descriptions");
    for (const row of data || []) {
      if (row.config?.recall_api || !services[row.service]) continue;
      const api = apiDescription(row.service, services[row.service]);
      if (!api) continue;
      const query = db.from("connections").update({ config: { ...(row.config || {}), recall_api: api } }).eq("user_id", row.user_id).eq("id", row.id);
      const { error: writeError } = await unchanged(query, "config", row.config);
      if (writeError) throw new Error("Could not save the connection description");
    }
    if (!data || data.length < 500) return;
  }
}
module.exports = { configure, list, validateDescription, apiDescription, backfill, unchanged };
