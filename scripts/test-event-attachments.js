// A file the person sent in chat can be attached to a calendar event, new or
// existing: it goes to Closedhand's folder in that account's Drive, then onto
// the event, keeping any attachments the event already had.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "lib", "tools", "handlers.js"), "utf8");
const { INTERNAL_TOOLS } = require("../lib/tools/definitions");

function helper(files, uploads) {
  const start = src.indexOf("async function eventAttachmentsFrom");
  const end = src.indexOf("// Build a base64url raw message");
  const box = {
    resolveOutgoingAttachments: async (ids) => ({ attachments: ids.filter((id) => files[id]).map((id) => files[id]), missing: ids.filter((id) => !files[id]) }),
    require: (m) => {
      assert.equal(m, "../services/drive");
      return { uploadToDrive: async (buffer, name, mime, store, key) => { uploads.push({ name, mime, key }); return { id: "drive-" + name, name, webViewLink: "https://drive.example/" + name }; } };
    },
  };
  vm.runInNewContext(src.slice(start, end) + "\nthis.f = eventAttachmentsFrom;", box);
  return box.f;
}

test("sent files are saved to that account's Drive and returned as event attachments", async () => {
  const uploads = [];
  const f = helper({ a1: { buffer: Buffer.from("x"), fileName: "menu.txt", mimeType: "text/plain" } }, uploads);
  const out = await f(["a1"], "google_extra_work");
  assert.equal(out.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(out.attachments)), [{ fileId: "drive-menu.txt", fileUrl: "https://drive.example/menu.txt", title: "menu.txt", mimeType: "text/plain" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(uploads)), [{ name: "menu.txt", mime: "text/plain", key: "google_extra_work" }]);
});

test("a missing file stops the change instead of attaching nothing", async () => {
  const uploads = [];
  const out = await helper({}, uploads)(["gone"], "google");
  assert.match(out.error, /gone/);
  assert.equal(uploads.length, 0);
});

test("both calendar tools take attachment_ids, and the update keeps existing attachments", () => {
  for (const name of ["gcal_create_event", "gcal_update_event"]) {
    const tool = INTERNAL_TOOLS.find((t) => t.name === name);
    assert.ok(tool.input_schema.properties.attachment_ids, `${name} takes attachment_ids`);
  }
  const update = src.slice(src.indexOf('case "gcal_update_event"'), src.indexOf('case "gcal_delete_event"'));
  assert.match(update, /patch\.attachments = \[\.\.\.\(current\.attachments \|\| \[\]\), \.\.\.newFiles\];/);
  assert.match(update, /\(patch\.attachments \? `\?supportsAttachments=true` : ``\)/);
});
