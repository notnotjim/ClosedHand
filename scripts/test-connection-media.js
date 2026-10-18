// A connected service that speaks (a voice made from text) or makes a file
// sent it back, and Closedhand kept only a note such as "[audio, 40 KB]": the
// person never heard it. Now sound and files go to the chat the request came
// from, and the model is told they went. Pictures still go to the model to
// read, since tools send screenshots for that.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { renderToolResult } = require("../lib/mcp-client");

const voice = Buffer.from("ID3 kestrel voice bytes").toString("base64");
const pdf = Buffer.from("%PDF-1.7 harbour timetable").toString("base64");

test("sound and files a service sends back reach the person, and the model is told", async () => {
  const sent = [];
  const out = await renderToolResult({ content: [
    { type: "text", text: "Done." },
    { type: "audio", data: voice, mimeType: "audio/mpeg" },
    { type: "resource", resource: { uri: "file:///out/harbour-timetable.pdf", mimeType: "application/pdf", blob: pdf } },
    { type: "resource", resource: { uri: "note://1", mimeType: "text/plain", text: "Ferries every 40 minutes." } },
  ] }, { deliverFile: async (f) => { sent.push(f); } });
  assert.deepEqual(sent.map((f) => [f.name, f.mimeType, f.buffer.toString()]), [
    ["audio-1.mp3", "audio/mpeg", "ID3 kestrel voice bytes"],
    ["harbour-timetable.pdf", "application/pdf", "%PDF-1.7 harbour timetable"],
  ]);
  assert.match(out.text, /Done\.\n\[sent to the person as audio-1\.mp3 \(audio\/mpeg, 1 KB\)\]\n\[sent to the person as harbour-timetable\.pdf/);
  assert.match(out.text, /Ferries every 40 minutes\./, "text resources are still read");
});

test("with nowhere to send them, or when sending fails, the model is told what came back", async () => {
  const result = { content: [{ type: "audio", data: voice, mimeType: "audio/mpeg" }] };
  assert.equal((await renderToolResult(result)).text, "[audio, audio/mpeg, 1 KB]");
  const failed = await renderToolResult(result, { deliverFile: async () => { throw new Error("chat offline"); } });
  assert.equal(failed.text, "[audio, audio/mpeg, 1 KB] (it could not be sent to the person: chat offline)");
});

test("pictures still go to the model to read, not to the chat", async () => {
  const sent = [];
  const out = await renderToolResult({ content: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] },
    { deliverFile: async (f) => { sent.push(f); }, describeImages: async () => "A ferry timetable." });
  assert.deepEqual(sent, []);
  assert.match(out.text, /A ferry timetable\./);
});

test("calls to a connected service send to the chat the request came from", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/user-mcp.js"), "utf8");
  assert.match(src, /renderToolResult\(result, \{ describeImages, deliverFile: deliverToChat\(\) \}\)/);
  assert.match(src, /sendDocument\(ctx\.activeChatId, buffer, name, mimeType, "connection"\)/);
});
