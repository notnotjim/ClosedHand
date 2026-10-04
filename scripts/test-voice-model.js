// The bundled voice is Kokoro's full-size model. The compressed q8 file
// produced invalid audio on Intel's newest server chips (Xeon 8573C,
// 6973P-C) while the full model was correct on every machine tested.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const manifest = require("../lib/speech/assets.json");

test("the full-size model is bundled and loaded as full size", () => {
  const model = manifest.files.find((f) => f.path.startsWith("onnx/"));
  assert.deepEqual(model, { path: "onnx/model.onnx", bytes: 325532232, sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb" });
  assert.equal(manifest.voice, "af_heart", "the same voice");
  const worker = fs.readFileSync(path.join(__dirname, "..", "lib", "speech", "worker.js"), "utf8");
  assert.match(worker, /dtype: "fp32", device: "cpu", local_files_only: true,/);
  assert.doesNotMatch(worker, /dtype: "q8"/);
});
