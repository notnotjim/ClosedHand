// Existing connections keep these data-only descriptions. They go through
// the same protocol as newly discovered APIs; no service-specific runner.
const protocol = require("./recall-protocol");
const ADAPTERS = {
  github: { name: "GitHub", origin: "https://api.github.com", path: "/issues", params: { filter: "all", state: "all", sort: "created", direction: "asc" } },
  gitlab: { name: "GitLab", origin: "https://gitlab.com", path: "/api/v4/issues", params: { scope: "all", state: "all", order_by: "created_at", sort: "asc" } },
};

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "error", signal: options.signal || AbortSignal.timeout(30000) });
  if (!response.ok) {
    const error = new Error(`Source request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("Source page exceeds the read limit");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

async function* oauthItems(service, token, request = requestJson) {
  const description = legacyDescription(service);
  if (!description) throw new Error("No background reader for this service");
  const op = description.operations[0], plan = protocol.compile(description.operations);
  const invoke = require("./recall-discovery").httpInvoke(request, description.origins, token);
  yield* protocol.run(plan.recipes[0], op, invoke, ADAPTERS[service].name);
}

function legacyDescription(service) {
  const a = ADAPTERS[service];
  if (!a) return null;
  return { origins: [a.origin], operations: [{ id: "issues", name: "list issues", readOnly: true, transport: "http", method: "GET", url: a.origin + a.path,
    inputSchema: { properties: Object.fromEntries([...Object.entries(a.params).map(([k, v]) => [k, { type: "string", default: v }]), ["page", { type: "integer", default: 1 }], ["per_page", { type: "integer", maximum: 100 }]]) },
    outputSchema: { type: "array", items: { type: "object", properties: Object.fromEntries(["id", "title", "body", "description", "state", "due_date", "html_url", "web_url", "updated_at"].map(k => [k, { type: "string" }])) } },
    hint: { value: "durable", items: "", fields: { id: "id", title: "title", text: ["title", "body", "description", "state", "due_date"], url: service === "github" ? "html_url" : "web_url", updated: "updated_at" } },
  }] };
}
module.exports = { ADAPTERS, requestJson, oauthItems, legacyDescription };
