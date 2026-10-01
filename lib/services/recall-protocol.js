// Data-only ingestion recipes. No generated code, model calls or provider names.
// A recipe is compiled from a connection's description, checked against its
// actual operations, then executed by the same runner for HTTP and MCP.
const crypto = require("node:crypto");
const VERSION = 1;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const words = value => String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_/.-]+/g, " ").toLowerCase();
const WRITES = /\b(create|update|delete|remove|send|execute|run|write|publish|purchase|buy|pay|transfer|cancel|reset|set|revoke|mutate|command)\b/;
const LIVE = /\b(weather|forecasts?|current conditions|live status|current prices?|stock prices?|exchange rates?|availability|telemetry|metrics|health checks?|now playing|random|calculator|search engine)\b/;
const SECRET = /(?:password|secret|token|credential|api.?key|authorization|cookie|private.?key)/i;
const TEXT = /^(title|name|subject|body|content|text|description|summary|notes?|message|details|display_name|first_name|last_name|email|address|status|state|due_date|start|end|date|amount|currency)$/i;
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function operationSignature(operations) {
  const roots = new Map();
  return digest(operations.map(({ root, ...operation }) => {
    if (root && !roots.has(root)) roots.set(root, digest(root));
    return { ...operation, root: root ? roots.get(root) : undefined };
  }));
}
function at(value, path = "") {
  if (!path) return value;
  for (const key of String(path).split(".")) {
    if (BAD_KEYS.has(key) || value == null || !Object.hasOwn(Object(value), key)) return undefined;
    value = value[key];
  }
  return value;
}
function pathOK(path) { return typeof path === "string" && path.length < 250 && path.split(".").every(k => !BAD_KEYS.has(k) && /^[\w-]*$/.test(k)); }
function deref(schema, root, depth = 0) {
  if (!schema || depth > 12) return {};
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/")) return {};
    let value = root;
    for (const key of schema.$ref.slice(2).split("/")) value = value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    return deref(value, root, depth + 1);
  }
  if (schema.allOf) return schema.allOf.reduce((out, part) => {
    const next = deref(part, root, depth + 1);
    return { ...out, ...next, properties: { ...out.properties, ...next.properties }, required: [...(out.required || []), ...(next.required || [])] };
  }, {});
  if (schema.anyOf || schema.oneOf) {
    const choices = (schema.anyOf || schema.oneOf).map(s => deref(s, root, depth + 1)).filter(s => s.type !== "null");
    if (choices.length === 1) return choices[0];
  }
  if (Array.isArray(schema.type)) return { ...schema, type: schema.type.find(t => t !== "null") };
  return schema;
}
function fields(schema, root, prefix = "", depth = 0) {
  if (depth > 4) return [];
  schema = deref(schema, root);
  return Object.entries(schema.properties || {}).flatMap(([key, raw]) => {
    if (BAD_KEYS.has(key) || SECRET.test(key)) return [];
    const p = prefix ? `${prefix}.${key}` : key, s = deref(raw, root);
    return s.type === "object" || s.properties ? fields(s, root, p, depth + 1) : [{ path: p, name: key, ...s }];
  });
}
function collectionSchema(schema, root, prefix = "", depth = 0) {
  if (depth > 4) return [];
  schema = deref(schema, root);
  if (schema.type === "array" || schema.items) return [{ path: prefix, schema: deref(schema.items, root) }];
  return Object.entries(schema.properties || {}).flatMap(([key, s]) => BAD_KEYS.has(key) ? [] : collectionSchema(s, root, prefix ? `${prefix}.${key}` : key, depth + 1));
}
function eligibility(operation, hint = {}) {
  const label = words(operation.name + " " + (operation.url ? new URL(operation.url).pathname : ""));
  if (WRITES.test(label) || operation.destructive === true || (operation.readOnly !== true && hint.readOnly !== true)) return { mode: "on_demand", reason: "This operation is not a verified reader." };
  const durableRecord = /\b(notes?|documents?|reports?|journals?|articles?|messages?|bookings?|invoices?|receipts?|tickets?)\b/.test(label);
  if (hint.value === "transient" || hint.value === "none" || (!durableRecord && (LIVE.test(label) || LIVE.test(words(operation.description))))) {
    return { mode: "on_demand", reason: "Live or short-lived results are checked when needed." };
  }
  if (hint.value && hint.value !== "durable") return { mode: "on_demand", reason: "The value of keeping this collection is not established." };
  if (!/\b(list|all|browse|fetch|read|get|export|query)\b/.test(label) && !hint.fields) return { mode: "on_demand", reason: "No collection reader was identified." };
  return { mode: "candidate" };
}
function inferFields(schema, root) {
  const fs = fields(schema, root), choose = names => names.map(n => fs.find(f => f.name.toLowerCase() === n)?.path).find(Boolean);
  const id = choose(["id", "uuid", "uri", "key", "record_id"]);
  const text = fs.filter(f => TEXT.test(f.name) && ["string", "number", "integer"].includes(f.type)).map(f => f.path);
  const meaningful = fs.some(f => text.includes(f.path) && f.type === "string" && !/^(status|state|date|due_date|start|end|currency)$/i.test(f.name));
  if (!id || !meaningful) return null;
  return { id, text, title: choose(["title", "subject", "name", "display_name"]), url: choose(["url", "web_url", "html_url", "uri"]), updated: choose(["updated_at", "updated", "modified_at", "last_modified", "updatedat"]), deleted: choose(["deleted", "is_deleted"]) };
}
function inferPagination(input, output, root) {
  const ins = Object.keys(input.properties || {}), outs = fields(output, root);
  const pickIn = regex => ins.find(n => regex.test(n)), pickOut = regex => outs.find(f => regex.test(f.name))?.path;
  const size = pickIn(/^(limit|page_size|per_page|pageSize|max_results)$/), cursor = pickIn(/^(cursor|after|page_token|pageToken|continuation_token)$/);
  const pageSize = size ? Math.min(100, input.properties[size].maximum || input.properties[size].default || 100) : 100;
  const next = pickOut(/^(next_cursor|nextCursor|next_page_token|nextPageToken|continuation_token)$/);
  const more = pickOut(/^(has_more|hasMore)$/);
  if (cursor && next) return { kind: "cursor", param: cursor, next, ...(size ? { sizeParam: size, size: pageSize } : {}), ...(more ? { more } : {}) };
  const page = pickIn(/^(page|page_number)$/), offset = pickIn(/^(offset|skip)$/);
  if (size && (page || offset)) return { kind: page ? "page" : "offset", param: page || offset, sizeParam: size, size: pageSize, start: page ? (input.properties[page]?.default ?? 1) : 0, ...(more ? { more } : {}) };
  // Without a pagination contract this can enrich a partial collection, but
  // cannot establish that a missing record was deleted.
  return { kind: "none" };
}
function validateRecipe(recipe, operation) {
  if (!recipe || typeof recipe !== "object" || !operation) throw new Error("Unknown recall operation");
  if (recipe.id !== undefined && (typeof recipe.id !== "string" || !recipe.id || recipe.id.length > 200 || recipe.id === "resources")) throw new Error("Invalid collection ID");
  const eligible = eligibility(operation, recipe);
  if (eligible.mode !== "candidate") throw new Error(eligible.reason);
  if (!pathOK(recipe.items) || !recipe.fields || !pathOK(recipe.fields.id) || !recipe.fields.id || SECRET.test(recipe.fields.id)) throw new Error("A collection needs stable record IDs");
  if (!Array.isArray(recipe.fields.text) || !recipe.fields.text.length || recipe.fields.text.length > 40 || recipe.fields.text.some(p => !pathOK(p) || SECRET.test(p))) throw new Error("Invalid readable fields");
  for (const k of ["title", "url", "updated", "deleted"]) if (recipe.fields[k] && (!pathOK(recipe.fields[k]) || SECRET.test(recipe.fields[k]))) throw new Error("Invalid record field");
  const args = recipe.args || {};
  if (JSON.stringify(args).length > 8000 || Object.keys(args).some(k => BAD_KEYS.has(k) || SECRET.test(k))) throw new Error("Invalid collection arguments");
  const pagination = recipe.pagination || { kind: "none" };
  if (!["none", "page", "offset", "cursor"].includes(pagination.kind)) throw new Error("Unknown pagination method");
  const input = operation.inputSchema || { properties: {} };
  for (const key of [pagination.param, pagination.sizeParam].filter(Boolean)) if (!Object.hasOwn(input.properties || {}, key)) throw new Error("Pagination argument is not declared by the connection");
  if (pagination.kind !== "none" && !pagination.param) throw new Error("Missing pagination argument");
  if (["page", "offset"].includes(pagination.kind) && (!pagination.sizeParam || !Number.isInteger(pagination.start) || pagination.start < 0)) throw new Error("Invalid numbered pagination");
  if (pagination.kind === "cursor" && (!pagination.next || !pathOK(pagination.next))) throw new Error("Missing next-page field");
  if (pagination.more && !pathOK(pagination.more)) throw new Error("Invalid continuation field");
  if (pagination.sizeParam && (!Number.isInteger(pagination.size) || pagination.size < 1 || pagination.size > 100)) throw new Error("Invalid page size");
  const argumentsPresent = new Set([...Object.keys(args), pagination.param, pagination.sizeParam, recipe.scope?.param]);
  for (const required of input.required || []) if (!argumentsPresent.has(required)) throw new Error(`Collection needs an explicit ${required} scope`);
  for (const key of Object.keys(args)) if (!Object.hasOwn(input.properties || {}, key)) throw new Error("Unknown collection argument");
  if (recipe.complete === true && pagination.kind === "none" && !operation.hint?.complete) throw new Error("A complete listing must be declared by the source");
  if (recipe.detail && (!recipe.detail.operation || !pathOK(recipe.detail.param) || !pathOK(recipe.detail.idField) || !pathOK(recipe.detail.result || ""))) throw new Error("Invalid record reader");
  if (recipe.scope && (typeof recipe.scope.operation !== "string" || !Object.hasOwn(input.properties || {}, recipe.scope.param))) throw new Error("Invalid parent collection");
  return { version: VERSION, id: recipe.id || operation.id, operation: operation.id, value: "durable", items: recipe.items, fields: recipe.fields, args, pagination,
    complete: recipe.complete === true, ...(recipe.readOnly === true ? { readOnly: true } : {}), ...(recipe.detail ? { detail: recipe.detail } : {}), ...(recipe.scope ? { scope: recipe.scope } : {}) };
}
function validateArguments(operation, args) {
  const schema = operation.inputSchema || {};
  for (const key of schema.required || []) if (!Object.hasOwn(args, key)) throw new Error(`Missing ${key} argument`);
  for (const [key, value] of Object.entries(args)) {
    const s = schema.properties?.[key];
    if (!s || BAD_KEYS.has(key) || SECRET.test(key)) throw new Error("Invalid reader argument");
    if (s.enum && !s.enum.includes(value)) throw new Error("Reader argument is outside its allowed values");
    if ((s.type === "integer" && !Number.isInteger(value)) || (s.type === "number" && typeof value !== "number") || (s.type === "string" && typeof value !== "string") || (s.type === "boolean" && typeof value !== "boolean")) throw new Error("Reader argument does not match its declared type");
    if (typeof value === "number" && ((s.minimum != null && value < s.minimum) || (s.maximum != null && value > s.maximum))) throw new Error("Reader argument is outside its allowed range");
  }
}
function compile(operations, saved = []) {
  const recipes = [], skipped = [];
  for (const op of operations) {
    const hint = saved.find(r => r.operation === op.id) || op.hint || {};
    const eligible = eligibility(op, hint);
    if (eligible.mode !== "candidate") { skipped.push({ operation: op.id, reason: eligible.reason }); continue; }
    try {
      const collections = collectionSchema(op.outputSchema, op.root || op.outputSchema);
      const candidates = collections.map(c => ({ ...c, mapping: inferFields(c.schema, op.root || op.outputSchema) })).filter(c => c.mapping);
      if (!hint.fields && candidates.length !== 1) throw new Error("Readable record fields need a source description");
      const candidate = candidates[0];
      const args = Object.fromEntries(Object.entries(op.inputSchema?.properties || {}).filter(([, v]) => v.default !== undefined).map(([k, v]) => [k, v.default]));
      const pagination = hint.pagination || inferPagination(op.inputSchema || {}, op.outputSchema || {}, op.root || op.outputSchema);
      if (pagination.sizeParam) delete args[pagination.sizeParam];
      if (pagination.param) delete args[pagination.param];
      const recipe = validateRecipe({ ...hint, items: hint.items ?? candidate?.path, fields: hint.fields || candidate?.mapping, args: { ...args, ...hint.args }, pagination, complete: hint.complete !== false && (hint.complete === true || pagination.kind !== "none") }, op);
      recipes.push(recipe);
    } catch (e) { skipped.push({ operation: op.id, reason: e.message }); }
  }
  // A required project/workspace/folder ID can come from another described
  // collection. This builds a bounded graph instead of hardcoding API trees.
  // Ambiguous parents stay explicit, rather than choosing an arbitrary scope.
  for (let depth = 0; depth < 4; depth++) {
    let added = false;
    for (const skip of [...skipped]) {
      const match = skip.reason.match(/^Collection needs an explicit (\w+) scope$/);
      if (!match) continue;
      const operation = operations.find(o => o.id === skip.operation), param = match[1];
      const hint = saved.find(r => r.operation === operation.id) || operation.hint || {};
      const entity = words(param).replace(/\s+id$/, "").trim();
      const parents = hint.scope ? recipes.filter(r => r.operation === hint.scope.operation) : recipes.filter(r => {
        const name = words(operations.find(o => o.id === r.operation)?.name).split(" ");
        return name.some(w => w === entity || w === entity + "s" || (entity.endsWith("y") && w === entity.slice(0, -1) + "ies"));
      });
      if (parents.length !== 1 || parents[0].operation === operation.id) continue;
      const parent = parents[0], collections = collectionSchema(operation.outputSchema, operation.root || operation.outputSchema);
      const candidates = collections.map(c => ({ ...c, mapping: inferFields(c.schema, operation.root || operation.outputSchema) })).filter(c => c.mapping);
      if (!hint.fields && candidates.length !== 1) continue;
      const c = candidates[0], pagination = hint.pagination || inferPagination(operation.inputSchema || {}, operation.outputSchema || {}, operation.root || operation.outputSchema);
      try {
        const recipe = validateRecipe({ ...hint, items: hint.items ?? c?.path, fields: hint.fields || c?.mapping, args: hint.args || {}, pagination,
          scope: { operation: parent.operation, param }, complete: parent.complete && hint.complete !== false && (hint.complete === true || pagination.kind !== "none") }, operation);
        recipes.push(recipe); skipped.splice(skipped.indexOf(skip), 1); added = true;
      } catch { /* needs another explicit scope or a mapping */ }
    }
    if (!added) break;
  }
  const valid = [], ids = new Set();
  function checkParent(recipe, ancestors = []) {
    if (!recipe.scope) return recipe.complete;
    if (ancestors.includes(recipe.operation) || ancestors.length >= 4) throw new Error("Invalid parent collection graph");
    const parent = recipes.find(r => r.operation === recipe.scope.operation);
    if (!parent) throw new Error("Parent collection is unavailable");
    return checkParent(parent, [...ancestors, recipe.operation]) && recipe.complete;
  }
  for (const recipe of recipes) {
    try {
      if (ids.has(recipe.id)) throw new Error("Collection IDs must be unique");
      recipe.complete = checkParent(recipe);
      ids.add(recipe.id); valid.push(recipe);
    } catch (e) { skipped.push({ operation: recipe.operation, reason: e.message }); }
  }
  return { version: VERSION, recipes: valid, skipped };
}
function mcpOperations(tools) {
  return tools.map(t => ({ id: t.name, name: t.name, description: t.description, readOnly: t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true, destructive: t.annotations?.destructiveHint === true,
    inputSchema: t.inputSchema || {}, outputSchema: t.outputSchema || {}, hint: t._meta?.["closedhand/recall"] || {}, transport: "mcp" }));
}
function openApiOperations(spec, origins) {
  const out = [];
  for (const [path, entry] of Object.entries(spec.paths || {})) {
    for (const method of ["get", "post"]) {
      const op = entry[method];
      if (!op) continue;
      const hint = op["x-closedhand-recall"] || {};
      const base = (op.servers || entry.servers || spec.servers || [])[0]?.url;
      if (!base) continue;
      let url; try { url = new URL(base.replace(/\/$/, "") + path); } catch { continue; }
      if (!origins.includes(url.origin)) continue;
      const input = { type: "object", properties: {}, required: [] }, locations = {};
      for (const raw of [...(entry.parameters || []), ...(op.parameters || [])]) {
        const p = deref(raw, spec);
        if (["query", "path"].includes(p.in) && !SECRET.test(p.name)) { input.properties[p.name] = deref(p.schema, spec); locations[p.name] = p.in; if (p.required || p.in === "path") input.required.push(p.name); }
      }
      if (method === "post") {
        const body = deref(op.requestBody, spec).content?.["application/json"]?.schema;
        const s = deref(body, spec);
        Object.assign(input.properties, s.properties || {}); input.required.push(...(s.required || []));
        for (const k of Object.keys(s.properties || {})) locations[k] = "body";
      }
      const response = deref(op.responses?.["200"] || op.responses?.["2XX"], spec);
      out.push({ id: op.operationId || `${method.toUpperCase()} ${path}`, name: op.operationId || `list ${path}`, description: op.summary || op.description || "",
        readOnly: method === "get" || hint.readOnly === true, url: url.href, method: method.toUpperCase(), inputSchema: input, locations,
        outputSchema: response.content?.["application/json"]?.schema || {}, root: spec, hint, transport: "http" });
    }
  }
  return out;
}
function decodeTool(result) {
  if (result.isError) throw new Error("The source could not read this collection");
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  try { return JSON.parse(text); } catch { throw new Error("The reader must return structured records"); }
}
function record(row, recipe, sourceName) {
  const f = recipe.fields, id = at(row, f.id);
  if (!["string", "number"].includes(typeof id) || String(id).length > 2000 || String(id) === "") throw new Error("Source record has no stable ID");
  if (f.deleted && at(row, f.deleted) === true) return { id: String(id), deleted: true };
  const text = f.text.map(path => {
    const value = at(row, path);
    return ["string", "number", "boolean"].includes(typeof value) ? `${path.split(".").pop()}: ${value}` : "";
  }).filter(Boolean).join("\n");
  if (!text.trim()) throw new Error("A source record has no readable content");
  return { id: String(id), text, title: f.title ? String(at(row, f.title) || sourceName) : sourceName, url: f.url ? String(at(row, f.url) || "") : "", updated_at: f.updated ? at(row, f.updated) : null, source_name: sourceName };
}
async function* run(recipe, operation, invoke, sourceName, limits = {}) {
  recipe = validateRecipe(recipe, operation);
  if (recipe.scope) {
    const ancestors = limits.ancestors || [];
    if (ancestors.includes(recipe.operation) || ancestors.length >= 4) throw new Error("Parent collections form a cycle or exceed the nesting limit");
    const parent = limits.recipes?.find(r => r.operation === recipe.scope.operation), parentOp = limits.operations?.find(o => o.id === recipe.scope.operation);
    if (!parent || !parentOp) throw new Error("Parent collection is not available");
    const next = { ...limits, ancestors: [...ancestors, recipe.operation] };
    for await (const parents of run(parent, parentOp, invoke, sourceName, next)) {
      for (const item of parents) {
        if (item.deleted) continue;
        const raw = item.raw_id ?? item.id;
        const scopeId = operation.inputSchema?.properties?.[recipe.scope.param]?.type === "integer" && /^\d+$/.test(String(raw)) ? Number(raw) : raw;
        const child = { ...recipe, scope: undefined, args: { ...recipe.args, [recipe.scope.param]: scopeId } };
        for await (const batch of run(child, operation, invoke, sourceName, next)) yield batch.map(record => ({ ...record, raw_id: record.raw_id || record.id, id: `${item.id}\0${record.id}` }));
      }
    }
    return;
  }
  const p = recipe.pagination, seen = new Set(), cursors = new Set();
  let cursor, count = 0;
  for (let page = 0; page < (limits.pages || 100); page++) {
    const args = { ...recipe.args };
    if (p.sizeParam) args[p.sizeParam] = p.size;
    if (p.kind === "page") args[p.param] = p.start + page;
    if (p.kind === "offset") args[p.param] = p.start + count;
    if (p.kind === "cursor" && cursor !== undefined) args[p.param] = cursor;
    validateArguments(operation, args);
    const response = await invoke(operation, args);
    const rows = at(response, recipe.items);
    if (!Array.isArray(rows)) throw new Error("Source returned an invalid collection");
    count += rows.length;
    if (count > (limits.records || 10000)) throw new Error("Collection limit reached; more content remains at the source");
    const records = [];
    for (const row of rows) {
      if (!recipe.detail) { records.push(row); continue; }
      const detail = limits.operations?.find(o => o.id === recipe.detail.operation);
      if (!detail || eligibility(detail, { ...detail.hint, fields: recipe.fields }).mode !== "candidate") throw new Error("The record reader is not a verified read operation");
      const id = at(row, recipe.detail.idField);
      if (!["string", "number"].includes(typeof id)) throw new Error("Missing record ID for the detail reader");
      const detailArgs = { ...(recipe.detail.args || {}), [recipe.detail.param]: id };
      if (!Object.hasOwn(detail.inputSchema?.properties || {}, recipe.detail.param) || (detail.inputSchema?.required || []).some(k => !Object.hasOwn(detailArgs, k))) throw new Error("Record reader arguments do not match its schema");
      validateArguments(detail, detailArgs);
      records.push(at(await invoke(detail, detailArgs), recipe.detail.result || ""));
    }
    const items = records.map(row => record(row, recipe, sourceName));
    for (const item of items) { if (seen.has(item.id)) throw new Error("Source repeated records; listing is incomplete"); seen.add(item.id); }
    yield items;
    if (p.kind === "none") return;
    if (p.kind === "cursor") {
      const next = at(response, p.next), more = p.more ? at(response, p.more) : undefined;
      if (more === true && (next == null || next === "")) throw new Error("Source has more records but omitted the cursor");
      if (next == null || next === "") return;
      if (!["string", "number"].includes(typeof next) || cursors.has(String(next))) throw new Error("Source repeated an invalid page cursor");
      cursors.add(String(next)); cursor = next;
    } else {
      const more = p.more ? at(response, p.more) : undefined;
      if (more === true && rows.length === 0) throw new Error("Source reported more records without making progress");
      if (more === false || (more !== true && rows.length < p.size)) return;
    }
  }
  throw new Error("Page limit reached; collection is incomplete");
}
function sampleSchema(value, depth = 0) {
  if (depth > 6 || value == null) return {};
  if (Array.isArray(value)) return { type: "array", items: sampleSchema(value.find(v => v != null), depth + 1) };
  if (typeof value === "object") return { type: "object", properties: Object.fromEntries(Object.entries(value).filter(([key]) => !BAD_KEYS.has(key) && !SECRET.test(key)).slice(0, 100).map(([k, v]) => [k, sampleSchema(v, depth + 1)])) };
  return { type: typeof value };
}
function usefulResource(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  try {
    const value = JSON.parse(text);
    const schema = sampleSchema(value), fs = fields(schema, schema);
    return fs.some(f => TEXT.test(f.name) && f.type === "string" && !/^(status|state|date|due_date|start|end|currency)$/i.test(f.name));
  } catch { return text.trim().split(/\s+/).length >= 3; }
}
function resourceText(text) {
  if (!usefulResource(text)) return "";
  function clean(value, depth = 0) {
    if (depth > 8) return null;
    if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !BAD_KEYS.has(key) && !SECRET.test(key)).map(([key, v]) => [key, clean(v, depth + 1)]));
    return value;
  }
  try { return JSON.stringify(clean(JSON.parse(text))); } catch { return text; }
}
module.exports = { VERSION, at, digest, operationSignature, eligibility, compile, validateRecipe, mcpOperations, openApiOperations, decodeTool, run, inferFields, collectionSchema, sampleSchema, usefulResource, resourceText };
