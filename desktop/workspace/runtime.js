// Trusted host-side download/install. The app ships the hashes, never accepts
// a manifest supplied by the guest, and never executes downloaded host code.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function validateManifest(manifest) {
  if (manifest.arch !== process.arch || !/^[a-f0-9]{16}$/.test(manifest.version)) throw new Error('This Workspace download does not match your Mac.');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 3 || new Set(manifest.files.map(f => f.file)).size !== 3) throw new Error('The Workspace download information is invalid.');
  for (const name of ['kernel', 'initrd', 'root.ext4.gz']) {
    const file = manifest.files.find(item => item.file === name);
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw new Error('The Workspace download information is invalid.');
    const url = new URL(file.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The Workspace download address is invalid.');
  }
  if (manifest.root?.file !== 'root.ext4' || !/^[a-f0-9]{64}$/.test(manifest.root.sha256) || !Number.isSafeInteger(manifest.root.bytes)) throw new Error('The Workspace disk information is invalid.');
  return manifest;
}
function openDownload(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (new URL(url).protocol !== 'https:' || redirects > 5) return reject(new Error('Unsafe Workspace download redirect.'));
    const request = https.get(url, { headers: { 'User-Agent': 'ClosedHand-Workspace' }, timeout: 30000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        resolve(openDownload(new URL(response.headers.location, url).href, redirects + 1));
      } else if (response.statusCode !== 200) {
        response.resume();
        const error = new Error(`Workspace download failed (${response.statusCode}). Please try again.`);
        error.retryable = response.statusCode === 429 || response.statusCode >= 500;
        reject(error);
      } else resolve(response);
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Workspace download timed out. Please try again.'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
  });
}
function verifier(file, progress = () => {}) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > file.bytes) return callback(new Error('Workspace download exceeded its expected size.'));
      hash.update(chunk); progress(chunk.length); callback(null, chunk);
    },
    flush(callback) {
      callback(bytes === file.bytes && hash.digest('hex') === file.sha256 ? null : new Error('Workspace download did not pass its integrity check. Please try again.'));
    },
  });
}
async function downloadFile(file, root, directory, progress, { open = openDownload, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const compressed = file.file === 'root.ext4.gz';
  for (let attempt = 0; attempt < 3; attempt++) {
    let received = 0;
    try {
      const source = await open(file.url);
      // Every attempt starts clean. Only a fully verified file can be installed.
      const output = fs.createWriteStream(path.join(directory, compressed ? 'root.ext4' : file.file), { flags: 'w', mode: 0o600 });
      const checked = verifier(file, amount => { received += amount; progress(received); });
      if (compressed) await pipeline(source, checked, zlib.createGunzip(), verifier(root), output);
      else await pipeline(source, checked, output);
      return;
    } catch (error) {
      const retryable = error.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code);
      if (!retryable) throw error;
      progress(0);
      if (attempt === 2) throw new Error('Workspace download was interrupted. Check your internet connection and try again.', { cause: error });
      await wait(1000 * (attempt + 1));
    }
  }
}
async function installRuntime(manifest, directory, progress = () => {}) {
  validateManifest(manifest);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, manifest.version);
  try {
    const receipt = JSON.parse(await fsp.readFile(path.join(destination, 'installed.json'), 'utf8'));
    if (receipt.root === manifest.root.sha256) {
      for (const file of [...manifest.files.filter(f => f.file !== 'root.ext4.gz'), manifest.root]) {
        const stat = await fsp.lstat(path.join(destination, file.file));
        if (!stat.isFile() || stat.size !== file.bytes) throw new Error('Workspace runtime needs repair.');
      }
      return destination;
    }
  } catch { /* Missing or incomplete installation is downloaded again. */ }
  const temp = await fsp.mkdtemp(path.join(directory, '.install-'));
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  let done = 0;
  try {
    const space = await fsp.statfs(directory);
    if (space.bavail * space.bsize < manifest.root.bytes + 512 * 1024 * 1024) throw new Error('Free at least 4 GB of disk space to prepare the Workspace.');
    for (const file of manifest.files) {
      await downloadFile(file, manifest.root, temp, received => progress(Math.min(99, Math.floor((done + received) * 100 / total))));
      done += file.bytes;
    }
    await fsp.writeFile(path.join(temp, 'installed.json'), JSON.stringify({ root: manifest.root.sha256 }), { mode: 0o600 });
    // A previous incomplete version is host-owned cache, never the user's disk.
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.rename(temp, destination);
    progress(100);
    return destination;
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
}
module.exports = { validateManifest, verifier, downloadFile, installRuntime };
