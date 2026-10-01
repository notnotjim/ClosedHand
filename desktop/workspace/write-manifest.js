const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = process.argv[2];
async function digest(name) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(path.join(directory, name))) hash.update(chunk);
  return { file: name, bytes: fs.statSync(path.join(directory, name)).size, sha256: hash.digest('hex') };
}
(async () => {
  const files = await Promise.all(['kernel', 'initrd', 'root.ext4.gz'].map(digest));
  const root = await digest('root.ext4');
  const version = root.sha256.slice(0, 16);
  for (const file of files) file.url = `https://github.com/notnotjim/ClosedHand/releases/download/workspace-${version}/${file.file}`;
  const result = { version, arch: 'arm64', files, root };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
