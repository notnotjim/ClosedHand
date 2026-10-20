// Phones talk first ("Talk or type"): a tap on the fist listens, the next
// sends what was said, and the reply is read aloud. On a wider screen the mic
// writes into the box instead, to edit before sending. Runs the real
// webapp/public/dictation.js against a stand-in browser.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function browser(words, extra = {}) {
  const fetched = [];
  let processor = null;
  class AudioContext {
    constructor() { this.sampleRate = 16000; this.state = "running"; this.destination = {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { processor = { connect() {}, disconnect() {}, onaudioprocess: null }; return processor; }
    resume() { return Promise.resolve(); }
    close() {}
  }
  const window = {
    AudioContext,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, ...(extra.navigator || {}) },
    localStorage: extra.localStorage,
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, json: async () => (url === "/api/dictation" ? { text: words } : { warming: true }) };
    },
    setTimeout, clearTimeout, Event: class { constructor(type) { this.type = type; } },
  };
  vm.runInNewContext(read("webapp/public/dictation.js"), { window, fetch: window.fetch, Float32Array, ArrayBuffer, DataView, Math, String, Promise, setTimeout, clearTimeout, Event: window.Event });
  const handlers = {};
  const classes = new Set();
  const attrs = {};
  const button = {
    hidden: false, title: "",
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k],
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  let focused = 0;
  const input = { value: "", dispatchEvent() {}, focus() { focused++; } };
  const note = { textContent: "", hidden: true };
  // A second of a voice-like tone, or of nothing at all.
  const tone = () => Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin(i / 8));
  const speak = (silent) => processor.onaudioprocess({ inputBuffer: { getChannelData: () => (silent ? new Float32Array(16000) : tone()) } });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { api: window.ClosedhandDictation, button, input, note, fetched, handlers, classes, attrs, speak, settle, focused: () => focused };
}

test("the fist listens on a tap, sends what was said on the next, and loads the voice for the reply", async () => {
  const b = browser("what's on tomorrow");
  const sent = [];
  let primed = 0;
  const ok = b.api.attach(b.button, b.input, b.note, {
    send: true, onWords: (w) => sent.push(w), onStop: () => primed++, thing: "the fist",
    labels: { idle: "Talk to Closedhand", recording: "Stop and send" },
    hints: { idle: "Tap, talk, tap to send", recording: "Listening, tap to send", busy: "Writing it out…" },
  });
  assert.equal(ok, true);
  assert.equal(b.note.textContent, "Tap, talk, tap to send", "the hint shows before anything happens");
  assert.equal(b.attrs["aria-label"], "Talk to Closedhand");

  b.handlers.click();
  await b.settle();
  assert.equal(b.fetched[0], "/api/dictation/warm?voice=1", "the reply will be read aloud, so the voice loads now");
  assert.ok(b.classes.has("recording"));
  assert.equal(b.note.textContent, "Listening, tap to send");
  assert.equal(b.attrs["aria-label"], "Stop and send");

  b.speak();
  b.handlers.click();
  assert.equal(primed, 1, "the tap that sends makes the sound ready, as phones only start sound from a tap");
  assert.equal(b.note.textContent, "Writing it out…");
  await b.settle();
  assert.deepEqual(sent, ["what's on tomorrow"]);
  assert.equal(b.input.value, "what's on tomorrow");
  assert.equal(b.focused(), 0, "no keyboard up over the reply");
  assert.equal(b.note.textContent, "Tap, talk, tap to send");
});

test("the fist shows it hears you: the voice's level while listening, nothing once it stops", async () => {
  const b = browser("hello");
  const levels = [], states = [];
  b.api.attach(b.button, b.input, b.note, { send: true, onWords: () => {}, onLevel: (l) => levels.push(l), onState: (s) => states.push(s) });
  b.handlers.click();
  await b.settle();
  b.speak();
  assert.ok(levels.at(-1) > 0.5 && levels.at(-1) <= 1, `a voice moves it (${levels.at(-1)})`);
  b.speak(true);
  assert.equal(levels.at(-1), 0, "silence leaves it still");
  b.handlers.click();
  assert.equal(levels.at(-1), 0, "and it settles when the recording stops");
  await b.settle();
  assert.deepEqual(states, ["idle", "recording", "busy", "idle"], "start and send are felt where phones allow it");
});

test("on a wider screen the mic writes into the box to edit, and loads no voice", async () => {
  const b = browser("move my 3pm to Thursday");
  const sent = [];
  b.api.attach(b.button, b.input, b.note, { send: () => false, onWords: (w) => sent.push(w) });
  assert.equal(b.note.hidden, true, "no hint line for the mic");
  b.handlers.click();
  await b.settle();
  assert.equal(b.fetched[0], "/api/dictation/warm");
  b.speak();
  b.handlers.click();
  await b.settle();
  assert.deepEqual(sent, []);
  assert.equal(b.input.value, "move my 3pm to Thursday");
  assert.equal(b.focused(), 1);
});

