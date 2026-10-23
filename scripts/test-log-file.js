// Closedhand keeps a copy of its log in its storage folder, so an update,
// which replaces the containers and their logs, no longer wipes what a bug
// report needs. Rolled over at a size limit, so it never grows without end.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("every line goes to the screen and to <storage>/logs, and rolls over at the limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-log-"));
  const script = `
    const { keepLog } = require(${JSON.stringify(path.join(__dirname, "..", "lib", "log-file.js"))});
    keepLog("bot", ${JSON.stringify(dir)}, 2000);
    console.log("[move] restarting at the dashboard's request");
    console.error("[tool-error] gmail_send: quota");
    for (let i = 0; i < 40; i++) console.log("line " + i + " " + "x".repeat(60));
    console.log("last line");
  `;
  const shown = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.match(shown, /restarting at the dashboard's request/, "still on the screen");
  const now = fs.readFileSync(path.join(dir, "logs", "bot.log"), "utf8");
  const before = fs.readFileSync(path.join(dir, "logs", "bot.1.log"), "utf8");
  assert.match(now, /last line\n$/);
  assert.match(before, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[move\] restarting at the dashboard's request\n/m, "each line carries its time");
  assert.match(before, /\[tool-error\] gmail_send: quota/, "errors too");
  assert.ok(fs.statSync(path.join(dir, "logs", "bot.log")).size < 4000, "rolled over, so it stays small");
  fs.rmSync(dir, { recursive: true });
});

test("the bot and the dashboard each keep theirs from the first line, and it never moves", () => {
  // Right after the secrets are locked away, which comes first of all.
  assert.match(read("index.js"), /require\("\.\/crypto-tokens"\)\.guardEnvironment\(\);\n\/\/ A copy of the log[^\n]*\nrequire\("\.\/lib\/log-file"\)\.keepLog\("bot"\);\n/);
  assert.match(read("webapp/server.js"), /require\("\.\/crypto-tokens"\)\.guardEnvironment\(\);\n\/\/ A copy of the log[^\n]*\nrequire\("\.\/log-file"\)\.keepLog\("webapp"\);\n/);
  assert.match(read("webapp/move.js"), /const BOT_FOLDERS = \["wa-linked-session"\];/, "a move carries named folders only, so the log stays here");
});
