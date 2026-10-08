// Videos are understood with the best method the person's chosen models
// support, decided from the same checked capabilities as images: a link the
// model opens itself, the whole video, frames with their times and what's said
// in one request (by the image model when the primary is text only), or
// what's said alone. Nothing fetched is kept. Invented links and models only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = (f) => path.join(__dirname, '../lib', f);
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const policy = require('../lib/model-policy');
const wire = require('../lib/model-wire');

test('video abilities come from the provider or a known family, never a guess', () => {
  const gemini = policy.capabilities({ backend: 'gemini' }, 'gemini-2.5-flash');
  assert.equal(gemini.video, true); assert.equal(gemini.videoLinks, true);
  const router = policy.capabilities({ backend: 'custom', baseUrl: 'https://openrouter.ai/api/v1' }, 'vendor/vl-model', { architecture: { input_modalities: ['text', 'image', 'video'] } });
  assert.equal(router.video, true); assert.equal(router.videoLinks, false, 'only a provider known to open links gets them');
  assert.equal(policy.capabilities({ backend: 'anthropic' }, 'claude-opus-5-5').video, null);
  assert.equal(policy.capabilities({ backend: 'custom', baseUrl: 'https://api.deepseek.com/v1' }, 'deepseek-flash').video, null);
});

test('video travels in each provider format, and never to a model that does not take it', async () => {
  const msgs = [{ role: 'user', content: [{ type: 'video', source: { type: 'url', url: 'https://www.youtube.com/watch?v=abc' } }, { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' } }] }];
  assert.deepEqual(wire.convertMessagesToGemini('', msgs).contents[0].parts, [{ fileData: { fileUri: 'https://www.youtube.com/watch?v=abc' } }, { inlineData: { mimeType: 'video/mp4', data: 'AAAA' } }]);
  assert.deepEqual(wire.convertMessagesToOpenAI('', msgs).at(-1).content.map((p) => p.video_url.url), ['https://www.youtube.com/watch?v=abc', 'data:video/mp4;base64,AAAA']);
  const realFetch = global.fetch; let sent = 0; global.fetch = async () => { sent++; throw new Error('not reached'); };
  try {
    await assert.rejects(wire.request({ backend: 'custom', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', capabilities: { vision: true } }, { model: 'deepseek-flash', messages: msgs }), (e) => e.code === 'video_not_supported');
    assert.equal(sent, 0);
  } finally { global.fetch = realFetch; }
});

test('the model check proves video with a made-up clip, and a failure never blocks saving', async () => {
  const wirePath = require.resolve('../webapp/model-wire');
  const realWire = require(wirePath);
  const run = async (watches) => {
    require.cache[wirePath].exports = { ...realWire, listModels: async () => [],
      request: async (conn, params) => {
        const parts = params.messages.at(-1).content;
        const has = (t) => Array.isArray(parts) && parts.some((b) => b.type === t);
        if (params.tools) return params.messages.length > 1 ? { content: [{ type: 'text', text: 'done' }] } : { content: [{ type: 'tool_use', id: 't', name: 'capability_check', input: { value: 4 } }] };
        if (has('video')) { if (!watches) throw Object.assign(new Error('HTTP 400'), { status: 400 }); return { content: [{ type: 'text', text: 'Red, then blue.' }] }; }
        if (has('image')) return { content: [{ type: 'text', text: 'Red' }] };
        return { content: [{ type: 'text', text: 'ready' }] };
      } };
    delete require.cache[require.resolve('../webapp/model-config')];
    return require('../webapp/model-config').prepare({ primary: { provider: 'gemini', apiKey: 'k' }, model: 'gemini-2.5-flash', visionMode: 'same' }, {});
  };
  try {
    const ok = await run(true);
    assert.equal(ok.roles.chat.capabilities.video, true); assert.equal(ok.roles.chat.capabilities.videoLinks, true);
    const no = await run(false);
    assert.equal(no.roles.chat.capabilities.video, false, 'saved, with videos watched through frames');
    assert.equal(no.roles.chat.capabilities.videoLinks, false);
  } finally { require.cache[wirePath].exports = realWire; delete require.cache[require.resolve('../webapp/model-config')]; }
});

// --- lib/video.js with the sandbox, the models and speech to text stood in for ---
const calls = { exec: [], downloads: [], requests: [], heard: [] };
let sandboxReply = null, failWhole = false;
const PARTS = {
  'meta.json': () => Buffer.from(JSON.stringify(sandboxReply.meta)),
  'frames.bin': () => Buffer.from('AAAABBBB'),
  'video.mp4': () => Buffer.from('MP4DATA'),
  'speech-0.pcm': () => Buffer.alloc(32000 * 3),
  'speech-1.pcm': () => Buffer.alloc(32000 * 2),
};
function stub(rel, exports) { const file = require.resolve(lib(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; }
stub('sandbox.js', {
  ensureSandbox: async () => {},
  sandboxExec: async (u, lang, code) => {
    calls.exec.push(code.includes('CLOSEDHAND_VIDEO') ? 'gather' : code.includes('rmtree') ? 'cleanup' : 'other');
    if (code.includes('CLOSEDHAND_VIDEO')) return { stdout: 'CLOSEDHAND_VIDEO ' + JSON.stringify(sandboxReply.out) };
    return { stdout: '' };
  },
  sandboxFileDownload: async (u, p) => { calls.downloads.push(p.split('/').pop()); return { content: PARTS[p.split('/').pop()]().toString('base64') }; },
});
stub('services/listen.js', { transcribe: async (pcm) => { calls.heard.push(pcm.length); return { language: 'en', lines: [{ start: 1, text: 'hello' }] }; } });
stub('llm.js', { settingsOf: (store) => store.profile.settings });
stub('usage.js', { recordUsage() {} });
const progress = [];
stub('user-mutex.js', { touchMutexProgress: (u) => progress.push(u) });
stub('model-wire.js', { ...wire, request: async (conn, params) => {
  calls.requests.push({ model: conn.model, content: params.messages[0].content });
  if (failWhole && params.messages[0].content.some((b) => b.type === 'video')) throw new Error('too big');
  return { content: [{ type: 'text', text: 'account from ' + conn.model }] };
} });
const video = require('../lib/video');

const conn = (model, capabilities, backend = 'custom') => ({ provider: 'x', backend, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model, capabilities });
function setup({ chat, vision }) {
  const connections = { primary: conn(chat.model, chat.cap, chat.backend) };
  const roles = { chat: { connection: 'primary', model: chat.model, capabilities: chat.cap }, background: { connection: 'primary', model: chat.model } };
  if (vision === 'same') roles.vision = { connection: 'primary', model: chat.model, capabilities: chat.cap };
  else if (vision) { connections.vision = conn(vision.model, vision.cap); roles.vision = { connection: 'vision', model: vision.model, capabilities: vision.cap }; }
  return { profile: { settings: { model_config: { version: 1, connections, roles } } } };
}
const downloaded = ({ parts = {}, meta = {} } = {}) => ({ out: { ok: true, dir: '.closedhand-video/j1', parts: { meta: 'meta.json', frames: 'frames.bin', video: null, speech: [], ...parts } },
  meta: { title: 'A clip', duration: 9, frames: [{ time: 1, offset: 0, size: 4 }, { time: 5, offset: 4, size: 4 }], frame_source: 'video', captions: null, speech_parts: [], ...meta } });
const reset = (reply) => { calls.exec = []; calls.downloads = []; calls.requests = []; calls.heard = []; sandboxReply = reply; failWhole = false; };

test('a model that opens YouTube links itself gets the link, and nothing is fetched', async () => {
  reset(null);
  const store = setup({ chat: { model: 'gemini-2.5-flash', backend: 'gemini', cap: { vision: true, video: true, videoLinks: true } }, vision: 'same' });
  const r = await video.watchVideo({ userId: 'u1', store, url: 'https://www.youtube.com/watch?v=abc', question: 'What happens?' });
  assert.equal(r.method, 'watched from the link');
  assert.deepEqual(calls.exec, [], 'no sandbox work at all');
  assert.equal(calls.requests[0].content.find((b) => b.type === 'video').source.url, 'https://www.youtube.com/watch?v=abc');
});

test('a model that takes video gets the whole video, and the parts are deleted', async () => {
  reset(downloaded({ parts: { video: 'video.mp4' } }));
  const store = setup({ chat: { model: 'video-model', cap: { vision: true, video: true } }, vision: 'same' });
  const r = await video.watchVideo({ userId: 'u1', store, url: 'https://www.tiktok.com/@someone/video/1' });
  assert.equal(r.method, 'watched whole');
  assert.equal(calls.requests[0].content.find((b) => b.type === 'video').source.data, Buffer.from('MP4DATA').toString('base64'));
  assert.deepEqual(calls.exec, ['gather', 'cleanup']);
});

test('if the whole video fails, frames and speech go in one request, in order with their times', async () => {
  reset(downloaded({ parts: { video: 'video.mp4', speech: ['speech-0.pcm', 'speech-1.pcm'] }, meta: { speech_parts: ['speech-0.pcm', 'speech-1.pcm'], speech_seconds: 5 } }));
  failWhole = true;
  const store = setup({ chat: { model: 'video-model', cap: { vision: true, video: true } }, vision: 'same' });
  const r = await video.watchVideo({ userId: 'u1', store, url: 'https://www.tiktok.com/@someone/video/1' });
  assert.equal(r.method, "frames and what's said");
  const last = calls.requests.at(-1).content;
  const shape = last.map((b) => (b.type === 'image' ? 'image' : b.text.startsWith('[') ? b.text : b.type));
  assert.deepEqual(shape.slice(2, 6), ['[0:01]', 'image', '[0:05]', 'image'], 'each frame follows its time');
  assert.match(last.at(-1).text, /\[0:01\] hello[\s\S]*\[0:04\] hello/, 'speech parts keep their place in time');
  assert.deepEqual(calls.heard, [96000, 64000]);
  assert.equal(calls.exec.at(-1), 'cleanup');
});

test('with a text-only primary model, the chosen image model does the looking', async () => {
  reset(downloaded({ meta: { captions: { source: 'written', lines: [{ start: 2, text: 'hi' }] } } }));
  const store = setup({ chat: { model: 'text-model', cap: { vision: false } }, vision: { model: 'image-model', cap: { vision: true } } });
  const r = await video.watchVideo({ userId: 'u1', store, url: 'https://x.com/someone/status/1' });
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.requests[0].model, 'image-model');
  assert.equal(r.account, 'account from image-model');
  assert.match(calls.requests[0].content.at(-1).text, /captions written for the video/);
});

test('YouTube without a link-opening model uses captions and preview frames, never a download', async () => {
  reset(downloaded({ meta: { frame_source: 'preview', captions: { source: 'automatic', lines: [{ start: 0, text: 'intro' }] } } }));
  const store = setup({ chat: { model: 'vision-model', cap: { vision: true } }, vision: 'same' });
  const r = await video.watchVideo({ userId: 'u1', store, url: 'https://youtu.be/abc' });
  assert.equal(r.method, 'preview frames and captions');
  assert.match(read('lib/video.js'), /gather\(userId, href, \{ youtube, videoBytes/);
  const script = read('lib/video-sandbox.py');
  assert.match(script, /"skip_download": True/, 'YouTube is read, not downloaded');
  assert.match(script, /meta, frames, video = youtube\(ARGS\["url"\]\) if ARGS.get\("youtube"\) else download\(ARGS\["url"\]\)/);
});

test('with images off, what is said is read directly, with no extra model call', async () => {
  reset(downloaded({ meta: { captions: { source: 'written', lines: [{ start: 3, text: 'the words' }] } } }));
  const store = setup({ chat: { model: 'text-model', cap: { vision: false } }, vision: null });
  const r = await video.watchVideo({ userId: 'u1', store, url: 'https://vimeo.com/1' });
  assert.equal(r.method, "what's said only");
  assert.equal(calls.requests.length, 0);
  assert.match(r.account, /\[0:03\] the words/);
});

test('a site that wants a sign-in says so plainly, and private addresses are refused', async () => {
  reset({ out: { ok: false, kind: 'login', error: 'login required' } });
  const store = setup({ chat: { model: 'vision-model', cap: { vision: true } }, vision: 'same' });
  await assert.rejects(video.watchVideo({ userId: 'u1', store, url: 'https://www.instagram.com/reel/abc/' }), (e) => e.userFacing && /sign in to it once in the browser on ClosedHand's sandbox computer/.test(e.message));
  await assert.rejects(video.watchVideo({ userId: 'u1', store, url: 'http://192.168.1.10/clip.mp4' }), (e) => e.userFacing);
});

test('the parts are deleted even when the model fails', async () => {
  reset(downloaded());
  const store = setup({ chat: { model: 'vision-model', cap: { vision: true } }, vision: 'same' });
  const wireStub = require.cache[require.resolve(lib('model-wire.js'))].exports;
  const real = wireStub.request;
  wireStub.request = async () => { throw new Error('provider down'); };
  try { await assert.rejects(video.watchVideo({ userId: 'u1', store, url: 'https://vimeo.com/1' })); }
  finally { wireStub.request = real; }
  assert.equal(calls.exec.at(-1), 'cleanup');
});

test('the tool is offered, guarded like the web reader, and kept away from Pulse', () => {
  const def = require('../lib/tools/definitions').INTERNAL_TOOLS.find((t) => t.name === 'watch_video');
  assert.ok(def && def.core);
  assert.match(read('lib/tools/handlers.js'), /case "watch_video":/);
  assert.match(read('lib/outbound-guard.js'), /toolName === "web_fetch" \|\| toolName === "watch_video"/);
  assert.match(read('lib/engine.js'), /RESEARCH_TOOLS = \/\^\(web_search\|web_fetch\|watch_video\|sandbox_browse\)\$\//);
  assert.equal(require('../lib/read-only-tools').READ_ONLY_TOOLS.has('watch_video'), false, 'Pulse never fetches a link');
  assert.equal(video.isVideoPage('https://www.instagram.com/reel/abc/'), true);
  assert.equal(video.isVideoPage('https://www.instagram.com/someone/'), false);
});

test('the sandbox script parses captions, spaces frames and never keeps the download', { skip: !hasPython() }, () => {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location("vs", ${JSON.stringify(lib('video-sandbox.py'))}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
  "vtt": m.parse_vtt("WEBVTT\\n\\n00:00:01.000 --> 00:00:03.000\\nHello <c>there</c>\\n\\n00:00:03.000 --> 00:00:04.000\\nHello there\\n\\n01:01:05.000 --> 01:01:06.000\\nBye"),
  "json3": m.parse_json3(json.dumps({"events": [{"tStartMs": 1500, "segs": [{"utf8": "a "}, {"utf8": "b"}]}, {"tStartMs": 2000, "segs": [{"utf8": "\\n"}]}]})),
  "times": m.frame_times(10, 24), "long": len(m.frame_times(3600, 24)),
  "login": m.problem("rate-limit reached or login required"), "blocked": m.problem("Your IP address is blocked from accessing this post")}))`]).toString();
  const r = JSON.parse(out);
  assert.deepEqual(r.vtt, [{ start: 1, text: 'Hello there' }, { start: 3665, text: 'Bye' }]);
  assert.deepEqual(r.json3, [{ start: 1.5, text: 'a b' }]);
  assert.deepEqual(r.times, [1, 3, 5, 7, 9]);
  assert.equal(r.long, 24);
  assert.equal(r.login, 'login'); assert.equal(r.blocked, 'blocked');
  const script = read('lib/video-sandbox.py');
  assert.match(script, /    finally:\n        shutil.rmtree\(tmp, ignore_errors=True\)/, 'the downloaded video is deleted whatever happens');
});

function hasPython() { try { execFileSync('python3', ['--version']); return true; } catch { return false; } }

test('the sandbox images and the Mac Workspace install the same video tools', () => {
  assert.match(read('sandbox-image/Dockerfile'), /yt-dlp av\n/);
  assert.match(read('sandbox-image/agent/server.js'), /"yt-dlp", "av"\]/);
});

test('watching counts as progress at each stage, so a long video keeps a background task alive', async () => {
  reset(downloaded({ parts: { speech: ['speech-0.pcm'] }, meta: { speech_parts: ['speech-0.pcm'], speech_seconds: 3 } }));
  progress.length = 0;
  const store = setup({ chat: { model: 'vision-model', cap: { vision: true } }, vision: 'same' });
  await video.watchVideo({ userId: 'u1', store, url: 'https://vimeo.com/1' });
  assert.ok(progress.length >= 3, 'after fetching, before writing out speech and before the model watches');
  assert.match(fs.readFileSync(lib('video.js'), 'utf8'), /effort: "fast"/, 'quick effort, so long reasoning cannot crowd out the account');
});
