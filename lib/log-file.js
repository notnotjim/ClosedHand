// lib/log-file.js (vendored as webapp/log-file.js): Closedhand's log, kept in
// its own storage folder as well as on the screen.
//
// Docker keeps a container's log only while that container exists, and each
// update replaces the containers, so every update threw away the log of all
// that came before it: the part a bug report needs. A copy of every line goes
// to <STORAGE_DIR>/logs/<name>.log, rolled over at 5 MB into <name>.1.log, so
// each part of Closedhand keeps about 10 MB at most. It stays on this
// computer with the rest of Closedhand's data and never moves with it.
const fs = require("fs");
const path = require("path");
const util = require("util");

const LIMIT = 5 * 1024 * 1024;

function keepLog(name, dir = process.env.STORAGE_DIR, limit = LIMIT) {
  if (!dir) return null;
  const folder = path.join(dir, "logs");
  const file = path.join(folder, `${name}.log`);
  try { fs.mkdirSync(folder, { recursive: true }); } catch (_) { return null; }
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { /* a new log */ }
  // Written as each line comes, so a line is on disk even if the process
  // stops the moment after, and a burst at start rolls over like any other.
  let fd = null;
  try { fd = fs.openSync(file, "a"); } catch (_) { return null; }
  const write = (line) => {
    try {
      if (size > limit) {
        fs.closeSync(fd);
        fs.renameSync(file, path.join(folder, `${name}.1.log`));
        fd = fs.openSync(file, "a");
        size = 0;
      }
      size += fs.writeSync(fd, line);
    } catch (_) { /* the screen still has it */ }
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const toScreen = console[level].bind(console);
    console[level] = (...args) => {
      toScreen(...args);
      write(`${new Date().toISOString()} ${util.format(...args)}\n`);
    };
  }
  return file;
}

module.exports = { keepLog };
