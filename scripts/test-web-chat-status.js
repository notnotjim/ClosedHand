// A web chat message's record says what happened to it: complete once the
// turn answered it (or handed it to a background run), error only when the
// turn failed. It used to stay at processing, so the clean-up at every restart
// marked each answered message as an error.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ws = fs.readFileSync(path.join(__dirname, "../lib/web-chat-ws.js"), "utf8");

test("the message's status follows its turn", () => {
  assert.match(ws, /status: "processing",\n  \}\)\.select\("id"\)\.single\(\)/);
  assert.match(ws, /await userStore\.save\(\);\n\s*settle\("complete"\);/);
  assert.match(ws, /console\.error\("\[WebChat\] ask error:", err\.message\);\n\s*settle\("error"\);/);
});
