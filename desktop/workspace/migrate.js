const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');

// Keep the original directory intact. Mac binaries and the Mac-encrypted
// browser profile remain there; they cannot run or authenticate on Linux.
const platformFiles = new Set(['.venv', '.chromium-profile', '.home', '.cache', '.tmp', 'node_modules']);
async function importLegacy(options) {
  const marker = path.join(options.directory, 'legacy-imported.json');
  if (fs.existsSync(marker) || !options.legacy || !fs.existsSync(options.legacy)) return;
  const root = await fsp.realpath(options.legacy);
  let count = 0;
  async function walk(directory, prefix = '') {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!prefix && platformFiles.has(entry.name)) continue;
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, relative);
      else if (entry.isFile()) {
        await new Promise((resolve, reject) => {
          const request = http.request({ socketPath: options.socket, path: '/runtime/import-file?path=' + encodeURIComponent(relative), method: 'PUT', timeout: 120000,
            headers: { 'X-Sandbox-Token': options.token, 'Content-Type': 'application/octet-stream' } }, response => {
            response.on('error', reject);
            response.resume(); response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('Some Workspace files could not be moved. The originals have been kept.')));
          });
          request.on('error', reject);
          request.on('timeout', () => request.destroy(new Error('Moving Workspace files timed out. The originals have been kept.')));
          const source = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
          source.on('error', error => request.destroy(error));
          request.once('close', () => source.destroy());
          source.pipe(request);
        });
        count++;
      }
      // Never follow a symlink from the old Workspace onto the real Mac.
    }
  }
  await walk(root);
  await fsp.writeFile(marker, JSON.stringify({ files: count, completed: new Date().toISOString() }), { mode: 0o600 });
}
module.exports = { importLegacy };
