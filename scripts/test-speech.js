const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { speechText, chunks, MAX_TEXT } = require('../lib/speech/text');
const { createSpeechService } = require('../lib/services/tts');
const { attachSpeech } = require('../lib/speech/web-playback');
const { wav, oggOpus } = require('../lib/speech/audio');
const { verified } = require('./prepare-voice');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function fixture(overrides = {}) {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.calls = []; workers.push(this); }
    send(msg) { if (msg.type !== 'init') this.calls.push(msg); }
    ref() {} unref() {}
    kill() { this.terminated = true; return true; }
    ready() { this.emit('message', { type: 'ready' }); }
    done() { this.emit('message', { type: 'done', id: this.calls.at(-1).id, audio: Buffer.from('voice') }); }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closedhand-voice-test-'));
  for (const file of require('../lib/speech/assets.json').files) {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture');
  }
  const service = createSpeechService({ directory: dir, spawn: () => new FakeWorker(), idleMs: 5, ...overrides });
  return { service, workers, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('speech keeps link labels, skips fenced code and rejects oversized input without truncating it', () => {
  assert.equal(speechText('**Ready.** [Boarding pass](https://example.com/ticket)\n```js\nsecretCode();\n```'), 'Ready. Boarding pass');
  assert.throws(() => speechText('```code only```'), /no text/);
  assert.throws(() => speechText('a'.repeat(MAX_TEXT + 1)), /too long/);
  const text = 'One sentence with no stops '.repeat(50).trim();
  assert.equal(chunks(text).join(' '), text);
  assert.ok(chunks(text).every(x => x.length <= 180));
  assert.equal(chunks('It costs 2.50. Version 1.2 is ready!').join(' '), 'It costs 2.50. Version 1.2 is ready!');
});

test('asset verification rejects same-length corruption', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-hash-'));
  try {
    const target = path.join(dir, 'asset'); fs.writeFileSync(target, 'good');
    const entry = { bytes: 4, sha256: crypto.createHash('sha256').update('good').digest('hex') };
    assert.equal(await verified(target, entry), true);
    fs.writeFileSync(target, 'evil'); assert.equal(await verified(target, entry), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('serialises synthesis, bounds queue and releases worker after idle', async () => {
  const f = fixture();
  try {
    const jobs = Array.from({ length: 4 }, () => f.service.synthesize('Read this.'));
    await assert.rejects(f.service.synthesize('Too many.'), /busy/);
    assert.equal(f.workers.length, 1);
    const w = f.workers[0]; w.ready();
    for (const job of jobs) { assert.equal(w.calls.length, jobs.indexOf(job) + 1); w.done(); await job; }
    await new Promise(r => setTimeout(r, 15)); assert.ok(w.terminated);
  } finally { f.cleanup(); }
});

test('cancelling active and queued work leaves the next request usable', async () => {
  const f = fixture();
  try {
    const a = new AbortController(), b = new AbortController();
    const first = f.service.synthesize('First.', { signal: a.signal });
    const second = f.service.synthesize('Second.', { signal: b.signal });
    const third = f.service.synthesize('Third.');
    const firstReject = assert.rejects(first, /stopped/), secondReject = assert.rejects(second, /stopped/);
    b.abort(); a.abort(); await Promise.all([firstReject, secondReject]);
    assert.ok(f.workers[0].terminated);
    const next = f.workers[1]; next.ready(); next.done(); assert.equal((await third).toString(), 'voice');
  } finally { f.cleanup(); }
});

test('worker failure and timeout reject promptly and allow recovery', async () => {
  const f = fixture({ timeoutMs: 20 });
  try {
    const failed = f.service.synthesize('First.'); const rejected = assert.rejects(failed, /couldn.t start/);
    f.workers[0].emit('error', new Error('test crash')); await rejected;
    await assert.rejects(f.service.synthesize('Timeout.'), /too long/);
    const recovered = f.service.synthesize('Recovered.');
    f.workers.at(-1).ready(); f.workers.at(-1).done(); await recovered;
  } finally { f.cleanup(); }
});

test('speech results go only to requesting socket; disconnect cancels work', async () => {
  const ws = new EventEmitter(); ws.OPEN = ws.readyState = 1;
  const sent = []; ws.send = data => sent.push(JSON.parse(data));
  let input, callback, signal, resolve;
  const handle = attachSpeech(ws, { streamSpeech(text, cb, opts) {
    input = text; callback = cb; signal = opts.signal;
    return new Promise(r => { resolve = r; });
  } });
  assert.equal(handle({ type: 'chat', text: 'normal' }), false);
  assert.equal(handle({ type: 'speech', id: 'one', text: 'Read this' }), true);
  assert.equal(input, 'Read this'); callback(Buffer.from('wav'));
  assert.deepEqual(sent[0], { type: 'speech_chunk', id: 'one', audio: Buffer.from('wav').toString('base64') });
  ws.emit('close'); assert.ok(signal.aborted); resolve();
  await new Promise(r => setImmediate(r)); assert.equal(sent.length, 1);
});

test('WAV and Ogg Opus carry correct sample rate, duration, CRC and end marker', () => {
  const samples = Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i * 440 * 2 * Math.PI / 24000) * 0.2);
  const wave = wav(samples); assert.equal(wave.readUInt32LE(24), 24000); assert.equal(wave.readUInt32LE(40), 48000);
  const ogg = oggOpus(samples); let offset = 0, sequence = 0, last;
  while (offset < ogg.length) {
    assert.equal(ogg.toString('ascii', offset, offset + 4), 'OggS');
    const n = ogg[offset + 26]; let payload = 0;
    for (let j = 0; j < n; j++) payload += ogg[offset + 27 + j];
    const page = Buffer.from(ogg.subarray(offset, offset + 27 + n + payload));
    assert.equal(page.readUInt32LE(18), sequence++);
    const stored = page.readUInt32LE(22); page.writeUInt32LE(0, 22);
    let crc = 0;
    for (const b of page) { crc ^= b << 24; for (let j = 0; j < 8; j++) crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0; }
    assert.equal(crc, stored);
    last = page; offset += page.length;
  }
  assert.equal(last[5], 4); assert.equal(last.readBigUInt64LE(6), 48312n);
  assert.ok(ogg.includes(Buffer.from('OpusHead')));
});
