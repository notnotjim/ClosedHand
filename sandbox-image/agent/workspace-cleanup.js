// The sandbox computer's own working files are cleared once nothing has
// changed in them for 30 days: the charts it drew, pages and PDFs it fetched
// to read, screenshots. Whatever it sent the person is kept where it sent it.
// What the person adds goes in Yours (webapp/server.js) and is never cleared,
// nor is anything hidden, like the browser's profile with its sign-ins.
//
// Each top-level file or folder is one item, judged by the newest change
// anywhere inside it, so a folder still in use is never cleared in part.
const fs = require("fs");
const path = require("path");

const KEEP_DAYS = 30;
const YOURS = "Yours";

function newest(p) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let latest = st.mtimeMs;
  for (const name of fs.readdirSync(p)) latest = Math.max(latest, newest(path.join(p, name)));
  return latest;
}

// Returns the names it cleared.
function clearOldWork(root, now = Date.now(), days = KEEP_DAYS) {
  const cleared = [];
  for (const name of fs.readdirSync(root)) {
    if (name === YOURS || name.startsWith(".")) continue;
    const p = path.join(root, name);
    try {
      if (now - newest(p) > days * 86400000) {
        fs.rmSync(p, { recursive: true, force: true });
        cleared.push(name);
      }
    } catch (_) { /* gone already, or not ours to read */ }
  }
  return cleared;
}

module.exports = { clearOldWork, KEEP_DAYS, YOURS };
