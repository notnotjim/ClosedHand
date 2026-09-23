// Background readers run in the bot. Discovery creates data-only recipes;
// the same deterministic protocol executes API and MCP collections.
const crypto = require("node:crypto");
const { legacyDescription, requestJson } = require("./recall-adapters");
const protocol = require("./recall-protocol");
const discovery = require("./recall-discovery");
const { unchanged, usesExistingReader } = require("./recall-settings");
const INTERVAL_MS = 15 * 60 * 1000;
const inflight = new Map();
const hash = text => crypto.createHash("sha256").update(text).digest("hex");

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
      const [connections, servers, states] = await Promise.all([rows("connections", userId, "id, service, sync_should_cache, config"), rows("user_mcps", userId, "id, status, caps"), rows("index_progress", userId, "id, service")]);
      return new Set([
        ...connections.filter(c => c.sync_should_cache !== false && discovery.descriptorFor(c).enabled !== false).map(c => `connected:${c.service}`),
        ...servers.filter(s => s.status === "connected" && discovery.descriptorFor(s).enabled !== false).map(s => `mcp:${s.id}`),
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
    if (protocol.digest([discovery.descriptorFor(live), live.config?.recall_api]) !== protocol.digest([discovery.descriptorFor(row), row.config?.recall_api]) || discovery.descriptorFor(live).enabled === false) return false;
    if (table === "user_mcps") return live.status === "connected" && live.server_url === row.server_url && live.name === row.name && protocol.digest([live.command, live.args, live.env, live.headers]) === protocol.digest([row.command, row.args, row.env, row.headers]);
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
      for (const row of page) out.set(row.external_id, { hash: row.data?._recall_hash, collection: row.data?.metadata?.collection || (source.startsWith("mcp:") ? "resources" : "issues") });
      if (page.length < 500) return out;
    }
  }
  async function saveBatch(userId, source, row, items, old, seen, collection = "resources") {
    await ensureCurrent(userId, source, row);
    const pieces = [];
    for (const item of items) {
      if (item.deleted) {
        const prefix = hash(`${collection}\0${item.id}`);
        const ids = [...old.keys()].filter(id => id.startsWith(prefix + ":"));
        if (ids.length) {
          await mustWrite(db.from("data_vectors").delete().eq("user_id", userId).eq("service", source).in("external_id", ids));
          await mustWrite(db.from("data_cache").delete().eq("user_id", userId).eq("source", source).in("external_id", ids));
        }
        continue;
      }
      if (!item.id || typeof item.text !== "string") throw new Error("Invalid source item");
      // Keep full text in bounded passages so a fact late in a document is
      // searchable too. Labels and all source content remain untrusted data.
      if (item.text.length > 200000) throw new Error("Resource exceeds 200,000 characters; sync is incomplete");
      const text = `${item.title || ""}\n${item.text}`.trim();
      const prefix = hash(collection === "resources" ? item.id : `${collection}\0${item.id}`);
      const itemIds = new Set();
      for (let start = 0, part = 0; start < text.length; start += 1600, part++) {
        const body = text.slice(start, start + 1800);
        const id = `${prefix}:${part}`;
        seen.add(id);
        itemIds.add(id);
        const metadata = { source_name: item.source_name, title: item.title, uri: item.url || item.id, date: item.updated_at || null, collection };
        const fingerprint = hash(JSON.stringify([body, metadata]));
        if (old.get(id)?.hash !== fingerprint) {
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
      // A complete record can get shorter even when the collection itself is
      // partial. Remove that record's obsolete tail without touching unseen
      // records elsewhere in the source.
      const tail = [...old.keys()].filter(id => id.startsWith(prefix + ":") && !itemIds.has(id));
      if (tail.length) {
        await mustWrite(db.from("data_vectors").delete().eq("user_id", userId).eq("service", source).in("external_id", tail));
        await mustWrite(db.from("data_cache").delete().eq("user_id", userId).eq("source", source).in("external_id", tail));
      }
    }
    // Scoped hashes skip unchanged embeddings and retry previously failed ones.
    for (let at = 0; at < pieces.length; at += 50) {
      await ensureCurrent(userId, source, row);
      await indexItems(userId, source, "resource", pieces.slice(at, at + 50), { scoped: true });
    }
    await ensureCurrent(userId, source, row);
  }
  async function reconcile(userId, source, old, seen, collection) {
    const removed = [...old.keys()].filter(id => (!collection || old.get(id).collection === collection) && !seen.has(id));
    for (let i = 0; i < removed.length; i += 100) {
      const ids = removed.slice(i, i + 100);
      await mustWrite(db.from("data_vectors").delete().eq("user_id", userId).eq("service", source).in("external_id", ids));
      await mustWrite(db.from("data_cache").delete().eq("user_id", userId).eq("source", source).in("external_id", ids));
    }
  }
  async function saveState(userId, source, row, state) {
    await ensureCurrent(userId, source, row);
    const table = source.startsWith("mcp:") ? "user_mcps" : "connections", field = table === "connections" ? "config" : "caps";
    const live = (await read(db.from(table).select("*").eq("user_id", userId).eq("id", row.id)))[0];
    if (!live) throw new Error("Connection removed during discovery");
    const value = { ...(live[field] || {}), recall_state: { ...state, checked_at: new Date(now()).toISOString() } };
    const query = db.from(table).update({ [field]: value, updated_at: new Date(now()).toISOString() }).eq("user_id", userId).eq("id", row.id);
    const { data: written, error: writeError } = await unchanged(query, field, live[field], live.updated_at).select("id");
    if (writeError || !written?.length) throw new Error("The connection changed while its recipe was being saved");
    const fresh = (await read(db.from(table).select("*").eq("user_id", userId).eq("id", row.id)))[0];
    if (fresh) Object.assign(row, fresh);
  }
  async function tokenFor(userId, conn) {
    let tokens = decryptTokens(conn.tokens);
    if (tokens?.expiry && Number(tokens.expiry) <= now() + 60000 && tokens.refresh_token) {
      const api = conn.config?.recall_api, refresh = api?.refresh || (conn.service === "gitlab" ? { url: "https://gitlab.com/oauth/token", auth: "body", envPrefix: "GITLAB" } : null);
      if (!refresh) throw new Error("Reconnect this source to renew access");
      const url = discovery.checkUrl(refresh.url, api?.origins || legacyDescription(conn.service)?.origins || []);
      const clientId = env[`${refresh.envPrefix}_CLIENT_ID`], clientSecret = env[`${refresh.envPrefix}_CLIENT_SECRET`];
      if (!clientId || !clientSecret) throw new Error("Reconnect this source to renew access");
      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
      const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      if (refresh.auth === "basic") headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
      else { body.set("client_id", clientId); body.set("client_secret", clientSecret); }
      const renewed = await request(url.href, { method: "POST", headers, body: body.toString() });
      if (!renewed.access_token) throw new Error("The source did not renew access");
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
        const value = resource._meta?.["closedhand/recall"] || {};
        if (protocol.eligibility({ name: `read ${resource.name || ""} ${resource.uri}`, description: resource.description, readOnly: true }, value).mode !== "candidate") continue;
        const result = await client.readResource({ uri: resource.uri }, { timeout: 30000 });
        if (!Array.isArray(result.contents)) throw new Error("MCP returned invalid resource content");
        // Binary files and parameterised templates need their existing file/tool
        // path. Only the server's explicitly enumerated text is read here.
        const text = result.contents.filter(c => typeof c.text === "string").map(c => protocol.resourceText(c.text)).filter(Boolean).join("\n\n");
        if (text) yield [{ id: resource.uri, title: resource.title || resource.name || resource.uri, text, source_name: name, url: resource.uri }];
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
    const old = await existing(userId, source);
    let opened;
    try {
      await progress(userId, source, { status: "reading" });
      let operations, invoke, resourceReader = false;
      const descriptor = discovery.descriptorFor(row), state = discovery.stateFor(row), results = [];
      if (source.startsWith("mcp:")) {
        opened = await mcp.openClient(row, { connectTimeoutMs: 20000, save: patch => mustWrite(db.from("user_mcps").update(patch).eq("user_id", userId).eq("id", row.id)) });
        const caps = opened.client.getServerCapabilities() || {};
        resourceReader = !!caps.resources;
        const tools = [];
        if (caps.tools && opened.client.listTools) {
          let cursor; const visited = new Set();
          for (let page = 0; page < 20; page++) {
            const listed = await opened.client.listTools(cursor ? { cursor } : {}, { timeout: 30000 });
            tools.push(...listed.tools);
            if (!listed.nextCursor) break;
            if (visited.has(listed.nextCursor) || page === 19) throw new Error("Tool discovery is incomplete");
            visited.add(listed.nextCursor); cursor = listed.nextCursor;
          }
        }
        operations = protocol.mcpOperations(tools);
        invoke = async (op, args) => protocol.decodeTool(await opened.client.callTool({ name: op.id, arguments: args }, undefined, { timeout: 30000 }));
      } else {
        const found = await discovery.discoverHttp(row, request, legacyDescription(row.service));
        operations = found.operations;
        invoke = discovery.httpInvoke(request, found.origins, operations.length ? await tokenFor(userId, row) : "", row.config?.recall_api?.auth);
      }
      const prepared = await discovery.prepare(operations, descriptor, state, invoke);
      const plan = prepared.plan; invoke = prepared.invoke || invoke;
      const sourceInvoke = invoke; let requests = 0;
      invoke = async (op, args) => {
        if (++requests > 300) throw new Error("Source read limit reached; some collections remain incomplete");
        await ensureCurrent(userId, source, row);
        return sourceInvoke(op, args);
      };
      let total = 0;
      if (resourceReader) {
        const seen = new Set();
        try {
          for await (const batch of resources(opened.client, row.name)) await saveBatch(userId, source, row, batch, old, seen, "resources");
          await ensureCurrent(userId, source, row);
          await reconcile(userId, source, old, seen, "resources");
          results.push({ id: "resources", status: "synced", passages: seen.size }); total += seen.size;
        } catch (e) { if ([401, 403].includes(e.status)) throw e; results.push({ id: "resources", status: "error", reason: e.message }); }
      }
      for (const recipe of plan.recipes) {
        const seen = new Set(), op = operations.find(o => o.id === recipe.operation);
        try {
          for await (const batch of protocol.run(recipe, op, invoke, row.name || row.service, { operations, recipes: plan.recipes })) await saveBatch(userId, source, row, batch, old, seen, recipe.id);
          await ensureCurrent(userId, source, row);
          if (recipe.complete) await reconcile(userId, source, old, seen, recipe.id);
          results.push({ id: recipe.id, status: recipe.complete ? "synced" : "partial", passages: seen.size }); total += seen.size;
        } catch (e) {
          if ([401, 403].includes(e.status)) { await purge(userId, source); throw e; }
          results.push({ id: recipe.id, status: "error", reason: e.message });
        }
      }
      await ensureCurrent(userId, source, row);
      // A collection that has become transient, lost its reader, or changed to
      // an unreadable schema must stop supplying old context. Cache copies are
      // derived data; the original records stay at their source.
      const kept = new Set([...(resourceReader ? ["resources"] : []), ...plan.recipes.map(r => r.id)]);
      for (const collection of new Set([...old.values()].map(v => v.collection))) {
        if (!kept.has(collection)) await reconcile(userId, source, old, new Set(), collection);
      }
      const status = results.some(r => r.status === "error") ? "error" : results.some(r => r.status === "partial") ? "partial" : results.length ? total ? "synced" : "empty" : "on_demand";
      await saveState(userId, source, row, { signature: prepared.signature, plan, status, collections: results, reason: !operations.length && !resourceReader ? "No readable source description is available." : undefined });
      await progress(userId, source, { status, ...(status !== "error" ? { last_sync: new Date(now()).toISOString() } : {}), phase1_total: total, phase1_done: total });
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
        if (usesExistingReader(row)) continue;
        if (row.sync_should_cache === false || discovery.descriptorFor(row).enabled === false) {
          if (state.get(`recall:${source}`)?.status !== "on_demand") await progress(userId, source, { status: "on_demand" });
          continue;
        }
        live.add(source);
        await syncSource(userId, row, source, state.get(`recall:${source}`));
      }
      for (const row of servers) {
        if (row.status !== "connected" || discovery.descriptorFor(row).enabled === false) continue;
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
