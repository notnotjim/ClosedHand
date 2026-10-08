// Build-time download only. Production speech never fetches code or model files.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const manifest = require("../lib/speech/assets.json");
// The listening model (speech to text) is prepared the same way, from its own
// pinned manifest: `node scripts/prepare-voice.js --listening [directory]`.
const listening = require("../lib/speech/listen-assets.json");
const DEFAULT_DIRECTORY = { voice: path.join(__dirname, "../assets/voice/kokoro-v1"), listening: path.join(__dirname, "../assets/listen/whisper-base") };

async function verified(file, entry) {
  try {
    if ((await fs.promises.stat(file)).size !== entry.bytes) return false;
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === entry.sha256;
  } catch { return false; }
}

// Remove every file the manifest does not list. The Mac build keeps this
// folder between builds, so a model the manifest dropped (the 92 MB q8 model,
// replaced by the full-size one) stayed in it and shipped in every app after.
async function prune(directory, list = manifest) {
  const keep = new Set(list.files.map(entry => path.normalize(entry.path)));
  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!keep.has(path.relative(directory, full))) await fs.promises.rm(full, { force: true });
    }
  }
  await walk(directory);
}

async function prepare(directory = DEFAULT_DIRECTORY.voice, list = manifest) {
  if (!list.files.length) throw new Error("The bundled voice manifest is empty");
  for (const entry of list.files) {
    const dest = path.join(directory, entry.path);
    if (await verified(dest, entry)) continue;
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const temp = dest + ".partial";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = `https://huggingface.co/${list.repository}/resolve/${list.revision}/${entry.path}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
        if (!res.ok) throw new Error(`Voice download returned HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(temp));
        if (!await verified(temp, entry)) throw new Error(`Voice checksum mismatch: ${entry.path}`);
        await fs.promises.rename(temp, dest);
        break;
      } catch (err) {
        await fs.promises.rm(temp, { force: true });
        if (attempt === 2) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  await prune(directory, list);
  console.log(list === manifest ? "Bundled voice files verified." : "Bundled listening files verified.");
}

if (require.main === module) {
  const listen = process.argv[2] === "--listening";
  const directory = process.argv[listen ? 3 : 2] || DEFAULT_DIRECTORY[listen ? "listening" : "voice"];
  prepare(directory, listen ? listening : manifest).catch(err => { console.error(err.message); process.exitCode = 1; });
}
module.exports = { prepare, prune, verified, listening, DEFAULT_DIRECTORY };
