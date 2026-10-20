// lib/model-files.js: a model's files, fetched once from a pinned revision and
// checked against the checksums recorded with the model (lib/local-models.js),
// into MODELS_DIR in the layout transformers.js keeps its own cache in, so its
// tokenizer and processor find them there and never go online themselves.
//
// A file counts as present when its size is right: hashing hundreds of MB on
// every start would cost more than it guards. Every download is hashed as it
// arrives and only renamed into place when the hash matches.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function present(file, size) {
  try { return fs.statSync(file).size === size; } catch (_) { return false; }
}

// The files of `set` that are not on disk yet.
function missing(dir, model, set) {
  return set.filter((f) => !present(path.join(dir, model.repo, f.path), f.size));
}

// Downloads what is missing. onProgress({ file, loaded, total }) as it goes,
// for each file on its own, the way transformers.js reports its downloads.
async function ensureFiles(dir, model, set, onProgress = () => {}, fetchImpl = fetch) {
  const todo = missing(dir, model, set);
  for (const f of todo) {
    let loaded = 0;
    const dest = path.join(dir, model.repo, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + ".part";
    const res = await fetchImpl(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${f.path}`, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Could not download ${f.path} (${res.status})`);
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(part);
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        loaded += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        onProgress({ file: f.path, loaded, total: f.size });
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    } catch (e) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw e;
    }
    if (hash.digest("hex") !== f.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`${f.path} did not match its checksum, so it was not kept`);
    }
    fs.renameSync(part, dest);
  }
  return { downloaded: todo.length };
}

module.exports = { ensureFiles, missing };
