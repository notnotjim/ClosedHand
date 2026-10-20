// Recordings and videos, sent in a chat or found by File Search, are heard on
// the computer running Closedhand: what's said with its times, and a video's
// frames. Invented clips and stand-in services only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const SAID = { language: 'en', lines: [{ start: 0, text: 'Welcome back to the long run.' }, { start: 475, text: 'Today we talk about sleep.' }], text: '' };

// lib/video.js with the sandbox and the speech to text stood in.
function withStandIns(sandbox, listen) {
  const sPath = require.resolve('../lib/sandbox'), lPath = require.resolve('../lib/services/listen'), vPath = require.resolve('../lib/video');
  const saved = { s: require.cache[sPath], l: require.cache[lPath] };
  require.cache[sPath] = { id: sPath, filename: sPath, loaded: true, exports: sandbox };
  require.cache[lPath] = { id: lPath, filename: lPath, loaded: true, exports: { ...listen, wavSamples: () => new Float32Array(16000 * 9) } };
  delete require.cache[vPath];
  const video = require('../lib/video');
  return { video, restore() { for (const [p, m] of [[sPath, saved.s], [lPath, saved.l]]) { if (m) require.cache[p] = m; else delete require.cache[p]; } delete require.cache[vPath]; } };
}

test('a video file goes through the sandbox like a link: frames and what is said, then nothing is kept', async () => {
  const calls = [];
  const frame = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const meta = { title: 'Masai Mara day 2.mp4', duration: 512, frames: [{ time: 30, offset: 0, size: 6 }, { time: 250, offset: 0, size: 6 }, { time: 490, offset: 0, size: 6 }], speech_parts: ['speech-0.pcm'], speech_seconds: 512 };
  const files = { 'meta.json': Buffer.from(JSON.stringify(meta)), 'frames.bin': frame, 'speech-0.pcm': Buffer.alloc(32000) };
  let job;
  const sandbox = {
    ensureSandbox: async () => {},
    // No sandboxExec here: a file's hearing must not count against the
    // model's own 200 runs a day, so calling it would fail this test.
    sandboxRequest: async (userId, method, route, body) => {
      calls.push([route, body]);
      if (route === '/files/write') { job = /in-([0-9a-f]+)\//.exec(body.path)[1]; return { success: true }; }
      if (route === '/exec' && /Popen/.test(body.code)) return { stdout: 'started\n' };
      if (route === '/files/read') return { content: 'CLOSEDHAND_VIDEO ' + JSON.stringify({ ok: true, dir: `.closedhand-video/${job}`, parts: { meta: 'meta.json', frames: 'frames.bin', speech: ['speech-0.pcm'] } }) };
      return { stdout: '' };
    },
    sandboxFileDownload: async (userId, p) => ({ content: files[p.split('/').pop()].toString('base64') }),
  };
  const { video, restore } = withStandIns(sandbox, { transcribe: async () => SAID });
  try {
    const heard = await video.hearMedia({ userId: 'u1', buffer: Buffer.from('not really a video'), name: 'Masai Mara day 2.mp4', video: true, frames: 2 });
    assert.deepEqual(heard.said.lines, SAID.lines);
    assert.equal(heard.duration, 512);
    assert.deepEqual(heard.frames.map((f) => f.time), [30, 490], 'frames spread across the video');
    const write = calls.find(([r]) => r === '/files/write');
    assert.match(write[1].path, /^\.closedhand-video\/in-[0-9a-f]{12}\/file\.mp4$/, 'stored under its own name, never the one sent');
    assert.equal(write[1].encoding, 'base64');
    const started = calls.find(([r, b]) => r === '/exec' && /Popen/.test(b.code))[1].code;
    const script = Buffer.from(/b64decode\("([^"]+)"\)/.exec(started)[1], 'base64').toString();
    const args = JSON.parse(Buffer.from(/b64decode\("([^"]+)"\)/.exec(script)[1], 'base64').toString());
    assert.deepEqual({ path: args.path, title: args.title, audio_seconds: args.audio_seconds }, { path: write[1].path, title: 'Masai Mara day 2.mp4', audio_seconds: 10800 });
    const cleanup = calls.filter(([r, b]) => r === '/exec' && /rmtree/.test(b.code)).pop()[1].code;
    assert.match(cleanup, new RegExp(`\\.closedhand-video/${job}`));
    assert.match(cleanup, new RegExp(`\\.closedhand-video/in-${job}`), 'the copy put on the sandbox goes too');
  } finally { restore(); }
});

test('a sandbox that fails says so in plain words', async () => {
  const sandbox = { ensureSandbox: async () => { throw new Error('connect ECONNREFUSED'); }, sandboxRequest: async () => ({}) };
  const { video, restore } = withStandIns(sandbox, { transcribe: async () => SAID });
  try {
    if (process.platform === 'darwin') return; // a Mac hears the sound itself instead
    await assert.rejects(video.hearMedia({ userId: 'u1', buffer: Buffer.from('x'), name: 'memo.m4a' }), /hears recordings and videos with its sandbox computer/);
  } finally { restore(); }
});

test('a recording on a Mac is heard by the Mac itself, with no sandbox', { skip: process.platform !== 'darwin' && 'the Mac way needs afconvert' }, async () => {
  const sandbox = { ensureSandbox: async () => { throw new Error('the sandbox is not used here'); } };
  const { video, restore } = withStandIns(sandbox, { transcribe: async (samples) => ({ ...SAID, heardSeconds: samples.length / 16000 }) });
  try {
    // A real AIFF that afconvert reads: a second of quiet.
    const pcm = Buffer.alloc(16000 * 2);
    const aiff = Buffer.concat([Buffer.from('FORM'), Buffer.from([0, 0, 0, 0]), Buffer.from('AIFFCOMM'), Buffer.from([0, 0, 0, 18, 0, 1, 0, 0, 0x3e, 0x80, 0, 16, 0x40, 0x0c, 0xfa, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('SSND'), Buffer.alloc(4), Buffer.alloc(8), pcm]);
    aiff.writeUInt32BE(aiff.length - 8, 4); aiff.writeUInt32BE(pcm.length + 8, 42); // the FORM and SSND sizes
    const heard = await video.hearMedia({ userId: 'u1', buffer: aiff, name: 'quiet.aiff' });
    assert.deepEqual(heard.said.lines, SAID.lines);
  } finally { restore(); }
});

test('the bot hears files for File Search, and each line keeps its time', async () => {
  let handler;
  const app = { post: (route, body, fn) => { if (route === '/internal/hear') handler = fn; } };
  require('../lib/hear-route').register(app, {
    verifyToken: (t) => (t === 'good' ? 'u1' : null), body: () => {},
    hear: async (args) => { assert.deepEqual({ name: args.name, video: args.video, frames: args.frames }, { name: 'Long Run Ep 14.mp3', video: false, frames: 0 }); return { said: SAID, duration: 3600, frames: [] }; },
  });
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const ok = res();
  await handler({ get: () => 'good', body: Buffer.from('mp3'), query: { name: 'Long Run Ep 14.mp3' } }, ok);
  assert.equal(ok.body.text, '[0:00] Welcome back to the long run.\n[7:55] Today we talk about sleep.');
  const denied = res();
  await handler({ get: () => 'forged', body: Buffer.from('mp3'), query: {} }, denied);
  assert.equal(denied.code, 401);
});

test('File Search, the web chat and saved files all hear recordings and videos', () => {
  const rag = read('webapp/rag-processor.js');
  for (const ext of ['mp3', 'm4a', 'wav', 'mp4', 'mov', 'webm']) assert.match(rag, new RegExp(`"${ext}"`), ext);
  assert.match(rag, /if \(read\.kind === "audio" \|\| read\.kind === "video"\) return hearFile\(/);
  assert.match(rag, /fetch\(`\$\{BOT_INTERNAL_URL\}\/internal\/hear\?\$\{query\}`/);
  assert.match(rag, /"x-closedhand-token": botToken\(userId\)/);
  assert.match(read('index.js'), /require\("\.\/lib\/hear-route"\)\.register\(ctx\.expressApp\);/);
  const engine = read('lib/engine.js');
  assert.match(engine, /\} else if \(fileData\.isAudio \|\| fileData\.isVideo\) \{\n\s*\/\/ Heard the way a video link is/);
  assert.match(engine, /frames: fileData\.isVideo && chatSeesImages \? 8 : 0/, 'frames only for a chat model that can see them');
  assert.match(read('lib/attachments.js'), /require\("\.\/video"\)\.hearMedia\(\{ userId, buffer, name: att\.fileName, video: read\.kind === "video" \}\)/);
  const script = read('lib/video-sandbox.py');
  assert.match(script, /def local\(path\):/);
  assert.match(script, /local\(ARGS\["path"\]\) if ARGS\.get\("path"\)/);
  assert.match(read('webapp/server.js'), /const \{ BOT_INTERNAL_URL, botToken \} = require\("\.\/bot-call"\);/);
});
