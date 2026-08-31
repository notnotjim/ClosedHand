// lib/bridge-server.js - WebSocket server for Bridge app connections
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const { supabase } = require("./db");

// Active bridge connections: userId -> { ws, lastSeen }
const bridges = new Map();
// Pending pairing codes: code -> { ws, timestamp }
const pendingPairs = new Map();

function setupBridgeServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = req.url.split("?")[0];
    if (pathname === "/bridge") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (ws) => {
    let userId = null;

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "pair") {
          // Bridge app is sending a pairing code
          const code = (msg.code || "").toUpperCase();
          if (code.length === 6) {
            pendingPairs.set(code, { ws, timestamp: Date.now() });
            ws.send(JSON.stringify({ type: "waiting", message: "Waiting for pairing confirmation from dashboard..." }));
          }
        }

        else if (msg.type === "auth") {
          // Bridge app reconnecting with saved token
          const token = msg.token;
          if (!token) return;

          // Verify token against Supabase
          const { data: bridge } = await supabase
            .from("user_bridges")
            .select("user_id")
            .eq("token", token)
            .single();

          if (bridge) {
            userId = bridge.user_id;
            bridges.set(userId, { ws, lastSeen: Date.now() });
            ws.send(JSON.stringify({ type: "authenticated", userId }));
          } else {
            ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
          }
        }

        else if (msg.type === "response") {
          // Bridge app responding to a data request
          const requestId = msg.id;
          const pending = pendingRequests.get(requestId);
          if (pending) {
            pending.resolve(msg.data);
            pendingRequests.delete(requestId);
          }
        }
      } catch (e) {
        console.error("Bridge WS error:", e.message);
      }
    });

    ws.on("close", () => {
      if (userId) {
        bridges.delete(userId);
      }
    });

    ws.on("error", (err) => {
      console.error("Bridge WS connection error:", err.message);
    });
  });

  // Clean up stale pairing codes every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of pendingPairs) {
      if (now - entry.timestamp > 5 * 60 * 1000) {
        pendingPairs.delete(code);
      }
    }
  }, 5 * 60 * 1000);

  // Poll Supabase for pending pairing requests from the webapp
  setInterval(async () => {
    try {
      const { data: pending } = await supabase
        .from("user_bridges")
        .select("user_id, token, pairing_code")
        .eq("status", "pending_pair");

      if (!pending || pending.length === 0) return;

      for (const row of pending) {
        const code = (row.pairing_code || "").toUpperCase();
        const entry = pendingPairs.get(code);
        if (entry && entry.ws.readyState === 1) {
          // Match found. Tell the bridge app it's paired.
          entry.ws.send(JSON.stringify({
            type: "paired",
            userId: row.user_id,
            token: row.token,
          }));

          // Register the connection
          bridges.set(row.user_id, { ws: entry.ws, lastSeen: Date.now() });
          pendingPairs.delete(code);

          // Update status in Supabase
          await supabase
            .from("user_bridges")
            .update({ status: "connected", pairing_code: null })
            .eq("user_id", row.user_id);

          console.log(`Bridge paired for user ${row.user_id}`);
        }
      }
    } catch (e) {
      // Silently ignore polling errors
    }
  }, 15000); // Every 15 seconds. This poll ran at 3s around the clock, nearly
  // 30k requests a day, for an event (pairing) that happens about once in an
  // install's lifetime. A push channel was considered and declined: pairing
  // must work exactly when everything else is being set up for the first
  // time, and a poll has no connection state to get wrong. Fifteen seconds
  // matches the dashboard's own status cadence, so pairing feels the same.

  console.log("Bridge WebSocket server ready at /bridge");
}

// Pending data requests: requestId -> { resolve, reject, timeout }
const pendingRequests = new Map();

// Confirm a pairing code from the dashboard
async function confirmPairing(code, userId) {
  const entry = pendingPairs.get(code.toUpperCase());
  if (!entry) return { error: "Invalid or expired code" };

  // Generate a token for this bridge
  const token = crypto.randomBytes(32).toString("hex");

  // Save to Supabase
  await supabase
    .from("user_bridges")
    .upsert({
      user_id: userId,
      token,
      status: "connected",
      paired_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  // Tell the bridge app it's paired
  entry.ws.send(JSON.stringify({
    type: "paired",
    userId,
    token,
  }));

  // Register this connection
  bridges.set(userId, { ws: entry.ws, lastSeen: Date.now() });
  pendingPairs.delete(code.toUpperCase());

  return { success: true };
}

// Send a request to a user's bridge and wait for response
async function requestFromBridge(userId, action, params = {}, timeoutMs = 15000) {
  const conn = bridges.get(userId);
  if (!conn || conn.ws.readyState !== 1) {
    throw new Error("Bridge not connected");
  }

  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Bridge request timed out"));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject,
    });

    conn.ws.send(JSON.stringify({
      type: "request",
      id: requestId,
      action,
      params,
    }));

    conn.lastSeen = Date.now();
  });
}

// Check if a user has an active bridge connection
function isBridgeConnected(userId) {
  const conn = bridges.get(userId);
  return conn && conn.ws.readyState === 1;
}

module.exports = {
  setupBridgeServer,
  confirmPairing,
  requestFromBridge,
  isBridgeConnected,
};
