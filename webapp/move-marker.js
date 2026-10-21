// Whether this Closedhand is moving to another computer, or has moved
// (webapp/move.js). It is a file in the storage folder, which the bot and the
// dashboard share on Docker and the Mac app, so each can read it before it
// starts anything: a Closedhand that has moved must never answer a chat or
// run a schedule again, or two would answer the same person.
//
// { state: "moving" } while its data is sent; the bot sits still meanwhile.
// { state: "moved", url, at } once the other computer has it all.
// No file: running as normal.
const fs = require("fs");
const path = require("path");

const NAME = ".closedhand-move.json";

function file() {
  const dir = process.env.STORAGE_DIR;
  return dir ? path.join(path.resolve(dir), NAME) : null;
}

// A move needs somewhere both processes can see. Railway keeps files in the
// database instead (STORAGE_DRIVER=pg), with no shared folder.
function available() {
  return !!file();
}

function read() {
  const f = file();
  if (!f) return null;
  try {
    const state = JSON.parse(fs.readFileSync(f, "utf8"));
    return state && (state.state === "moving" || state.state === "moved") ? state : null;
  } catch (_) {
    return null;
  }
}

function write(state) {
  const f = file();
  if (!f) throw new Error("This Closedhand has no storage folder to mark a move in.");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(state));
}

function clear() {
  const f = file();
  if (f) try { fs.unlinkSync(f); } catch (_) { /* already gone */ }
}

module.exports = { NAME, available, read, write, clear };
