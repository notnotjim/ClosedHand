// lib/web-chat-ws.js - Direct WebSocket server for browser chat
// Replaces the Supabase message bus with a direct connection
// Browser -> WS -> ask -> WS -> Browser (zero Supabase hops)

const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const ctx = require("./context");
const { UserStore } = require("../user-store");
const { saveStore, swapToCloudStore } = require("./storage");
const { queuedAsk } = require("./engine");
const { toolStatusText } = require("./messaging");
const { StatusFeed, createWebRenderer } = require("./status-feed");

const { supabase } = require("./db");

const WS_AUTH_SECRET = process.env.WS_AUTH_SECRET || "fallback-dev-secret";

// Active connections: userId -> Set<ws>
const webClients = new Map();

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const userId = parts[0];
  const exp = parseInt(parts[1], 10);
  const sig = parts[2];

  // Check expiry
  if (Date.now() > exp) return null;

  // Verify HMAC
  const payload = `${userId}.${exp}`;
  const hmac = crypto.createHmac("sha256", WS_AUTH_SECRET);
  hmac.update(payload);
  const expected = hmac.digest("hex");

  if (expected.length !== sig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) return null;
  } catch {
    return null;
  }

  return userId;
}

function setupWebChatServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade manually to avoid path/query conflicts
  server.on("upgrade", (req, socket, head) => {
    const pathname = req.url.split("?")[0];
    if (pathname === "/chat") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
    // Don't destroy socket for other paths (/bridge handles its own)
  });

  wss.on("connection", (ws, req) => {
    // Extract token from query string
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const userId = verifyToken(token);

    if (!userId) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
      ws.close(4001, "Unauthorized");
      return;
    }

    // Register connection
    if (!webClients.has(userId)) webClients.set(userId, new Set());
    webClients.get(userId).add(ws);
    console.log(`[WebChat] Connected: ${userId} (${webClients.get(userId).size} tabs)`);

    ws.send(JSON.stringify({ type: "connected", userId }));

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "chat" && msg.text) {
          let fileData = null;
          let text = msg.text.trim();
          const files = msg.files || [];

          if (files.length > 0) {
            const describe = (f) => `${f.name} (${f.type || "unknown type"}, ${(f.data || "").length} b64 chars)`;
            console.log(`[WebChat] ${files.length} file(s): ${files.map(describe).join("; ")}`);

            const images = files.filter(f => (f.type || "").startsWith("image/"));

            if (images.length > 1) {
              // Several images in one message: send them all, not just the first.
              fileData = {
                isMultiImage: true,
                isImage: true,
                images: images.map(f => ({
                  base64: f.data,
                  mediaType: f.type || "image/jpeg",
                })),
                ext: (images[0].name || "image.jpg").split(".").pop().toLowerCase(),
                fileName: `images_${images.length}.jpg`,
              };
              // Anything that is not an image cannot ride along, so say so out
              // loud rather than dropping it silently.
              const others = files.filter(f => !(f.type || "").startsWith("image/"));
              if (others.length > 0) {
                text += `\n\n[Also attached but not sent to you: ${others.map(f => f.name).join(", ")}. Tell the user to send those separately.]`;
              }
            } else {
              const f = images.length === 1 ? images[0] : files[0];
              const ext = (f.name || "").split(".").pop().toLowerCase();
              const isImage = (f.type || "").startsWith("image/");
              const isVideo = (f.type || "").startsWith("video/");
              const isAudio = (f.type || "").startsWith("audio/");
              const isText = ["txt","csv","json","md","html","xml","js","py","ts","css","sql","sh","yaml","yml","log","rtf"].includes(ext);
              const isOffice = ["doc","docx","xls","xlsx","pptx"].includes(ext);
              const buf = Buffer.from(f.data, "base64");
              fileData = {
                filename: f.name,
                fileName: f.name,
                ext: ext,
                mediaType: f.type || "application/octet-stream",
                base64: f.data,
                buffer: buf,
                isImage: isImage,
                isVideo: isVideo,
                isAudio: isAudio,
                isText: isText,
                isOffice: isOffice,
                isPdf: ext === "pdf",
                textContent: isText ? buf.toString("utf-8") : null,
              };
              const others = files.filter(o => o !== f);
              if (others.length > 0) {
                text += `\n\n[Also attached but not sent to you: ${others.map(o => o.name).join(", ")}. Tell the user to send those separately.]`;
              }
            }
          }

          await handleChatMessage(userId, text, ws, fileData);
        }
      } catch (err) {
        console.error("[WebChat] Message parse error:", err.message);
      }
    });

    ws.on("close", () => {
      const clients = webClients.get(userId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) webClients.delete(userId);
      }
    });

    ws.on("error", () => {
      ws.close();
    });

    // Keepalive ping every 30s
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on("close", () => clearInterval(pingInterval));
  });

  console.log("[WebChat] WebSocket server ready on /chat");
}