test("silence from the microphone is not sent to be written out, and says so", async () => {
  const b = browser("you");
  const sent = [];
  b.api.attach(b.button, b.input, b.note, { send: true, onWords: (w) => sent.push(w), thing: "the fist", hints: { idle: "Tap, talk, tap to send", recording: "Listening, tap to send", busy: "Writing it out…" } });
  b.handlers.click();
  await b.settle();
  b.speak(true);
  b.handlers.click();
  await b.settle();
  assert.equal(b.note.textContent, "No sound came through from the microphone. Tap the fist and try again.");
  assert.deepEqual(sent, [], "nothing sent, so no stray \"you\"");
  assert.ok(!b.fetched.includes("/api/dictation"), "nothing uploaded");
});

test("on an iPhone that would ask again, the tip to allow the microphone is given once", async () => {
  const store = {};
  const localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  const navigator = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1", permissions: { query: async () => ({ state: "prompt" }) } };
  for (const round of [1, 2]) {
    const b = browser("what's on tomorrow", { navigator, localStorage });
    b.api.attach(b.button, b.input, b.note, { send: true, onWords: () => {}, thing: "the fist", hints: { idle: "Tap, talk, tap to send", recording: "Listening, tap to send", busy: "Writing it out…" } });
    b.handlers.click();
    await b.settle();
    b.speak();
    b.handlers.click();
    await b.settle();
    if (round === 1) assert.match(b.note.textContent, /page menu beside the address, then the three dots, and under Website Settings set Microphone to Allow/);
    else assert.equal(b.note.textContent, "Tap, talk, tap to send", "said once on this device");
  }
});

test("too short a recording says which button to tap", async () => {
  const b = browser("");
  b.api.attach(b.button, b.input, b.note, { send: true, thing: "the fist", hints: { idle: "Tap, talk, tap to send", recording: "Listening, tap to send", busy: "Writing it out…" } });
  b.handlers.click();
  await b.settle();
  b.handlers.click();
  assert.equal(b.note.textContent, "That was too short to hear. Tap the fist, speak, then tap it again.");
});

test("the page: the fist and the chat apps on phones only, the reply read aloud whole, no keyboard after talking", () => {
  const page = read("webapp/views/index.html");
  assert.match(page, /<button type="button" class="talk-btn" id="talkBtn" aria-label="Talk to Closedhand"><img src="\/fist\.png" alt=""><\/button>/);
  assert.match(page, /\.talk, \.continue-on \{ display: none; \}\n  @media \(max-width: 600px\) \{\n    body:not\(\.no-talk\) \.talk \{ display: flex;/);
  assert.match(page, /var phone = window\.matchMedia\('\(max-width: 600px\)'\);/);
  assert.match(page, /hints: \{ idle: 'Tap, talk, tap to send', recording: 'Listening, tap to send', busy: 'Writing it out…' \},/);
  assert.match(page, /btn\.style\.setProperty\('--level', level === 0 \? 0 : shown\.toFixed\(3\)\);/, "the ring follows the voice");
  assert.match(page, /\.talk-btn\.recording::before \{ opacity: 1; transform: scale\(calc\(1\.05 \+ var\(--level, 0\) \* 0\.24\)\);/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\) \{ \.talk-btn, \.talk-btn img, \.talk-btn::after \{ animation: none !important; \}/);
  assert.match(page, /send: function \(\) \{ return phone\.matches; \}, onWords: sendSpoken, onStop: readyToSpeak/, "in a conversation on a phone the mic talks too");
  assert.match(page, /var aloud = live && window\._replyAloud && Date\.now\(\) - window\._replyAloud < 10 \* 60000;/);
  assert.match(page, /if \(aloud && reading\) setTimeout\(function \(\) \{ reading\.click\(\); \}, 0\);/);
  assert.match(page, /if \(!window\._replyAloud\) input\.focus\(\);/);
  assert.match(page, /: window\.talkFirst && window\.talkFirst\(\) \? \(document\.body\.classList\.contains\('chat-active'\) \? 'Type a message' : 'Or type here'\)/);
  const play = read("webapp/public/speech-playback.js");
  assert.match(play, /window\.ClosedHandSpeech = \{ addControl: addControl, receive: receive, stop: stop, prime: prime \};/);
  // An iPhone on silent mutes page audio unless it says it is playback.
  assert.match(play, /navigator\.audioSession\.type = "playback"/);
  assert.ok(play.indexOf("asPlayback();\n        context = context || new AudioContext();") > 0, "Read aloud asks for it in the tap");
  assert.ok(play.indexOf("asPlayback();\n    try { context = context || new AudioContext(); context.resume()") > 0, "and so does a reply read after talking");
});
