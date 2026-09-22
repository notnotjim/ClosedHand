// Reviewed read-only collections. Connecting a service does not authorise the
// synchroniser to invent endpoints or invoke action tools.
const ADAPTERS = {
  github: { name: "GitHub", origin: "https://api.github.com", path: "/issues", params: { filter: "all", state: "all", sort: "created", direction: "asc" } },
  gitlab: { name: "GitLab", origin: "https://gitlab.com", path: "/api/v4/issues", params: { scope: "all", state: "all", order_by: "created_at", sort: "asc" } },
};

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    const error = new Error(`Source request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error("Source page exceeds the read limit");
  return JSON.parse(text);
}

async function* oauthItems(service, token, request = requestJson) {
  const adapter = ADAPTERS[service];
  if (!adapter) throw new Error("No background reader for this service");
  const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const url = new URL(adapter.path, adapter.origin);
    for (const [key, value] of Object.entries({ ...adapter.params, per_page: 100, page })) url.searchParams.set(key, value);
    const rows = await request(url.href, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "ClosedHand" } });
    if (!Array.isArray(rows)) throw new Error("Source returned an invalid collection");
    const items = rows.map(row => {
      if (row.id == null) throw new Error("Source item has no stable ID");
      const id = String(row.id);
      if (seen.has(id)) throw new Error("Source pagination repeated an item; retrying next cycle");
      seen.add(id);
      const text = [row.title, `State: ${row.state || "unknown"}`, row.body || row.description || "", row.due_date ? `Due: ${row.due_date}` : ""].filter(Boolean).join("\n");
      return { id, text, title: row.title || "Issue", url: row.html_url || row.web_url || "", updated_at: row.updated_at, source_name: adapter.name };
    });
    yield items;
    if (rows.length < 100) return;
  }
  throw new Error("Source exceeds 10,000 records; background sync is incomplete");
}

module.exports = { ADAPTERS, requestJson, oauthItems };
