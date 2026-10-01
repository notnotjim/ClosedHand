// lib/workspace-cache.js — Workspace file cache for cloud computer
// Keeps an up-to-date listing of /workspace files in Supabase metadata
// so the bot always knows what the user has without runtime latency.

const { supabase } = require("../user-store");

/**
 * Fetch the current /workspace listing from the sandbox and cache it in Supabase.
 * Returns the cached data or null if sandbox is unreachable.
 */
async function refreshWorkspaceCache(userId) {
  try {
    const { sandboxFileList, getSandboxInfo } = require("./sandbox");
    const info = await getSandboxInfo(userId);
    if (!info) return null;

    const result = await sandboxFileList(userId, "/workspace");
    const files = result?.files || result?.entries || [];

    const cacheData = {
      files: files.map(f => ({
        name: f.name,
        size: f.size || 0,
        type: f.type || (f.isDirectory ? "directory" : "file"),
      })).slice(0, 150),
      cached_at: new Date().toISOString(),
    };

    // Merge into existing metadata
    const { data: sandbox } = await supabase
      .from("sandboxes")
      .select("metadata")
      .eq("user_id", userId)
      .single();

    const metadata = sandbox?.metadata || {};
    metadata.workspace_files = cacheData;

    await supabase
      .from("sandboxes")
      .update({ metadata })
      .eq("user_id", userId);

    return cacheData;
  } catch (e) {
    // Sandbox sleeping or unreachable, silently fail
    return null;
  }
}

/**
 * Format cached file listing for system prompt injection.
 * Compact tree-like format, capped at ~2000 chars.
 */
function formatWorkspaceListing(files) {
  if (!files || files.length === 0) return "(empty)";

  const lines = [];
  const dirs = files.filter(f => f.type === "directory").sort((a, b) => a.name.localeCompare(b.name));
  const regularFiles = files.filter(f => f.type !== "directory").sort((a, b) => a.name.localeCompare(b.name));

  for (const d of dirs) {
    lines.push(`  ${d.name}/`);
  }
  for (const f of regularFiles) {
    const sizeStr = f.size > 0 ? ` (${formatSize(f.size)})` : "";
    lines.push(`  ${f.name}${sizeStr}`);
  }

  let result = lines.join("\n");
  if (result.length > 2000) {
    const truncated = result.substring(0, 1900);
    const shown = truncated.split("\n").length;
    result = truncated + `\n  ... and ${files.length - shown} more files`;
  }
  return result;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

/**
 * Background-safe cache refresh after a file-mutating tool.
 * Call fire-and-forget: refreshAfterMutation(userId, userStore)
 */
function refreshAfterMutation(userId, userStore) {
  refreshWorkspaceCache(userId).then(cache => {
    if (cache && userStore) userStore.workspaceFiles = cache;
  }).catch(() => {});
}

/**
 * Non-blocking cache refresh on session start.
 * Only refreshes if cache is stale (>5 min) or missing.
 */
function maybeRefreshOnSessionStart(userStore, userId) {
  const cache = userStore.workspaceFiles;
  const staleMs = 5 * 60 * 1000;
  if (!cache || !cache.cached_at || Date.now() - new Date(cache.cached_at).getTime() > staleMs) {
    refreshWorkspaceCache(userId).then(files => {
      if (files) userStore.workspaceFiles = files;
    }).catch(() => {});
  }
}

module.exports = {
  refreshWorkspaceCache,
  formatWorkspaceListing,
  refreshAfterMutation,
  maybeRefreshOnSessionStart,
};
