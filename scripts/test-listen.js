// Speech to text runs on the computer running ClosedHand, in its own process
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
