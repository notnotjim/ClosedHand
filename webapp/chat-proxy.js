"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");

// The browser only contacts its own origin. The upstream address is server configuration.
function proxyChatUpgrade(req, socket, head, { upstream, secret }) {
  const reject = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  let target;
  let token;
  try {
    const origin = new URL(req.headers.origin);
    if (origin.host !== req.headers.host) return reject("403 Forbidden");
    token = new URL(req.url, "http://localhost").searchParams.get("token") || "";
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0] || !/^\d+$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return reject("401 Unauthorized");
    const payload = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest();
    if (Number(parts[1]) <= Date.now() || !crypto.timingSafeEqual(expected, Buffer.from(parts[2], "hex"))) return reject("401 Unauthorized");
    target = new URL(upstream);
    if (target.protocol === "ws:") target.protocol = "http:";
    if (target.protocol === "wss:") target.protocol = "https:";
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid upstream");
    target.pathname = "/chat";
    target.search = new URLSearchParams({ token }).toString();
  } catch {
    return reject("503 Service Unavailable");
  }
  const headers = {
    connection: "Upgrade", upgrade: "websocket",
    "sec-websocket-key": req.headers["sec-websocket-key"],
    "sec-websocket-version": req.headers["sec-websocket-version"],
  };
  const request = (target.protocol === "https:" ? https : http).request(target, { headers });
  const timer = setTimeout(() => { request.destroy(); reject("504 Gateway Timeout"); }, 10000);
  socket.on("error", () => request.destroy());
  socket.on("close", () => { clearTimeout(timer); request.destroy(); });
  request.on("error", () => { clearTimeout(timer); if (!socket.destroyed) reject("502 Bad Gateway"); });
  request.on("response", (response) => { clearTimeout(timer); response.resume(); reject("502 Bad Gateway"); });
  request.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    clearTimeout(timer);
    if (socket.destroyed) return upstreamSocket.destroy();
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${response.headers["sec-websocket-accept"]}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
    upstreamSocket.on("error", () => socket.destroy());
    upstreamSocket.on("close", () => socket.destroy());
    socket.on("close", () => upstreamSocket.destroy());
  });
  request.end();
}

module.exports = { proxyChatUpgrade };
