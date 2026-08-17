// scripts/bench-local-models.js — measure the local fallback models on THIS
// machine, so README claims are numbers, not vibes. Downloads on first run
// (same path production takes), then times embedding throughput and rerank
// latency. Run: node scripts/bench-local-models.js [nTexts]
//
// No DB required: status writes fail silently and the models still load.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("path").join(__dirname, "..", "data");

const N = parseInt(process.argv[2], 10) || 200;

function makeTexts(n) {
  const bits = [
    "Invoice for August: hosting renewal is due on the 28th, total 42.50, pay via the usual account.",
    "Flight confirmation LH717 departing Tokyo Haneda 09:40, arriving Frankfurt 15:20, seat 34K, booking ref K9X2LP.",
    "Dentist moved the checkup to Thursday 14:00; bring the insurance card and arrive ten minutes early.",
    "Quarterly report draft attached; the revenue table on page 4 still needs the September numbers before Friday.",
    "Reminder: the gym membership auto-renews next week. Cancel two days before if you don't want the annual plan.",
  ];
  return Array.from({ length: n }, (_, i) => `${bits[i % bits.length]} (variant ${i})`);
}

(async () => {
  const { localEmbed, localRerankScores } = require("../lib/local-models");

  console.log("=== Local embedder (EmbeddingGemma-300M q8) ===");
  let t0 = Date.now();
  await localEmbed(["warm-up"], { query: true });
  console.log(`load+first-embed: ${((Date.now() - t0) / 1000).toFixed(1)}s (includes download on first run)`);

  const texts = makeTexts(N);
  t0 = Date.now();
  const BATCH = 16;
  let vecs = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    vecs = vecs.concat(await localEmbed(texts.slice(i, i + BATCH)));
  }
  const embedSecs = (Date.now() - t0) / 1000;
  console.log(`${N} docs embedded in ${embedSecs.toFixed(1)}s = ${(N / embedSecs).toFixed(1)} texts/s`);
  console.log(`dims: ${vecs[0].length} (zero-padded), norm: ${Math.sqrt(vecs[0].reduce((s, v) => s + v * v, 0)).toFixed(4)}`);

  // Sanity: a query should rank its own subject above unrelated docs.
  const q = await localEmbed(["when is the dentist appointment"], { query: true });
  const cos = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const sims = vecs.slice(0, 5).map((v, i) => ({ i, sim: cos(q[0], v) })).sort((a, b) => b.sim - a.sim);
  console.log(`retrieval sanity (top for dentist query should be doc 2): doc ${sims[0].i} (sim ${sims[0].sim.toFixed(3)})`);

  console.log("\n=== Local reranker (jina-reranker-v1-turbo-en q8) ===");
  t0 = Date.now();
  await localRerankScores("warm-up", ["warm-up"]);
  console.log(`load+first-score: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const docs20 = makeTexts(20).map((t) => t.substring(0, 512));
  t0 = Date.now();
  const scores = await localRerankScores("when is the dentist appointment", docs20);
  const rerankMs = Date.now() - t0;
  const best = scores.indexOf(Math.max(...scores));
  console.log(`rerank 20 docs: ${rerankMs}ms (${(rerankMs / 20).toFixed(0)}ms/pair); top doc index ${best} (dentist variants are 2,7,12,17)`);

  console.log("\nRSS after both models:", Math.round(process.memoryUsage().rss / 1048576), "MB");
  process.exit(0);
})().catch((e) => { console.error("BENCH FAIL:", e.message); process.exit(1); });
