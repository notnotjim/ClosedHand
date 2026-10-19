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

test("the working star turns smoothly: no symbol a phone draws as an emoji, a calm pace, and a box that never moves the line", () => {
  const page = require("fs").readFileSync(require("path").join(__dirname, "../webapp/views/index.html"), "utf8");
  const chars = page.match(/var _spinnerChars = \[([^\]]+)\]/)[1].match(/\\u([0-9A-F]{4})/gi).map((u) => parseInt(u.slice(2), 16));
  // Symbols with an emoji form on phones (Unicode's Emoji list): never in the cycle.
  const EMOJI = [0x2733, 0x2734, 0x2747, 0x2728, 0x2721, 0x2B50, 0x274C, 0x2705, 0x2714, 0x2716];
  for (const c of chars) assert.ok(!EMOJI.includes(c), "U+" + c.toString(16).toUpperCase());
  assert.ok(Number(page.match(/var SPINNER_MS = (\d+);/)[1]) >= 100, "slow enough to read as turning");
  assert.doesNotMatch(page, /_spinnerChars\.length;[\s\S]{0,200}\}, 50\);/, "no 50 ms flicker left");
  assert.match(page, /\.tl-spinner \{\n    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;\n    width: 16px; height: 18px; overflow: hidden;/);
  assert.match(page, /prefers-reduced-motion: reduce\)'\)\.matches\) return;/, "still for anyone who asks for less motion");
});
