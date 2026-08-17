// lib/sandbox.js — Sandbox container management.
//
// Two providers. "railway" provisions one container per user on demand via the
// Railway API (the hosted deployment). "static" talks to a single fixed
// container (the self-host compose service): SANDBOX_URL + SANDBOX_TOKEN from
// env, no provisioning, no janitor, destroy is a no-op. Selected by
// SANDBOX_PROVIDER, else inferred: SANDBOX_URL set → static, else railway.

const crypto = require("crypto");
const { makeRawRequest } = require("./http");
const ctx = require("./context");
const { supabase } = require("../user-store");

const RAILWAY_API_URL = "https://backboard.railway.app/graphql/v2";
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
const RAILWAY_PROJECT_ID = process.env.RAILWAY_PROJECT_ID;
const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID; // production env
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "ghcr.io/notnotjim/closedhand-sandbox:latest";

const SANDBOX_PORT = 8080;
const REQUEST_TIMEOUT = 35000;
const WAKE_TIMEOUT = 15000;
const MAX_RESPONSE = 8000;

// --- Provider selection (static single container vs Railway provisioning) ---
const SANDBOX_URL = process.env.SANDBOX_URL || "";
const SANDBOX_PROVIDER = (process.env.SANDBOX_PROVIDER || (SANDBOX_URL ? "static" : "railway")).toLowerCase();
const _staticInfo = (() => {
  if (SANDBOX_PROVIDER !== "static") return null;
  if (!SANDBOX_URL) return null;
  const u = new URL(SANDBOX_URL.includes("://") ? SANDBOX_URL : `http://${SANDBOX_URL}`);
  return {
    hostname: u.hostname,
    port: Number(u.port) || SANDBOX_PORT,
    token: process.env.SANDBOX_TOKEN || "",
    serviceId: "static",
  };
})();
function isStatic() { return SANDBOX_PROVIDER === "static"; }

// In-memory cache: userId -> { hostname, token, serviceId }
const sandboxCache = {};

// --- Railway GraphQL ---

