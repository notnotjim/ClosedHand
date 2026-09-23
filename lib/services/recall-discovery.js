const protocol = require("./recall-protocol");
const { isBlockedUrl } = require("../ssrf");
const MAX_OPERATIONS = 200;

function checkUrl(value, origins) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || isBlockedUrl(url.href) || !origins.includes(url.origin)) throw new Error("Recall can only read the connection's approved API addresses");
  return url;
}
function descriptorFor(row) { return (row.service ? row.config : row.caps)?.recall || {}; }
function stateFor(row) { return (row.service ? row.config : row.caps)?.recall_state; }

async function discoverHttp(row, request, fallback) {
  const descriptor = descriptorFor(row), api = row.config?.recall_api || {};
  const origins = api.origins || [];
  const schema = descriptor.openapi;
  if (schema) return { operations: protocol.openApiOperations(schema, origins), origins };
  if (descriptor.openapiUrl || api.openapiUrl) {
    const url = checkUrl(descriptor.openapiUrl || api.openapiUrl, origins);
    return { operations: protocol.openApiOperations(await request(url.href), origins), origins };
  }
  if (fallback) return { operations: fallback.operations, origins: fallback.origins };
  // Discovery is anonymous and confined to already authorised API origins.
  // Missing schema documents are not permission to guess data endpoints.
  for (const origin of origins.slice(0, 3)) {
    for (const path of ["/.well-known/openapi.json", "/openapi.json", "/swagger.json"]) {
      try {
        const url = checkUrl(origin + path, origins), spec = await request(url.href, { signal: AbortSignal.timeout(4000) });
        if (spec.openapi) return { operations: protocol.openApiOperations(spec, origins), origins };
      } catch (e) { if (e.status && ![404, 403, 401].includes(e.status)) throw e; }
    }
  }
  return { operations: [], origins, reason: "The connection has not supplied a readable API description." };
}

function httpInvoke(request, origins, token, auth = {}) {
  return async (op, args) => {
    const url = checkUrl(op.url, origins), body = {};
    for (const [key, value] of Object.entries(args)) {
      if (op.locations?.[key] === "body") body[key] = value;
      else if (op.locations?.[key] === "path") {
        if (!["string", "number"].includes(typeof value) || [".", ".."].includes(String(value))) throw new Error("Invalid record path argument");
        url.pathname = url.pathname.replaceAll(`%7B${key}%7D`, encodeURIComponent(String(value)));
      }
      else if (value != null) url.searchParams.set(key, String(value));
    }
    if (/%7B|%7D|[{}]/i.test(url.pathname)) throw new Error("The API path still needs a scope argument");
    const headers = { Accept: "application/json", "User-Agent": "ClosedHand" };
    // The credential is injected at execution. It never enters a recipe or a
    // model prompt, nor a pagination URL supplied by the source.
    if (auth.type === "header") {
      if (!/^[\w-]+$/.test(auth.name || "") || /^(host|cookie|content-|proxy-)/i.test(auth.name)) throw new Error("Invalid source authentication header");
      headers[auth.name] = token;
    } else headers.Authorization = `Bearer ${token}`;
    const options = { method: op.method, headers };
    if (op.method === "POST") { headers["Content-Type"] = "application/json"; options.body = JSON.stringify(body); }
    return request(url.href, options);
  };
}

async function prepare(operations, descriptor, previous, invoke) {
  if (operations.length > MAX_OPERATIONS) throw new Error("The source description is too large; select the collections to remember");
  const signature = protocol.digest([protocol.VERSION, protocol.operationSignature(operations), descriptor]);
  const reusable = previous?.signature === signature && previous.plan;
  if (reusable && !previous.plan.skipped.some(s => /record fields|sample/.test(s.reason))) {
    // Revalidation is deterministic, independent of the primary LLM.
    for (const r of previous.plan.recipes) protocol.validateRecipe(r, operations.find(o => o.id === r.operation));
    return { plan: previous.plan, signature };
  }
  const saved = [...(descriptor.collections || []), ...(reusable ? previous.plan.recipes : [])];
  let plan = protocol.compile(operations, saved);
  const samples = new Map();
  // Older MCPs sometimes return JSON text but omit outputSchema. A bounded
  // read of a declared read-only list operation can establish its shape. Never
  // invent required scopes, search terms or action arguments to make it run.
  for (const op of operations) {
    if (plan.recipes.some(r => r.operation === op.id) || protocol.eligibility(op, op.hint).mode !== "candidate") continue;
    if (!/\b(list|all|browse|export)\b/.test(String(op.name).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_/.-]/g, " "))) continue;
    if (protocol.collectionSchema(op.outputSchema, op.root || op.outputSchema).length) continue;
    const props = op.inputSchema?.properties || {}, args = {};
    for (const [name, p] of Object.entries(props)) {
      if (/^(limit|page_size|per_page|pageSize|max_results)$/.test(name)) args[name] = Math.min(100, p.maximum || p.default || 100);
      else if (/^(page|page_number)$/.test(name)) args[name] = p.default ?? 1;
      else if (/^(offset|skip)$/.test(name)) args[name] = 0;
      else if (p.default !== undefined) args[name] = p.default;
    }
    if ((op.inputSchema?.required || []).some(k => !(k in args))) continue;
    try {
      const data = await invoke(op, args);
      samples.set(op.id, { args, data });
      op.outputSchema = protocol.sampleSchema(data);
    } catch (e) {
      if ([401, 403].includes(e.status)) throw e;
      op.discoveryError = "The collection sample could not be read.";
    }
  }
  plan = protocol.compile(operations, saved);
  return { plan, signature, invoke: async (op, args) => {
    const sample = samples.get(op.id);
    if (sample && protocol.digest(sample.args) === protocol.digest(args)) { samples.delete(op.id); return sample.data; }
    return invoke(op, args);
  } };
}
module.exports = { checkUrl, descriptorFor, stateFor, discoverHttp, httpInvoke, prepare };