async function handleChatMessage(userId, text, ws, fileData) {
  if (!text) return;

  // Persist inbound message (fire-and-forget for speed)
  supabase.from("web_messages").insert({
    user_id: userId,
    direction: "inbound",
    content: text,
    status: "processing",
  }).then(() => {}).catch(() => {});

  // Send typing indicator
  sendToUser(userId, { type: "typing" });

  const { queueUserMessage } = ctx;

  queueUserMessage(userId, async () => {
    const userStore = await UserStore.load(userId);
    swapToCloudStore(userStore, userId, userId);
    ctx.activePlatform = "web";
    const { maybeRefreshOnSessionStart } = require("./workspace-cache");
    maybeRefreshOnSessionStart(userStore, userId);

    try {
      // Pending confirmations are intercepted inside queuedAsk (single chokepoint)
      const statusFeed = new StatusFeed(createWebRenderer(userId, sendToUser));
      let streamedTokens = "";
      let streamStarted = false;
      const opts = {
        onToolStart(toolNames) {
          const statusText = toolStatusText(toolNames);
          if (statusText) {
            sendToUser(userId, { type: "status", content: statusText });
          }
        },
        onStatusEvent(event) {
          statusFeed.emit(event);
        },
        onStreamToken(token) {
          streamedTokens += token;
          if (!streamStarted) {
            streamStarted = true;
            sendToUser(userId, { type: "stream_start" });
          }
          sendToUser(userId, { type: "stream_token", content: token });
        },
      };

      const response = await queuedAsk(userId, text, fileData || null, userId, opts);

      // Null response = request yielded to a newer message; its answer arrives
      // later as a deferred follow-up, so send nothing here.
      if (response) {
        if (streamStarted) {
          // Stream complete, send final message to replace stream
          sendToUser(userId, { type: "stream_end", content: response });
        } else {
          // Non-streamed response
          sendToUser(userId, { type: "message", content: response });
        }

        // Persist outbound (fire-and-forget)
        supabase.from("web_messages").insert({
          user_id: userId,
          direction: "outbound",
          content: response,
          status: "complete",
        }).then(() => {}).catch(() => {});
      } else if (streamStarted) {
        sendToUser(userId, { type: "stream_end", content: "" });
      }

      await userStore.save();
    } catch (err) {
      console.error("[WebChat] ask error:", err.message);
      sendToUser(userId, { type: "message", content: "Sorry, something went wrong. Please try again." });
    }
  });
}

// Send a message to all connected tabs for a user
function sendToUser(userId, data) {
  const clients = webClients.get(userId);
  if (!clients) return;
  const json = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(json);
    }
  }
}

// Export for use by sendStatusMessage etc.
function sendWebChatMessage(userId, text) {
  sendToUser(userId, { type: "message", content: text });
}

// Check if a user has active WS connections
function hasWebChatConnection(userId) {
  const clients = webClients.get(userId);
  return clients && clients.size > 0;
}

module.exports = { setupWebChatServer, sendWebChatMessage, sendToUser, hasWebChatConnection };
