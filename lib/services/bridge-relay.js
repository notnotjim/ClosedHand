// lib/services/bridge-relay.js -- Supabase Realtime message broker for Bridge requests
// Replaces slow HTTP relay (30-40s) with Supabase insert + Realtime subscription (~2s overhead).
// Bot inserts a row, webapp picks it up via Realtime, forwards to Bridge WS, writes result back.

const crypto = require("crypto");
const { supabase } = require("../../user-store");

/**
 * Send a Bridge request via Supabase message broker.
 * @param {string} userId - The user ID
 * @param {string} action - e.g. "calendar.list", "files.list", "files.read"
 * @param {object} params - Action parameters
 * @param {number} [timeoutMs=40000] - Timeout in ms
 * @returns {Promise<object>} The result data from Bridge
 */
async function bridgeRequest(userId, action, params, timeoutMs = 40000) {
  const id = crypto.randomUUID();
  const t0 = Date.now();

  // Insert pending request
  const { error: insertErr } = await supabase
    .from("bridge_requests")
    .insert({ id, user_id: userId, action, params: params || {}, status: "pending" });

  if (insertErr) {
    throw new Error(`Failed to insert bridge request: ${insertErr.message}`);
  }

  console.log(`[bridge-relay] Inserted request ${id}: userId=${userId}, action=${action}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let channel = null;
    let pollTimer = null;
    let timeoutTimer = null;

    function cleanup() {
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      // Delete the row (fire and forget)
      supabase.from("bridge_requests").delete().eq("id", id).then(() => {});
    }

    function settle(err, data) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    }

    function handleRow(row) {
      if (row.status === "completed") {
        console.log(`[bridge-relay] Request ${id} completed in ${Date.now() - t0}ms`);
        settle(null, row.result);
      } else if (row.status === "error") {
        console.log(`[bridge-relay] Request ${id} errored in ${Date.now() - t0}ms: ${row.error}`);
        settle(new Error(row.error || "Bridge request failed"));
      }
    }

    // Subscribe to Realtime changes on this specific row
    channel = supabase.channel(`bridge-req-${id}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "bridge_requests",
        filter: `id=eq.${id}`,
      }, (payload) => {
        handleRow(payload.new);
      })
      .subscribe();

    // Poll as fallback in case Realtime is slow or misses the event
    pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const { data } = await supabase
          .from("bridge_requests")
          .select("status, result, error")
          .eq("id", id)
          .single();
        if (data && (data.status === "completed" || data.status === "error")) {
          handleRow(data);
        }
      } catch (e) {
        // Ignore poll errors
      }
    }, 3000);

    // Timeout
    timeoutTimer = setTimeout(() => {
      console.log(`[bridge-relay] Request ${id} timed out after ${timeoutMs}ms`);
      settle(new Error(`Bridge request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

module.exports = { bridgeRequest };
