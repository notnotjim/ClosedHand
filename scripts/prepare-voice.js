// Build-time download only. Production speech never fetches code or model files.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const manifest = require("../lib/speech/assets.json");

async function verified(file, entry) {
  try {
    if ((await fs.promises.stat(file)).size !== entry.bytes) return false;
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === entry.sha256;
  } catch { return false; }
}

async function prepare(directory = path.join(__dirname, "../assets/voice/kokoro-v1")) {
  if (!manifest.files.length) throw new Error("The bundled voice manifest is empty");
  for (const entry of manifest.files) {
    const dest = path.join(directory, entry.path);
    if (await verified(dest, entry)) continue;
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const temp = dest + ".partial";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${entry.path}`;
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
  console.log("Bundled voice files verified.");
}

if (require.main === module) prepare(process.argv[2]).catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { prepare, verified };
