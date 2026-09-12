const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
function loadFunction(file, name, context) {
  const source = read(file).match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(source, name);
  return vm.runInNewContext(source + `\n${name}`, { Buffer, console, ...context });
}

test("generated WhatsApp previews use uploaded images, while original and unsupported files remain documents", async () => {
  const requests = [];
  const send = loadFunction("lib/messaging.js", "sendWhatsAppDocument", {
    WHATSAPP_ACCESS_TOKEN: "test", WHATSAPP_PHONE_NUMBER_ID: "test",
    https: { request(options, callback) {
      const req = new EventEmitter(); let body;
      req.write = value => { body = value; };
      req.end = () => {
        requests.push({ options, body });
        const response = new EventEmitter(); callback(response);
        response.emit("data", Buffer.from(JSON.stringify(options.path.endsWith("/media") ? { id: "uploaded" } : { messages: [{ id: "sent" }] })));
        response.emit("end");
      };
      return req;
    } },
  });
  for (const [mime, size, inline, expected] of [
    ["image/png", 12, true, "image"], ["image/jpeg", 12, true, "image"],
    ["image/png", 12, false, "document"], ["image/svg+xml", 12, true, "document"],
    ["text/html", 12, true, "document"], ["image/png", 5 * 1024 * 1024 + 1, true, "document"],
  ]) {
    await send("recipient", Buffer.alloc(size), "result", mime, inline);
    const payload = JSON.parse(requests.at(-1).body);
    assert.equal(payload.to, "recipient");
    assert.equal(payload.type, expected);
    assert.equal(payload[expected].id, "uploaded");
    assert.equal(requests.at(-2).options.path.endsWith("/media"), true);
  }
});

const linkedFile = "lib/platforms/whatsapp-linked.js";
if (fs.existsSync(path.join(root, linkedFile))) test("linked WhatsApp previews retain the self-chat gate and original-file delivery", async () => {
  const sent = [];
  const send = loadFunction(linkedFile, "sendLinkedDocument", {
    _sock: { sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return { id: "sent" }; } },
    _gateSelfChat: jid => { if (jid !== "self") throw Error("Wrong recipient"); return jid; },
    remember: value => value,
  });
  const bytes = Buffer.from("preview");
  await send("self", bytes, "chart.png", "image/png", true);
  assert.equal(sent[0].payload.image, bytes);
  assert.equal(sent[0].payload.document, undefined);
  await send("self", bytes, "original.png", "image/png");
  assert.equal(sent[1].payload.document, bytes);
  await send("self", bytes, "tool.html", "text/html", true);
  assert.equal(sent[2].payload.document, bytes);
  await assert.rejects(send("someone-else", bytes, "chart.png", "image/png", true), /Wrong recipient/);
  assert.equal(sent.length, 3);
});

test("generated-file routing opts into native WhatsApp previews without requiring a browser link", async () => {
  const sent = [];
  const send = loadFunction("lib/messaging.js", "sendCanvasToChat", {
    sendWhatsAppDocument: async (...args) => sent.push(args),
    require: name => {
      assert.equal(name, "./platforms/whatsapp-linked");
      return { sendLinkedDocument: async (...args) => sent.push(args) };
    },
  });
  const platforms = ["whatsapp"];
  if (fs.existsSync(path.join(root, linkedFile))) platforms.push("whatsapp_linked");
  for (const platform of platforms) {
    await send(platform, "self", null, "chart.png", Buffer.from("image"), "image/png");
    assert.equal(sent.at(-1)[4], true);
    assert.equal(sent.at(-1)[0], "self");
  }
});

test("canvas links reuse the working phone address and never invent a local-port fallback", async () => {
  const context = { module: { exports: {} }, URL, process: { env: { WEBAPP_URL: "https://phone.example.com" } },
    require: () => ({ dashboardBase: async () => "https://phone.example.com" }),
  };
  vm.runInNewContext(read("lib/dashboard-links.js"), context);
  assert.equal(await context.module.exports.canvasUrl("whatsapp", "chart-id"), "https://phone.example.com/canvas/chart-id");
  assert.equal(await context.module.exports.canvasUrl("web", "chart-id"), "/canvas/chart-id");
  assert.equal(await context.module.exports.canvasUrl("whatsapp", null), null);
});

test("generated-file receipts report actual delivery and only real preview URLs", async () => {
  const source = read("lib/tools/handlers.js");
  const body = source.slice(source.indexOf('    case "sandbox_file_download": {'), source.indexOf('    case "sandbox_upload": {'));
  for (const platform of ["whatsapp", "web"]) for (const saveFails of [false, true]) {
    const deliveries = [];
    const db = { from: () => ({ insert: () => ({
      select: () => ({ single: async () => saveFails ? { error: { message: "offline" } } : { data: { id: "stored" } } }),
      then: () => ({ catch() {} }),
    }) }) };
    const context = {
      Buffer, console: { warn() {}, error() {} },
      ctx: { activeUserId: "owner", activeChatId: "self", activePlatform: platform },
      toolInput: { path: "chart.png" }, sendDocument: async () => deliveries.push("file"),
      require: name => {
        if (name === "../sandbox") return { ensureSandbox: async () => {}, sandboxFileDownload: async () => ({ filename: "chart.png", mime_type: "image/png", content: "YQ==", size: 1 }) };
        if (name === "../../user-store") return { supabase: db };
        if (name === "../dashboard-links") return { canvasUrl: async () => "https://phone.example.com/canvas/stored" };
        if (name === "../web-chat-ws") return { hasWebChatConnection: () => false };
        if (name === "../messaging") return { sendCanvasToChat: async () => deliveries.push("preview") };
        throw Error(name);
      },
    };
    const result = await vm.runInNewContext(`(async () => { switch ("sandbox_file_download") { ${body} } })()`, context);
    if (platform === "web" && saveFails) {
      assert.ok(result.error);
      assert.equal(result.success, undefined);
    } else {
      assert.equal(result.success, true);
      assert.equal(result.canvas_url, saveFails ? undefined : "https://phone.example.com/canvas/stored");
      if (platform === "whatsapp") {
        assert.deepEqual(deliveries, ["preview"]);
        assert.doesNotMatch(result.message, /canvas panel/);
      }
    }
  }
});


test("WhatsApp prose converts Markdown while preserving code and native formatting", () => {
  const { formatWhatsApp } = require("../lib/chat-format");
  const input = "## Weather\n**HCM**\n*Humidity now*: 86%\n\n[Open chart](https://phone.example.com/canvas/id)\n`**keep code**`\n```js\n# a comment\n**literal**\n```";
  const output = formatWhatsApp(input);
  assert.ok(output.startsWith("*Weather*\n*HCM*\n*Humidity now*: 86%"));
  assert.ok(output.includes("Open chart: https://phone.example.com/canvas/id"));
  assert.ok(output.includes("`**keep code**`"));
  assert.ok(output.includes("```js\n# a comment\n**literal**\n```"));
  assert.equal(formatWhatsApp(output), output);
});
