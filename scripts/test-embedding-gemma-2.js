// EmbeddingGemma 2 as the local embedding model: its files fetched and
// checked, every row of the index given its vector, File Search embedding
// through the bot, and pictures and sounds found by what they are. Invented
// rows and stand-in services only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Modules swapped for stand-ins while `fn` loads `target` fresh.
function withModules(stubs, target) {
  const saved = {};
  for (const [rel, exports] of Object.entries(stubs)) {
    const p = require.resolve(rel);
    saved[p] = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  const t = require.resolve(target);
  delete require.cache[t];
  const mod = require(target);
  return { mod, restore() { for (const [p, m] of Object.entries(saved)) { if (m) require.cache[p] = m; else delete require.cache[p]; } delete require.cache[t]; } };
}

// A database table in memory, enough of the query builder for these callers.
function fakeDb(tables) {
  return {
    from(name) {
      const rows = tables[name] || (tables[name] = []);
      const filters = [];
      let order = null, lim = Infinity, patch = null;
      const q = {
        select() { return q; },
        update(p) { patch = p; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        neq(k, v) { filters.push((r) => r[k] !== v); return q; },
        is(k, v) { filters.push((r) => (r[k] ?? null) === v); return q; },
        not(k, op, v) { filters.push((r) => (r[k] ?? null) !== v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        order(k, { ascending } = {}) { order = [k, ascending]; return q; },
        limit(n) { lim = n; return q; },
        then(resolve, reject) {
          try {
            let hit = rows.filter((r) => filters.every((f) => f(r)));
            if (patch) { for (const r of hit) Object.assign(r, patch); return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
            if (order) hit = [...hit].sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : 1) * (order[1] ? 1 : -1));
            return Promise.resolve({ data: hit.slice(0, lim).map((r) => ({ ...r })), error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        },
      };
      return q;
    },
  };
}

test('model files are fetched from the pinned revision, kept only when the checksum matches, and fetched once', async () => {
  const { ensureFiles, missing } = require('../lib/model-files');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-files-'));
  const good = Buffer.from('tokenizer for an invented model');
  const model = { repo: 'example/tiny-model', revision: 'abc123' };
  const set = [{ path: 'tokenizer.json', size: good.length, sha256: sha(good) }, { path: 'onnx/model.onnx', size: 5, sha256: sha(Buffer.from('wrong')) }];
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); const body = url.endsWith('tokenizer.json') ? good : Buffer.from('other'); return { ok: true, status: 200, body: [body] }; };
  await assert.rejects(ensureFiles(dir, model, set, () => {}, fetchImpl), /did not match its checksum/);
  assert.equal(fs.readFileSync(path.join(dir, model.repo, 'tokenizer.json'), 'utf8'), good.toString(), 'the good file is kept');
  assert.equal(fs.existsSync(path.join(dir, model.repo, 'onnx/model.onnx')), false, 'the bad one is not');
  assert.equal(fs.existsSync(path.join(dir, model.repo, 'onnx/model.onnx.part')), false, 'nor half of it');
  assert.equal(urls[0], 'https://huggingface.co/example/tiny-model/resolve/abc123/tokenizer.json');
  assert.deepEqual(missing(dir, model, set).map((f) => f.path), ['onnx/model.onnx']);
  urls.length = 0;
  const progress = [];
  assert.deepEqual(await ensureFiles(dir, model, set.slice(0, 1), (p) => progress.push(p), fetchImpl), { downloaded: 0 });
  assert.equal(urls.length, 0, 'a file already there is not fetched again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EmbeddingGemma 2 is the local model unless another is set by hand', () => {
  const conf = {};
  const { mod: lm, restore } = withModules({ '../lib/config': { getConfCached: (k) => conf[k], getConf: async (k) => conf[k] } }, '../lib/local-models');
  const saved = { e: process.env.EMBED_MODEL, o: process.env.LOCAL_EMBED_MODEL_ID };
  delete process.env.EMBED_MODEL; delete process.env.LOCAL_EMBED_MODEL_ID;
  try {
    const spec = lm.embedderSpec();
    assert.equal(spec.runner, 'eg2');
    assert.equal(spec.repo, 'onnx-community/embeddinggemma-2-ONNX');
    assert.match(spec.revision, /^[0-9a-f]{40}$/, 'a pinned revision, never a branch');
    const mb = spec.files.text.reduce((n, f) => n + f.size, 0) / 1048576;
    assert.ok(mb > 300 && mb < 360, `the text part alone is fetched at first (${Math.round(mb)} MB)`);
    for (const set of Object.values(spec.files)) for (const f of set) assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
    conf.LOCAL_EMBED_MODEL_ID = 'example/own-model';
    assert.deepEqual(lm.embedderSpec(), { runner: 'pipeline', repo: 'example/own-model' });
  } finally {
    if (saved.e !== undefined) process.env.EMBED_MODEL = saved.e;
    if (saved.o !== undefined) process.env.LOCAL_EMBED_MODEL_ID = saved.o;
    restore();
  }
});

test('every row without a vector gets one: Pinned facts and Context Notes first, mail with its stored summary', async () => {
  const tables = {
    data_vectors: [
      { id: 'e1', user_id: 'u1', service: 'email', external_id: 'm-77', content: 'Boiler service booked for Friday', enrichment_level: 'full', source_metadata: { _source_table: 'data_cache' }, updated_at: '2026-10-02', embedding: null },
      { id: 'c1', user_id: 'u1', service: 'calendar', external_id: 'ev-3', content: 'Dentist on Tuesday', enrichment_level: 'raw', source_metadata: {}, updated_at: '2026-10-09', embedding: null },
      { id: 'f1', user_id: 'u1', service: 'memory', content: 'Priya is Tomas\'s sister', updated_at: '2026-01-01', embedding: null },
      { id: 'f2', user_id: 'u1', service: 'memory', content: 'Already embedded', embedding: '[1]' },
      { id: 'f3', user_id: 'u1', service: 'memory', content: '', embedding: null },
    ],
    rag_chunks: [
      { id: 'r1', user_id: 'u1', content: 'Tenancy runs to March', metadata: {}, created_at: '2026-10-01', embedding: null },
      { id: 'r2', user_id: 'u1', content: '[Zero residency - text not stored]', metadata: {}, created_at: '2026-10-01', embedding: null },
      { id: 'r3', user_id: 'u1', content: 'IMG_0412.jpg (picture)', metadata: { modality: 'image' }, created_at: '2026-10-01', embedding: null },
    ],
    data_cache: [{ user_id: 'u1', external_id: 'm-77', type: 'email', data: {} }],
  };
  const embedded = [];
  const usi = {
    isLocalEmbed: () => true,
    maxTextLen: () => 2000,
    _emailRowToIndexItem: () => ({ text: 'From: Ana Ruiz\nThe engineer comes Friday at 9.' }),
    _eventRowToIndexItem: () => ({ text: '' }),
    embedBatch: async (texts) => { embedded.push(...texts); return texts.map((t) => [t.length]); },
  };
  const { mod, restore } = withModules({ '../user-store': { supabase: fakeDb(tables) }, '../lib/services/usi': usi }, '../lib/embed-backfill');
  try {
    assert.equal(await mod.backfillOnce(), 4);
    assert.deepEqual(embedded, [
      'Priya is Tomas\'s sister',
      'Dentist on Tuesday',
      'Boiler service booked for Friday\n\nFrom: Ana Ruiz\nThe engineer comes Friday at 9.',
      'Tenancy runs to March',
    ]);
    assert.equal(tables.data_vectors.find((r) => r.id === 'f1').embedding, JSON.stringify([23]));
    assert.equal(tables.rag_chunks.find((r) => r.id === 'r2').embedding, null, 'a chunk whose words were not kept is left');
    assert.equal(tables.rag_chunks.find((r) => r.id === 'r3').embedding, null, 'a picture is never embedded by its label');
    assert.equal(await mod.backfillOnce(), 0);
  } finally { restore(); }
});

function res() { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; }

test('File Search embeds through the bot, and only with a token', async () => {
  let handler, local = true, runner = 'eg2';
  const seen = [];
  require('../lib/embed-route').register({ post: (route, body, fn) => { if (route === '/internal/embed') handler = fn; } }, {
    verifyToken: (t) => (t === 'good' ? 'file-search' : null), body: () => {},
    usi: { isLocalEmbed: () => local, embedBatch: async (texts, opts) => { seen.push(opts); return texts.map(() => [0.5]); } },
    localModels: { embedderSpec: () => ({ runner }), localEmbedMedia: async (kind, data) => { seen.push({ kind, bytes: data.length }); return [0.25]; } },
  });
  const call = async (token, body) => { const r = res(); await handler({ get: () => token, body }, r); return r; };
  assert.equal((await call('forged', { texts: ['x'] })).code, 401);
  const ok = await call('good', { texts: ['the tenancy', 'the boiler'], query: true });
  assert.deepEqual(ok.body, { vectors: [[0.5], [0.5]] });
  assert.deepEqual(seen.shift(), { quick: true }, 'a search is framed as one, and usi puts it ahead of background work');
  await call('good', { texts: ['a chunk of a file'] });
  assert.deepEqual(seen.shift(), { quick: false }, 'a file\'s chunks wait their turn');
  const pic = await call('good', { images: [Buffer.from('jpeg bytes').toString('base64')] });
  assert.deepEqual(pic.body, { vectors: [[0.25]] });
  assert.deepEqual(seen.shift(), { kind: 'image', bytes: 10 });
  runner = 'pipeline';
  assert.equal((await call('good', { images: ['eA=='] })).code, 409, 'only EmbeddingGemma 2 sees pictures');
  local = false;
  assert.equal((await call('good', { texts: ['x'] })).code, 409, 'a hosted embedder is not answered from here');
});

test('a picture or a sound matched by what it is stays in File Search results, under the line it is dropped', async () => {
  const { docSearch } = require('../lib/services/doc-search');
  const db = fakeDb({ rag_documents: [
    { id: 'd1', user_id: 'u1', status: 'ready', name: 'IMG_2041.jpg' },
    { id: 'd2', user_id: 'u1', status: 'ready', name: 'IMG_2042.jpg' },
    { id: 'd3', user_id: 'u1', status: 'ready', name: 'Zoo trip notes.pdf' },
  ] });
  db.rpc = async (name) => name === 'match_rag_chunks' ? { data: [
    { id: 'k1', document_id: 'd1', chunk_index: 0, content: 'IMG_2041.jpg (picture)', metadata: { modality: 'image' }, similarity: 0.74 },
    { id: 'k3', document_id: 'd3', chunk_index: 0, content: 'Feeding time for the zebras is at noon.', metadata: {}, similarity: 0.52 },
    { id: 'k2', document_id: 'd2', chunk_index: 0, content: 'IMG_2042.jpg (picture)', metadata: { modality: 'image' }, similarity: 0.62 },
  ], error: null } : { data: [], error: null };
  const rerank = async (q, docs) => docs.map((d) => ({ ...d, _rerank_score: /picture/.test(d.content) ? 0.0001 : 0.3 }));
  const { results, no_strong_matches } = await docSearch({ supabase: db, embed: async () => [1], rerank }).searchDocuments('u1', 'a zebra');
  assert.deepEqual(results.map((r) => r.document_name), ['Zoo trip notes.pdf', 'IMG_2041.jpg']);
  assert.equal(results[1].low_confidence, false, 'the reranker cannot see the picture, so its low score does not count');
  assert.equal(results[1].metadata.modality, 'image');
  assert.equal('_media' in results[1], false);
  assert.equal(no_strong_matches, false);
});

test('with EmbeddingGemma 2 a video file comes back with its frames and its sound embedded, quiet stretches skipped', async () => {
  const pcm = Buffer.alloc(65 * 16000 * 2);
  for (let i = 0; i < 65 * 16000; i++) if (i < 30 * 16000 || i >= 60 * 16000) pcm.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
  const meta = { title: 'Harbour walk.mp4', duration: 65, frames: [{ time: 5, offset: 0, size: 3 }, { time: 50, offset: 0, size: 3 }], speech_parts: ['speech-0.pcm'], speech_seconds: 65 };
  const files = { 'meta.json': Buffer.from(JSON.stringify(meta)), 'frames.bin': Buffer.from([0xff, 0xd8, 0xff]), 'speech-0.pcm': pcm };
  let job;
  const sandbox = {
    ensureSandbox: async () => {},
    sandboxRequest: async (userId, method, route, body) => {
      if (route === '/files/write') { job = /in-([0-9a-f]+)\//.exec(body.path)[1]; return { success: true }; }
      if (route === '/exec' && /Popen/.test(body.code)) return { stdout: 'started\n' };
      if (route === '/files/read') return { content: 'CLOSEDHAND_VIDEO ' + JSON.stringify({ ok: true, dir: `.closedhand-video/${job}`, parts: { meta: 'meta.json', frames: 'frames.bin', speech: ['speech-0.pcm'] } }) };
      return { stdout: '' };
    },
    sandboxFileDownload: async (userId, p) => ({ content: files[p.split('/').pop()].toString('base64') }),
  };
  const embeddedMedia = [];
  const listen = {
    transcribe: async () => ({ language: 'en', lines: [{ start: 2, text: 'Here is the harbour.' }] }),
    pcm16ToFloat: (b) => { const out = new Float32Array(b.length / 2); for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2) / 32768; return out; },
  };
  const { mod: video, restore } = withModules({
    '../lib/sandbox': sandbox, '../lib/services/listen': listen,
    '../lib/services/usi': { isLocalEmbed: () => true },
    '../lib/local-models': { embedderSpec: () => ({ runner: 'eg2' }), localEmbedMedia: async (kind, data) => { embeddedMedia.push([kind, data.length]); return [kind === 'image' ? 0.1 : 0.2]; } },
  }, '../lib/video');
  try {
    const heard = await video.hearMedia({ userId: 'u1', buffer: Buffer.from('not really a video'), name: 'Harbour walk.mp4', video: true, frames: 2, vectors: true });
    assert.deepEqual(heard.frames.map((f) => f.vector), [[0.1], [0.1]]);
    assert.deepEqual(heard.sound.map((s) => [s.start, s.end, s.vector]), [[0, 30, [0.2]], [60, 65, [0.2]]], 'thirty-second stretches, the quiet one skipped');
    assert.deepEqual(embeddedMedia.filter(([k]) => k === 'audio').map(([, n]) => n), [30 * 16000, 5 * 16000]);
    const plain = await video.hearMedia({ userId: 'u1', buffer: Buffer.from('not really a video'), name: 'Harbour walk.mp4', video: true, frames: 2 });
    assert.deepEqual(plain.sound, [], 'nothing is embedded unless asked');
  } finally { restore(); }
});

test('File Search uses the local model through the bot and keeps pictures and sounds as their own chunks', () => {
  const rag = read('webapp/rag-processor.js');
  assert.match(rag, /if \(await localEmbedder\(\)\) \{[\s\S]{0,400}fetch\(`\$\{BOT_INTERNAL_URL\}\/internal\/embed`/);
  assert.match(rag, /async function embedSingle\(text\) \{\n\s*if \(!text\) return null;\n\s*const results = await embedBatch\(\[text\], \{ query: true \}\);/);
  assert.match(rag, /allEmbeddings\.push\(\.\.\.\(embeddings\.length === batch\.length \? embeddings : batch\.map\(\(\) => undefined\)\)\)/, 'chunks and vectors stay in step');
  assert.match(rag, /if \(!vector\) continue;/, 'a picture or sound chunk is stored only with its vector');
  assert.match(rag, /chunk_count: rows\.length,/);
  assert.match(read('index.js'), /require\("\.\/lib\/embed-route"\)\.register\(ctx\.expressApp\);/);
  assert.match(read('index.js'), /require\("\.\/lib\/embed-backfill"\)\.start\(\);/);
  assert.match(read('webapp/server.js'), /EMBED_MODEL: "local:embeddinggemma-2"/, 'new installs start on EmbeddingGemma 2');
});
