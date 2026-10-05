// The chat box holds what is about the message being written: attach, the
// chat apps already linked (to carry on there), the mic and Send. Setting up
// connections, skills and the Mac lives on the dashboard, not in a "+" menu.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const chat = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "index.html"), "utf8");

test("the paperclip attaches straight away; no menu of dashboard shortcuts", () => {
  assert.match(chat, /<button class="toolbar-btn" id="attachBtn" type="button" title="Attach files or images" aria-label="Attach files or images">/);
  assert.match(chat, /attachBtn\.addEventListener\('click', function\(\) \{ fileInput\.click\(\); \}\);/);
  assert.doesNotMatch(chat, /id="plusBtn"|plus-dropdown|>\s*Install a skill\s*<|>\s*Connect a service\s*</);
});

test("only linked chat apps show, directly, with no toggle", () => {
  assert.doesNotMatch(chat, /chatAppToggle|Chat using|send-via-close/);
  assert.match(chat, /<a class="via-icon" data-label="Continue on WhatsApp" id="viaWhatsApp" hidden>/, "hidden until linked");
  assert.match(chat, /<a class="via-icon" data-label="Continue on Telegram" id="viaTelegram" hidden>/);
  assert.match(chat, /wa\.href = "https:\/\/wa\.me\/" \+ st\.waLinked\.number; wa\.target = "_blank"; wa\.rel = "noopener"; wa\.hidden = false;/);
  assert.match(chat, /tg\.href = "https:\/\/t\.me\/" \+ st\.botUsername; tg\.target = "_blank"; tg\.rel = "noopener"; tg\.hidden = false;/);
});
