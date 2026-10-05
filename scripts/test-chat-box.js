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
  assert.match(chat, /attachBtn\.addEventListener\('click', function\(\) \{[\s\S]*?fileInput\.click\(\);\n\s*\}\);/, "it opens the file picker");
  assert.doesNotMatch(chat, /id="plusBtn"|plus-dropdown|>\s*Install a skill\s*<|>\s*Connect a service\s*</);
});

test("only linked chat apps show, directly, with no toggle", () => {
  assert.doesNotMatch(chat, /chatAppToggle|Chat using|send-via-close/);
  assert.match(chat, /<a class="via-icon" data-label="Continue on WhatsApp" id="viaWhatsApp" hidden>/, "hidden until linked");
  assert.match(chat, /<a class="via-icon" data-label="Continue on Telegram" id="viaTelegram" hidden>/);
  assert.match(chat, /wa\.href = "https:\/\/wa\.me\/" \+ st\.waLinked\.number; wa\.target = "_blank"; wa\.rel = "noopener"; wa\.hidden = false;/);
  assert.match(chat, /tg\.href = "https:\/\/t\.me\/" \+ st\.botUsername; tg\.target = "_blank"; tg\.rel = "noopener"; tg\.hidden = false;/);
});

test("the box stays open while composing, and the paperclip never moves it under the pointer", () => {
  assert.match(chat, /\.input-box-wrap:focus-within, \.input-box-wrap\.composing \{\n\s*max-width: 900px;/, "composing holds the open state that focus gave");
  assert.match(chat, /wrap\.classList\.toggle\('composing', picking \|\| !!input\.value\.trim\(\) \|\| pendingFiles\.length > 0\)/, "open with text, a file, or while choosing one");
  assert.match(chat, /attachBtn\.addEventListener\('mousedown', function\(e\) \{ e\.preventDefault\(\); \}\);/, "pressing the paperclip leaves focus where it was");
  assert.match(chat, /picking = !!wrap && \(wrap\.matches\(':focus-within'\) \|\| wrap\.classList\.contains\('composing'\)\);/, "a box that was open stays open through the picker; a closed one stays closed");
});

test("with a file attached, the words fit and Send lights up", () => {
  assert.match(chat, /pendingFiles\.length > 1 \? 'Ask about these files or just send'\n\s*: pendingFiles\.length === 1 \? 'Ask about this file or just send'/);
  assert.match(chat, /var hasText = input\.value\.trim\(\)\.length > 0 \|\| pendingFiles\.length > 0;/);
  assert.match(chat, /previewArea\.style\.cssText = 'display:flex;gap:8px;padding:0;margin:0 0 14px;flex-wrap:wrap;';/, "the chip lines up with the text, with room under it");
});

test("a recent conversation shows its name with when it was used right under it", () => {
  assert.match(chat, /'<span class="text"><span class="title">' \+ esc\(t\.title \|\| 'Untitled'\) \+ '<\/span>' \+\n\s*'<span class="meta">' \+ esc\(timeAgo\(t\.updated_at\)\) \+ count \+ '<\/span><\/span>'/);
  assert.match(chat, /\(t\.message_count === 1 \? ' message' : ' messages'\)/, "the count says what it counts");
});