async function railwayQuery(query, variables = {}) {
  if (!RAILWAY_API_TOKEN) throw new Error("RAILWAY_API_TOKEN not configured");
  const result = await makeRawRequest("POST", RAILWAY_API_URL, { query, variables }, {
    Authorization: `Bearer ${RAILWAY_API_TOKEN}`,
    "Content-Type": "application/json",
  });
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Railway API: ${result.errors[0].message}`);
  }
  return result.data;
}

// --- Container lifecycle ---

async function createSandbox(userId) {
  if (isStatic()) throw new Error("Static sandbox: the container is fixed by SANDBOX_URL, nothing to create");
  if (!RAILWAY_PROJECT_ID) throw new Error("No sandbox configured. Self-host: set SANDBOX_URL (the compose sandbox service). Hosted: set RAILWAY_PROJECT_ID.");

  const shortId = userId.replace(/-/g, "").substring(0, 8);
  const serviceName = `sb-${shortId}`;
  const sandboxToken = crypto.randomBytes(24).toString("hex");

  console.log(`Sandbox: creating container for user ${shortId}...`);

  // 1. Create service
  const createResult = await railwayQuery(`
    mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }
  `, {
    input: {
      projectId: RAILWAY_PROJECT_ID,
      name: serviceName,
      source: { image: SANDBOX_IMAGE },
    },
  });

  const serviceId = createResult.serviceCreate.id;

  // 2. Create volume. Railway's volumeCreate takes no size argument, the plan
  // default applies (currently 5GB), so nothing here can pick a smaller number.
  await railwayQuery(`
    mutation($input: VolumeCreateInput!) {
      volumeCreate(input: $input) { id }
    }
  `, {
    input: {
      projectId: RAILWAY_PROJECT_ID,
      serviceId,
      environmentId: RAILWAY_ENVIRONMENT_ID,
      mountPath: "/workspace",
    },
  });

  // 3. Set environment variables
  const gatewayUrl = `http://ClosedHand.railway.internal:${process.env.PORT || 3000}`;
  for (const [name, value] of Object.entries({
    SANDBOX_TOKEN: sandboxToken,
    PORT: String(SANDBOX_PORT),
    GATEWAY_URL: gatewayUrl,
    USER_ID: userId,
  })) {
    await railwayQuery(`
      mutation($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }
    `, {
      input: {
        projectId: RAILWAY_PROJECT_ID,
        serviceId,
        environmentId: RAILWAY_ENVIRONMENT_ID,
        name,
        value,
      },
    });
  }

  // 4. Set resource limits (1 vCPU, 512MB — Chromium needs ~200MB)
  try {
    await railwayQuery(`
      mutation($input: ServiceInstanceLimitsUpdateInput!) {
        serviceInstanceLimitsUpdate(input: $input)
      }
    `, {
      input: {
        serviceId,
        environmentId: RAILWAY_ENVIRONMENT_ID,
        vCPUs: 2,
        memoryGB: 1.5,
      },
    });
  } catch (e) {
    // Limits mutation may not be available on all plans — non-fatal
    console.log(`Sandbox: could not set resource limits: ${e.message}`);
  }

  // 5. Save to Supabase
  const hostname = `${serviceName}.railway.internal`;
  const record = {
    user_id: userId,
    railway_service_id: serviceId,
    hostname,
    sandbox_token: sandboxToken,
    status: "active",
    volume_size_mb: 5120, // Railway's provisioned default, see volumeCreate above
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
    total_exec_count: 0,
    metadata: {},
  };

  const { error: sandboxWriteError } = await supabase.from("sandboxes").upsert(record, { onConflict: "user_id" });
  // The row is how the janitor finds this container later. Without it the
  // container keeps running and nothing knows it exists.
  if (sandboxWriteError) console.error(`[Sandbox] provisioned but NOT recorded: ${sandboxWriteError.message}. It will not be cleaned up automatically.`);

  // Cache it
  sandboxCache[userId] = { hostname, token: sandboxToken, serviceId };

  // 6. Wait for deployment to be ready (poll /health)
  console.log(`Sandbox: waiting for ${serviceName} to be ready...`);
  const ready = await waitForReady(userId, 90000);
  if (!ready) {
    console.log(`Sandbox: ${serviceName} not ready after 90s, will retry on first request`);
  } else {
    console.log(`Sandbox: ${serviceName} is ready`);
    const { refreshWorkspaceCache } = require("./workspace-cache");
    refreshWorkspaceCache(userId).catch(() => {});
  }

  return record;
}

async function destroySandbox(userId) {
  if (isStatic()) {
    console.log("Sandbox: static provider, destroy is a no-op (the container belongs to the deployment)");
    return;
  }
  const info = await getSandboxInfo(userId);
  if (!info) throw new Error("No sandbox found");

  // Volumes don't cascade with serviceDelete, so detach+delete them first.
  for (const v of await _listVolumesForService(info.serviceId)) {
    await _deleteVolume(v.id).catch(e => console.error(`Sandbox: volume ${v.id} delete failed: ${e.message}`));
  }

  await railwayQuery(`
    mutation($id: String!) { serviceDelete(id: $id) }
  `, { id: info.serviceId });

  await supabase.from("sandboxes")
    .update({ status: "destroyed" })
    .eq("user_id", userId);

  delete sandboxCache[userId];
  console.log(`Sandbox: destroyed for user ${userId.substring(0, 8)}`);
}

async function _listVolumesForService(serviceId) {
  const result = await railwayQuery(`
    query($projectId: String!) {
      project(id: $projectId) {
        volumes { edges { node { id name volumeInstances { edges { node { serviceId } } } } } }
      }
    }
  `, { projectId: RAILWAY_PROJECT_ID });
  const edges = result.project?.volumes?.edges || [];
  return edges
    .map(e => e.node)
    .filter(v => (v.volumeInstances?.edges || []).some(ve => ve.node?.serviceId === serviceId));
}

