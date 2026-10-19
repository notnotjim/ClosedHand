// Speech to text runs on the computer running Closedhand, in its own process
// like the voice, and is unloaded when idle. The model files are pinned and
// checked at build time; nothing is fetched while it runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createListeningService, wavSamples } = require('../lib/services/listen');
const manifest = require('../lib/speech/listen-assets.json');

function fakeModel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-'));
  for (const f of manifest.files) { fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true }); fs.writeFileSync(path.join(dir, f.path), ''); }
  return dir;
}
function fakeWorker(answer) {
  const spawned = [];
  const spawn = () => {
    const w = new EventEmitter(); w.killed = false; spawned.push(w);
    w.send = (msg) => { if (msg.type === 'init') return setImmediate(() => w.emit('message', { type: 'ready' })); setImmediate(() => w.emit('message', { id: msg.id, ...answer(msg) })); };
    w.kill = () => { w.killed = true; }; w.ref = () => {}; w.unref = () => {};
    return w;
  };
  return { spawn, spawned };
}

test('speech is written out with its language and times, and the model unloads when idle', async () => {
  const worker = fakeWorker((msg) => ({ type: 'done', language: 'ja', lines: [{ start: 0, text: 'こんにちは' }], text: 'こんにちは', got: msg.audio.length }));
  const service = createListeningService({ directory: fakeModel(), spawn: worker.spawn, idleMs: 5 });
  const heard = await service.transcribe(Buffer.alloc(32000));
  assert.deepEqual(heard, { language: 'ja', lines: [{ start: 0, text: 'こんにちは' }], text: 'こんにちは' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(worker.spawned[0].killed, true, 'the model is released when idle');
});

test('the mic loads the model before the speech arrives, and keeps it a while', async () => {
  const worker = fakeWorker(() => ({ type: 'done', language: 'en', lines: [], text: 'on my way' }));
  const service = createListeningService({ directory: fakeModel(), spawn: worker.spawn, idleMs: 5 });
  assert.equal(service.warm(300), true);
  assert.equal(worker.spawned.length, 1, 'loading starts at once, with no speech yet');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(worker.spawned[0].killed, false, 'kept past the usual idle time');
  assert.equal((await service.transcribe(Buffer.alloc(3200))).text, 'on my way');
  assert.equal(worker.spawned.length, 1, 'the speech uses the model already loaded');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(worker.spawned[0].killed, true, 'and released once the time is up');
  assert.equal(createListeningService({ directory: path.join(os.tmpdir(), 'no-such-listen-model'), spawn: () => { throw new Error('should not start'); } }).warm(), false);
});

test('a missing model says so instead of failing strangely', async () => {
  const service = createListeningService({ directory: path.join(os.tmpdir(), 'no-such-listen-model'), spawn: () => { throw new Error('should not start'); } });
  await assert.rejects(service.transcribe(Buffer.alloc(10)), /speech to text is missing/);
});

test('WAV voice notes are read into samples', () => {
  const pcm = Buffer.alloc(8); pcm.writeInt16LE(16384, 0); pcm.writeInt16LE(-32768, 2);
  const head = Buffer.alloc(44); head.write('RIFF', 0); head.write('WAVE', 8); head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.write('data', 36); head.writeUInt32LE(8, 40);
  const samples = wavSamples(Buffer.concat([head, pcm]));
  assert.equal(samples.length, 4); assert.equal(samples[0], 0.5); assert.equal(samples[1], -1);
});

test('the model is pinned and prepared at build time for Docker and the Mac app', () => {
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0));
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('Dockerfile'), /node scripts\/prepare-voice\.js --listening/);
  assert.match(read('desktop/build.sh'), /prepare-voice\.js" --listening/);
  assert.match(read('lib/speech/listen-worker.js'), /env\.allowRemoteModels = false/);
});

test('voice notes are written out on this computer', async () => {
  const listenPath = require.resolve('../lib/services/listen');
  const audioPath = require.resolve('../lib/speech/audio');
  const real = require(listenPath);
  const got = [];
  require.cache[listenPath].exports = { ...real, transcribe: async (samples) => { got.push(samples.length); return { language: 'en', lines: [], text: 'call me back' }; } };
  require(audioPath);
  const realAudio = require.cache[audioPath].exports;
  require.cache[audioPath].exports = { ...realAudio, oggOpusSamples: () => new Float32Array(16000) };
  delete require.cache[require.resolve('../lib/voice')];
  try {
    const { transcribeAudio } = require('../lib/voice');
    assert.equal(await transcribeAudio(Buffer.from('OggS....'), 'voice.ogg'), 'call me back');
    assert.deepEqual(got, [16000]);
    await assert.rejects(transcribeAudio(Buffer.from('....ftypM4A '), 'voice.m4a'), /can't be written out on this computer yet/);
  } finally {
    require.cache[listenPath].exports = real; require.cache[audioPath].exports = realAudio;
    delete require.cache[require.resolve('../lib/voice')];
  }
});

test('a voice note or the mic skips line times, which only a video needs, and voice asks for that', async () => {
  const asked = [];
  const worker = fakeWorker((msg) => { asked.push(msg.timestamps); return { type: 'done', language: 'en', lines: [], text: 'back by six' }; });
  const svc = createListeningService({ directory: fakeModel(), spawn: worker.spawn, idleMs: 10 });
  await svc.transcribe(new Float32Array(1600), { timestamps: false });
  await svc.transcribe(new Float32Array(1600));
  assert.deepEqual(asked, [false, true], 'a video still gets its times');
  assert.match(fs.readFileSync(path.join(__dirname, '../lib/voice.js'), 'utf8'), /listen\.transcribe\(samples, \{ timestamps: false \}\)/);
});
