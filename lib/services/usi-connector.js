// Background readers run in the bot, which discovers saved connections through
// the shared database. No webapp import, LLM endpoint guessing or action tools.
const crypto = require("node:crypto");
const { ADAPTERS, requestJson, oauthItems } = require("./recall-adapters");
const INTERVAL_MS = 15 * 60 * 1000;
const inflight = new Map();
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const dedicated = service => /^(google|microsoft)(_|$)/.test(service) || ["slack", "notion", "imap", "ics_calendar", "whatsapp", "telegram"].includes(service);

function createConnector({ db, indexItems, mcp, decryptTokens, encryptTokens, request = requestJson, now = Date.now, env = process.env }) {
  async function read(query) {
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data || [];
  }
  async function mustWrite(query) {
    const { error } = await query;
    if (error) throw new Error(error.message);
  }
  async function rows(table, userId, columns = "*") {
    const out = [];
    for (let offset = 0; ; offset += 500) {
      const page = await read(db.from(table).select(columns).eq("user_id", userId).order("id").range(offset, offset + 499));
      out.push(...page);
      if (page.length < 500) return out;
    }
  }
  async function activeSources(userId) {
    try {
      const [connections, servers, states] = await Promise.all([rows("connections", userId, "id, service, sync_should_cache"), rows("user_mcps", userId, "id, status"), rows("index_progress", userId, "id, service")]);
      return new Set([
        ...connections.filter(c => ADAPTERS[c.service] && c.sync_should_cache !== false).map(c => `connected:${c.service}`),
        ...servers.filter(s => s.status === "connected").map(s => `mcp:${s.id}`),
        ...states.filter(s => s.service.startsWith("retained:connected:")).map(s => s.service.slice(9)),
      ]);
    } catch (e) {
      console.error(`[Recall sync] Connection check failed: ${e.message}`);
      return new Set();
    }
  }
  async function progress(userId, source, patch) {
    await mustWrite(db.from("index_progress").upsert({ user_id: userId, service: `recall:${source}`, ...patch, updated_at: new Date(now()).toISOString() }, { onConflict: "user_id,service" }));
  }
  async function retained(userId, source) {
    if (!source.startsWith("connected:")) return false;
    return (await read(db.from("index_progress").select("id").eq("user_id", userId).eq("service", `retained:${source}`))).length > 0;
  }
  async function purge(userId, source) {
    await mustWrite(db.from("data_vectors").delete().eq("user_id", userId).eq("service", source));
    await mustWrite(db.from("data_cache").delete().eq("user_id", userId).eq("source", source));
  }
  async function isCurrent(userId, source, row) {
    const table = source.startsWith("mcp:") ? "user_mcps" : "connections";
    const found = await read(db.from(table).select("*").eq("user_id", userId).eq("id", row.id));
    const live = found[0];
    if (!live) return false;
    if (table === "user_mcps") return live.status === "connected" && live.server_url === row.server_url && live.name === row.name;
    return live.service === row.service && live.sync_should_cache !== false && String(live.updated_at) === String(row.updated_at);
  }
  async function ensureCurrent(userId, source, row) {
    if (await isCurrent(userId, source, row)) return;
    if (!(await retained(userId, source))) await purge(userId, source);
    throw new Error("Connection changed during sync");
  }
  async function existing(userId, source) {
    const out = new Map();
    for (let offset = 0; ; offset += 500) {
      const page = await read(db.from("data_cache").select("external_id, data").eq("user_id", userId).eq("source", source).order("id").range(offset, offset + 499));
      for (const row of page) out.set(row.external_id, row.data?._recall_hash);
      if (page.length < 500) return out;
    }
  }
  async function saveBatch(userId, source, row, items, old, seen) {
    await ensureCurrent(userId, source, row);
    const pieces = [];
    for (const item of items) {
      if (!item.id || typeof item.text !== "string") throw new Error("Invalid source item");
      // Keep full text in bounded passages so a fact late in a document is
      // searchable too. Labels and all source content remain untrusted data.
      if (item.text.length > 200000) throw new Error("Resource exceeds 200,000 characters; sync is incomplete");
      const text = `${item.title || ""}\n${item.text}`.trim();
      for (let start = 0, part = 0; start < text.length; start += 1600, part++) {
        const body = text.slice(start, start + 1800);
        const id = `${hash(item.id)}:${part}`;
        seen.add(id);
        const metadata = { source_name: item.source_name, title: item.title, uri: item.url || item.id, date: item.updated_at || null };
        const fingerprint = hash(JSON.stringify([body, metadata]));
        if (old.get(id) !== fingerprint) {
          // A changed/deleted record cannot retain its old vector if embedding
          // is temporarily unavailable; lexical retrieval still sees the update.
          await mustWrite(db.from("data_vectors").delete().eq("user_id", userId).eq("service", source).eq("external_id", id));
          await mustWrite(db.from("data_cache").upsert({ user_id: userId, source, type: "resource", external_id: id,
            data: { body, subject: item.title || "", metadata, _recall_hash: fingerprint },
            synced_at: new Date(now()).toISOString(),
          }, { onConflict: "user_id,source,external_id" }));
        }
        pieces.push({ external_id: id, text: body, metadata, _skipEnrich: true });
      }
    }
    // Scoped hashes skip unchanged embeddings and retry previously failed ones.
    for (let at = 0; at < pieces.length; at += 50) {
      await ensureCurrent(userId, source, row);
      await indexItems(userId, source, "resource", pieces.slice(at, at + 50), { scoped: true });
    }
    await ensureCurrent(userId, source, row);
  }
  async function reconcile(userId, source, old, seen) {
    const removed = [...old.keys()].filter(id => !seen.has(id));
    for (let i = 0; i < removed.length; i += 100) {
      const ids = removed.slice(i, i + 100);
      await mustWrite(db.from("data_vectors").delete().eq("user_id", userId).eq("service", source).in("external_id", ids));
      await mustWrite(db.from("data_cache").delete().eq("user_id", userId).eq("source", source).in("external_id", ids));
    }
  }
  async function tokenFor(userId, conn) {
    let tokens = decryptTokens(conn.tokens);
    if (tokens?.expiry && Number(tokens.expiry) <= now() + 60000 && conn.service === "gitlab" && tokens.refresh_token) {
      if (!env.GITLAB_CLIENT_ID || !env.GITLAB_CLIENT_SECRET) throw new Error("GitLab must be reconnected to renew access");
      const renewed = await request("https://gitlab.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: env.GITLAB_CLIENT_ID, client_secret: env.GITLAB_CLIENT_SECRET,
      }) });
      if (!renewed.access_token) throw new Error("GitLab did not renew access");
      tokens = { ...tokens, access_token: renewed.access_token, refresh_token: renewed.refresh_token || tokens.refresh_token, expiry: now() + Number(renewed.expires_in || 7200) * 1000 };
      await mustWrite(db.from("connections").update({ tokens: encryptTokens(tokens) }).eq("user_id", userId).eq("id", conn.id));
      // Some deployments update this timestamp with a database trigger.
      Object.assign(conn, (await read(db.from("connections").select("*").eq("user_id", userId).eq("id", conn.id)))[0]);
    }
    if (!tokens?.access_token) throw new Error("Reconnect this source to restore access");
    return tokens.access_token;
  }
  async function* resources(client, name) {
    if (!client.getServerCapabilities()?.resources) return;
    let cursor;
    const cursors = new Set(), uris = new Set();
    for (let page = 0; page < 100; page++) {
      const listed = await client.listResources(cursor ? { cursor } : {}, { timeout: 30000 });
      if (!Array.isArray(listed.resources)) throw new Error("MCP returned an invalid resource list");
      for (const resource of listed.resources) {
        if (!resource.uri || uris.has(resource.uri)) throw new Error("MCP resource list repeated or omitted a URI");
        uris.add(resource.uri);
        const result = await client.readResource({ uri: resource.uri }, { timeout: 30000 });
        if (!Array.isArray(result.contents)) throw new Error("MCP returned invalid resource content");
        // Binary files and parameterised templates need their existing file/tool
        // path. Only the server's explicitly enumerated text is read here.
        const text = result.contents.filter(c => typeof c.text === "string").map(c => c.text).join("\n\n");
        if (text.trim()) yield [{ id: resource.uri, title: resource.title || resource.name || resource.uri, text, source_name: name, url: resource.uri }];
      }
      if (!listed.nextCursor) return;
      if (cursors.has(listed.nextCursor)) throw new Error("MCP resource cursor repeated");
      cursors.add(listed.nextCursor);
      cursor = listed.nextCursor;
    }
    throw new Error("MCP resource listing exceeds the page limit; sync is incomplete");
  }
  async function syncSource(userId, row, source, previous) {
    const reconnected = row.updated_at && Date.parse(row.updated_at) > Date.parse(previous?.last_sync || 0);
    if (!reconnected && previous?.last_sync && now() - Date.parse(previous.last_sync) < INTERVAL_MS) return;
    if (previous?.status === "error" && now() - Date.parse(previous.updated_at) < INTERVAL_MS) return;
    const old = await existing(userId, source), seen = new Set();
    let opened;
    try {
      await progress(userId, source, { status: "reading" });
      let batches, onDemand = false;
      if (source.startsWith("mcp:")) {
        opened = await mcp.openClient(row, { connectTimeoutMs: 20000, save: patch => mustWrite(db.from("user_mcps").update(patch).eq("user_id", userId).eq("id", row.id)) });
        onDemand = !opened.client.getServerCapabilities()?.resources;
        batches = resources(opened.client, row.name);
      } else {
        batches = oauthItems(row.service, await tokenFor(userId, row), request);
      }
      for await (const batch of batches) await saveBatch(userId, source, row, batch, old, seen);
      await ensureCurrent(userId, source, row);
      // Only a fully read collection can prove an old item was removed. An
      // error, timeout or repeated page must never erase the rest of a source.
      await reconcile(userId, source, old, seen);
      await progress(userId, source, { status: onDemand ? "on_demand" : seen.size ? "synced" : "empty", last_sync: new Date(now()).toISOString(), phase1_total: seen.size, phase1_done: seen.size });
    } catch (e) {
      if ([401, 403].includes(e.status)) await purge(userId, source);
      await progress(userId, source, { status: "error" });
      console.error(`[Recall sync] ${source}: ${e.message}`);
    } finally {
      if (opened) await mcp.closeQuietly(opened.client, opened.transport);
      if (!(await isCurrent(userId, source, row)) && !(await retained(userId, source))) await purge(userId, source);
    }
  }
  async function syncConnectedServices(userId) {
    if (inflight.has(userId)) return inflight.get(userId);
    const run = (async () => {
      const [connections, servers, states] = await Promise.all([rows("connections", userId), rows("user_mcps", userId), rows("index_progress", userId)]);
      const state = new Map(states.map(s => [s.service, s]));
      const live = new Set();
      for (const row of connections) {
        const source = `connected:${row.service}`;
        if (dedicated(row.service)) continue;
        if (!ADAPTERS[row.service] || row.sync_should_cache === false) {
          if (state.get(`recall:${source}`)?.status !== "on_demand") await progress(userId, source, { status: "on_demand" });
          continue;
        }
        live.add(source);
        await syncSource(userId, row, source, state.get(`recall:${source}`));
      }
      for (const row of servers) {
        if (row.status !== "connected") continue;
        const source = `mcp:${row.id}`;
        live.add(source);
        await syncSource(userId, row, source, state.get(`recall:${source}`));
      }
      for (const saved of states) {
        if (!/^recall:(connected:|mcp:)/.test(saved.service)) continue;
        const source = saved.service.slice(7);
        if (!live.has(source) && !state.has(`retained:${source}`)) await purge(userId, source);
      }
    })();
    inflight.set(userId, run);
    try { return await run; } finally { inflight.delete(userId); }
  }
  return { syncConnectedServices, activeSources, purge };
}

let instance;
function connector() {
  if (!instance) instance = createConnector({ db: require("../../user-store").supabase,
    indexItems: (...args) => require("./usi").indexItems(...args), mcp: require("../mcp-client"),
    ...require("../../crypto-tokens"),
  });
  return instance;
}
module.exports = { createConnector, syncConnectedServices: userId => connector().syncConnectedServices(userId), activeSources: userId => connector().activeSources(userId) };