async function _deleteVolume(volumeId) {
  await railwayQuery(`
    mutation($volumeId: String!) { volumeDelete(volumeId: $volumeId) }
  `, { volumeId });
  console.log(`Sandbox: deleted volume ${volumeId}`);
}

async function getSandboxInfo(userId) {
  // Static provider: one fixed container for the one owner, no DB row needed.
  if (isStatic()) return _staticInfo;

  // Check cache first
  if (sandboxCache[userId]) return sandboxCache[userId];

  // Load from Supabase
  const { data } = await supabase
    .from("sandboxes")
    .select("railway_service_id, hostname, sandbox_token, status")
    .eq("user_id", userId)
    .eq("status", "active")
    .single();

  if (!data) return null;

  const info = {
    hostname: data.hostname,
    token: data.sandbox_token,
    serviceId: data.railway_service_id,
  };
  sandboxCache[userId] = info;
  return info;
}

async function ensureSandbox(userId) {
  let info = await getSandboxInfo(userId);
  if (!info) {
    await createSandbox(userId);
    info = await getSandboxInfo(userId);
  }
  if (!info) throw new Error("Failed to create sandbox");

  // Try to wake it
  try {
    await sandboxRequest(userId, "GET", "/health", null, 5000);
  } catch {
    // May need more time to wake
    await sleep(3000);
    try {
      await sandboxRequest(userId, "GET", "/health", null, WAKE_TIMEOUT);
    } catch (e) {
      throw new Error(`Sandbox not responding: ${e.message}`);
    }
  }

  // Update last_used_at (railway bookkeeping; the static container has no row)
  if (!isStatic()) {
    await supabase.from("sandboxes")
      .update({ last_used_at: new Date().toISOString() })
      .eq("user_id", userId);
  }

  return info;
}

async function waitForReady(userId, maxWait) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await sandboxRequest(userId, "GET", "/health", null, 5000);
      return true;
    } catch {
      await sleep(3000);
    }
  }
  return false;
}

// --- HTTP proxy to sandbox containers ---

async function sandboxRequest(userId, method, path, body, timeout) {
  const info = await getSandboxInfo(userId);
  if (!info) throw new Error("No sandbox found");

  const url = `http://${info.hostname}:${info.port || SANDBOX_PORT}${path}`;
  const headers = {
    "X-Sandbox-Token": info.token,
    "Content-Type": "application/json",
  };

  try {
    // The timeout argument used to be accepted and dropped, so every sandbox
    // call inherited the 20s default while telling the sandbox it had longer.
    // Browser actions then failed client-side while Chrome was still working.
    const result = await makeRawRequest(method, url, body, headers, timeout || 20000);
    return result;
  } catch (e) {
    // If connection refused, sandbox might be sleeping — rethrow for caller to handle
    throw e;
  }
}

function truncateResult(result) {
  if (typeof result === "string" && result.length > MAX_RESPONSE) {
    return result.substring(0, MAX_RESPONSE) + `\n... (truncated)`;
  }
  if (result && typeof result === "object") {
    const str = JSON.stringify(result);
    if (str.length > MAX_RESPONSE * 2) {
      // Truncate individual string fields
      for (const key of Object.keys(result)) {
        if (typeof result[key] === "string" && result[key].length > MAX_RESPONSE) {
          result[key] = result[key].substring(0, MAX_RESPONSE) + `\n... (truncated)`;
        }
      }
    }
  }
  return result;
}

// --- Sandbox operation wrappers ---

