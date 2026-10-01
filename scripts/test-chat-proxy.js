"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");
const { proxyChatUpgrade } = require("../webapp/chat-proxy");

test("chat proxy relays authenticated frames and rejects invalid tokens and foreign origins", async () => {
  const secret = "test-only-secret";
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", ws => ws.on("message", (data, binary) => ws.send(data, { binary })));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const front = http.createServer();
  front.on("upgrade", (req, socket, head) => proxyChatUpgrade(req, socket, head, {
    upstream: `http://127.0.0.1:${upstream.address().port}`, secret,
  }));
  front.listen(0, "127.0.0.1");
  await once(front, "listening");
  const origin = `http://127.0.0.1:${front.address().port}`;
  const mint = exp => {
    const payload = `test-user.${exp}`;
    return payload + "." + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  };
  const token = mint(Date.now() + 60000);
  try {
    const client = new WebSocket(origin.replace("http:", "ws:") + "/chat?token=" + token, { origin });
    await once(client, "open");
    const text = once(client, "message");
    client.send("hello");
    const [message, binary] = await text;
    assert.equal(message.toString(), "hello");
    assert.equal(binary, false);
    const bytes = once(client, "message");
    client.send(Buffer.from([0, 255, 23]));
    const [data, isBinary] = await bytes;
    assert.deepEqual(data, Buffer.from([0, 255, 23]));
    assert.equal(isBinary, true);
    client.close();
    await once(client, "close");
    for (const [value, requestOrigin, status] of [
      ["invalid", origin, 401], [mint(Date.now() - 1), origin, 401],
      [token, "https://attacker.example", 403],
      [token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), origin, 401],
    ]) {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(origin.replace("http:", "ws:") + "/chat?token=" + value, { origin: requestOrigin });
        ws.on("unexpected-response", (_, response) => {
          try { assert.equal(response.statusCode, status); response.resume(); ws.terminate(); resolve(); }
          catch (error) { reject(error); }
        });
        ws.on("error", () => {});
        ws.on("open", () => { ws.terminate(); reject(new Error("Unauthorized connection accepted")); });
      });
    }
  } finally {
    wss.clients.forEach(ws => ws.terminate());
    wss.close();
    front.close();
    upstream.close();
  }
});
