// The web chat's mic used the browser's own dictation, which sent the voice
// to Apple or Google and did nothing in Firefox. Now the browser records, packs
// it as 16 kHz mono WAV, and Closedhand writes it out with the same built-in
// speech to text as voice notes from chat apps, whatever key is set.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { downsample, encodeWav, RATE } = require("../webapp/public/dictation");
const { register } = require("../lib/dictation");
const { wavSamples } = require("../lib/services/listen");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("a recording is packed as the 16 kHz mono WAV the built-in speech to text reads", () => {
  const samples = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.5);
  const wav = Buffer.from(encodeWav(samples));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt16LE(22), 1, "one channel");
  assert.equal(wav.readUInt32LE(24), RATE);
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  const back = wavSamples(wav);
  assert.equal(back.length, samples.length);
  assert.ok(back.every((s, i) => Math.abs(s - samples[i]) < 1 / 16384), "the samples come back as recorded");
});

test("a phone's 48 kHz recording becomes 16 kHz, keeping the speech", () => {
  const second = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / 48000));
  const out = downsample(second, 48000);
  assert.equal(out.length, 16000);
  const expected = (i) => Math.sin((2 * Math.PI * 200 * (i * 3 + 1)) / 48000);
  assert.ok(out.every((s, i) => Math.abs(s - expected(i)) < 0.01), "a 200 Hz voice tone survives");
  assert.equal(downsample(second, 16000), second, "16 kHz is left as it is");
});

test("the bot writes out the web chat's recording for the person signed in, and says why when it can't", async () => {
  const routes = {};
  const warmed = [];
  let next = async () => "what's on tomorrow";
  const app = { post: (route, ...handlers) => { routes[route] = handlers[handlers.length - 1]; } };
  const quiet = console.error;
  const voiced = [];
  register(app, { verifyToken: (t) => (t === "good" ? "u1" : null), transcribe: (wav) => next(wav), warm: (ms) => { warmed.push(ms); return true; }, warmVoice: (ms) => { voiced.push(ms); return true; }, body: () => {} });
  const handler = routes["/internal/dictation"];
  const call = async (token, body) => {
    const out = { status: 200 };
    const res = { status(s) { out.status = s; return res; }, json(j) { out.body = j; return res; } };
    console.error = () => {};
    try { await handler({ get: () => token, body }, res); } finally { console.error = quiet; }
    return out;
  };
  const wav = Buffer.from(encodeWav(new Float32Array(8000)));
  assert.equal((await call("bad", wav)).status, 401);
  assert.equal((await call("good", Buffer.from("not a recording at all, just text that is long enough"))).status, 400);
  assert.deepEqual((await call("good", wav)).body, { text: "what's on tomorrow" });
  next = async () => { throw new Error("Speech to text is busy. Try again in a moment."); };
  assert.deepEqual(await call("good", wav), { status: 503, body: { error: "Speech to text is busy. Try again in a moment." } });
  next = async () => { throw new Error("worker exited with code 134"); };
  assert.match((await call("good", wav)).body.error, /couldn't write that out just now/, "a fault is not shown as it is");
  assert.match(read("index.js"), /require\("\.\/lib\/dictation"\)\.register\(ctx\.expressApp\);/);

  // Tapping the mic loads the model while the person talks, and keeps it a while.
  const out = { status: 200 };
  const res = { status(s) { out.status = s; return res; }, json(j) { out.body = j; return res; } };
  routes["/internal/dictation/warm"]({ get: () => "bad" }, res);
  assert.equal(out.status, 401);
  warmed.length = 0;
  routes["/internal/dictation/warm"]({ get: () => "good", query: {} }, res);
  assert.deepEqual(out.body, { warming: true });
  assert.deepEqual(warmed, [5 * 60000]);
  assert.deepEqual(voiced, [], "writing into the box reads nothing back, so the voice stays unloaded");
  // Talking on a phone sends, and the reply is read aloud: the voice loads too.
  routes["/internal/dictation/warm"]({ get: () => "good", query: { voice: "1" } }, res);
  assert.deepEqual(voiced, [5 * 60000]);
});

test("voice is always written out on this computer, never sent to Groq", async () => {
  const listenPath = require.resolve("../lib/services/listen");
  const real = require(listenPath);
  const got = [];
  require.cache[listenPath].exports = { ...real, transcribe: async (samples) => { got.push(samples.length); return { text: " call me back " }; } };
  process.env.GROQ_API_KEY = "gsk-kestrel-test";
  delete require.cache[require.resolve("../lib/voice")];
  try {
    const { transcribeAudio } = require("../lib/voice");
    assert.equal(await transcribeAudio(Buffer.from(encodeWav(new Float32Array(4000)))), "call me back");
    assert.deepEqual(got, [4000]);
  } finally {
    require.cache[listenPath].exports = real;
    delete process.env.GROQ_API_KEY;
    delete require.cache[require.resolve("../lib/voice")];
  }
  assert.doesNotMatch(read("lib/voice.js") + read("webapp/views/index.html"), /groq|SpeechRecognition/i);
});