async function sandboxExec(userId, language, code, timeoutMs = 30000) {
  // Rate limiting check
  const { data: sandbox } = await supabase
    .from("sandboxes")
    .select("total_exec_count, metadata")
    .eq("user_id", userId)
    .single();

  if (sandbox) {
    const today = new Date().toISOString().split("T")[0];
    const dailyCount = sandbox.metadata?.daily_exec?.[today] || 0;
    if (dailyCount >= 200) {
      return { error: "Daily execution limit reached (200/day). Try again tomorrow." };
    }
  }

  const scriptTimeout = Math.min(timeoutMs, 120000);
  const result = await sandboxRequest(userId, "POST", "/exec", {
    language,
    code,
    timeout_ms: scriptTimeout,
  }, scriptTimeout + 15000); // headroom so the client outlives the script

  // Update counters
  const today = new Date().toISOString().split("T")[0];
  const meta = sandbox?.metadata || {};
  if (!meta.daily_exec) meta.daily_exec = {};
  meta.daily_exec[today] = (meta.daily_exec[today] || 0) + 1;
  // Clean old days
  for (const key of Object.keys(meta.daily_exec)) {
    if (key < today) delete meta.daily_exec[key];
  }

  await supabase.from("sandboxes")
    .update({
      total_exec_count: (sandbox?.total_exec_count || 0) + 1,
      last_used_at: new Date().toISOString(),
      metadata: meta,
    })
    .eq("user_id", userId);

  return truncateResult(result);
}

async function sandboxFileRead(userId, filePath) {
  return truncateResult(await sandboxRequest(userId, "POST", "/files/read", { path: filePath }));
}

async function sandboxFileWrite(userId, filePath, content, encoding) {
  return await sandboxRequest(userId, "POST", "/files/write", { path: filePath, content, encoding });
}

async function sandboxFileList(userId, dirPath) {
  return await sandboxRequest(userId, "POST", "/files/list", { path: dirPath || "." });
}

async function sandboxFileDelete(userId, filePath) {
  return await sandboxRequest(userId, "POST", "/files/delete", { path: filePath });
}

async function sandboxFileDownload(userId, filePath) {
  return await sandboxRequest(userId, "POST", "/files/download", { path: filePath });
}

async function sandboxPackageInstall(userId, manager, packages) {
  return await sandboxRequest(userId, "POST", "/packages/install", { manager, packages });
}

async function sandboxPackageList(userId, manager) {
  return await sandboxRequest(userId, "POST", "/packages/list", { manager });
}

async function getSandboxStatus(userId) {
  if (isStatic()) {
    let agentStatus = "unknown";
    try {
      const health = await sandboxRequest(userId, "GET", "/health", null, 5000);
      agentStatus = health.status || "ok";
    } catch {
      agentStatus = "unreachable";
    }
    return { exists: true, status: "static", agentStatus };
  }

  const { data } = await supabase
    .from("sandboxes")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data || data.status === "destroyed") {
    return { exists: false, status: "not_created" };
  }

  let agentStatus = "unknown";
  try {
    const health = await sandboxRequest(userId, "GET", "/health", null, 5000);
    agentStatus = health.status || "ok";
  } catch {
    agentStatus = "sleeping";
  }

  return {
    exists: true,
    status: data.status,
    agentStatus,
    created_at: data.created_at,
    last_used_at: data.last_used_at,
    total_exec_count: data.total_exec_count,
    volume_size_mb: data.volume_size_mb,
  };
}

// --- Auto-cleanup (call from daily cron) ---

async function cleanupStaleBoxes() {
  if (isStatic()) return;
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString();
  const ninetyDaysAgo = new Date(now - 90 * 86400000).toISOString();

  // Destroy sandboxes unused for 90+ days
  const { data: stale } = await supabase
    .from("sandboxes")
    .select("user_id, railway_service_id")
    .eq("status", "active")
    .lt("last_used_at", ninetyDaysAgo);

  for (const box of (stale || [])) {
    try {
      await destroySandbox(box.user_id);
      console.log(`Sandbox: auto-destroyed stale sandbox for user ${box.user_id.substring(0, 8)}`);
    } catch (e) {
      console.error(`Sandbox: cleanup error for ${box.user_id.substring(0, 8)}: ${e.message}`);
    }
  }

  // Log warning for 30+ days unused
  const { data: aging } = await supabase
    .from("sandboxes")
    .select("user_id")
    .eq("status", "active")
    .lt("last_used_at", thirtyDaysAgo)
    .gte("last_used_at", ninetyDaysAgo);

  if (aging && aging.length > 0) {
    console.log(`Sandbox: ${aging.length} sandbox(es) unused for 30+ days`);
  }
}

// Reconcile Railway-side sandbox services and volumes against Supabase truth.
// Anything sb-* on Railway that isn't tied to an active Supabase sandbox row is an orphan.
// dryRun: log targets without deleting (default true for safety).
async function reconcileOrphans({ dryRun = true } = {}) {
  if (isStatic()) return;
  if (!RAILWAY_PROJECT_ID) { console.log("Sandbox: reconcile skipped (no RAILWAY_PROJECT_ID)"); return; }

  const { data: active } = await supabase
    .from("sandboxes")
    .select("railway_service_id")
    .eq("status", "active");
  const validServiceIds = new Set((active || []).map(r => r.railway_service_id).filter(Boolean));

  const result = await railwayQuery(`
    query($projectId: String!) {
      project(id: $projectId) {
        services { edges { node { id name } } }
        volumes  { edges { node { id name volumeInstances { edges { node { serviceId } } } } } }
      }
    }
  `, { projectId: RAILWAY_PROJECT_ID });

  const services = (result.project?.services?.edges || []).map(e => e.node);
  const volumes = (result.project?.volumes?.edges || []).map(e => e.node);

  const orphanServices = services.filter(s => /^sb-/.test(s.name) && !validServiceIds.has(s.id));
  const orphanServiceIds = new Set(orphanServices.map(s => s.id));
  const orphanVolumes = volumes.filter(v => {
    if (!/^sb-/.test(v.name)) return false;
    const attached = (v.volumeInstances?.edges || []).map(ve => ve.node?.serviceId).filter(Boolean);
    if (attached.length === 0) return true; // detached
    return attached.every(sid => orphanServiceIds.has(sid)); // attached only to orphan services
  });

  console.log(`Sandbox: reconcile found ${orphanServices.length} orphan service(s), ${orphanVolumes.length} orphan volume(s) [dryRun=${dryRun}]`);
  for (const s of orphanServices) console.log(`  service orphan: ${s.name} (${s.id})`);
  for (const v of orphanVolumes) console.log(`  volume orphan:  ${v.name} (${v.id})`);
  if (dryRun) return { orphanServices, orphanVolumes };

  for (const v of orphanVolumes) {
    await _deleteVolume(v.id).catch(e => console.error(`Sandbox: volume ${v.id} delete failed: ${e.message}`));
  }
  for (const s of orphanServices) {
    try {
      await railwayQuery(`mutation($id: String!) { serviceDelete(id: $id) }`, { id: s.id });
      console.log(`Sandbox: deleted orphan service ${s.name} (${s.id})`);
    } catch (e) {
      console.error(`Sandbox: orphan service ${s.id} delete failed: ${e.message}`);
    }
  }
  return { orphanServices, orphanVolumes };
}

let _janitorTimer = null;
function startSandboxJanitor() {
  if (isStatic()) { console.log("Sandbox: static provider, janitor not needed"); return; }
  if (_janitorTimer) return;
  console.log("Sandbox: starting daily janitor (stale boxes + orphan reconcile)");
  const tick = async () => {
    try { await cleanupStaleBoxes(); } catch (e) { console.error(`Sandbox: cleanupStaleBoxes error: ${e.message}`); }
    try { await reconcileOrphans({ dryRun: false }); } catch (e) { console.error(`Sandbox: reconcileOrphans error: ${e.message}`); }
  };
  setTimeout(tick, 5 * 60 * 1000); // first run 5 min after boot
  _janitorTimer = setInterval(tick, 24 * 60 * 60 * 1000); // daily
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createSandbox,
  destroySandbox,
  ensureSandbox,
  getSandboxInfo,
  getSandboxStatus,
  sandboxExec,
  sandboxFileRead,
  sandboxFileWrite,
  sandboxFileList,
  sandboxFileDelete,
  sandboxFileDownload,
  sandboxPackageInstall,
  sandboxPackageList,
  cleanupStaleBoxes,
  reconcileOrphans,
  startSandboxJanitor,
};
