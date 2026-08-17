#!/usr/bin/env node
// scripts/check-embedder-output.js — verify the local embedder returns usable
// numbers, not just quickly.
//
// fp16 on the CPU execution provider loads cleanly, runs twice as fast as q8,
// uses half the memory, and returns NaN for every component of every vector.
// It was benchmarked before it was validated and very nearly shipped on the
// strength of those numbers. Speed measured without checking the output is not
// a measurement of anything.
//
// Not part of CI: it needs the model on disk and takes a minute. Run it on an
// install whenever LOCAL_EMBED_DTYPE changes, or before trusting any benchmark
// of a new precision or runtime.
//
//   docker exec -w /app closedhand-bot node scripts/check-embedder-output.js

const TEXTS = [
  "title: none | text: the filing deadline is 31 January and we need your statements",
  "task: search result | query: what did the accountant say about the deadline",
];

(async () => {
  const { localEmbed } = require("../lib/local-models");
  const dtype = (process.env.LOCAL_EMBED_DTYPE || "").trim() || "(default)";
  console.log(`dtype under test: ${dtype}`);

  let vectors;
  try {
    vectors = await localEmbed(TEXTS, { dims: 1536 });
  } catch (e) {
    console.error(`FAIL: embedder threw: ${e.message}`);
    process.exit(1);
  }

  let failed = false;
  vectors.forEach((v, i) => {
    const nan = v.filter(Number.isNaN).length;
    const nonFinite = v.filter(x => !Number.isFinite(x)).length;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    // Matryoshka zero-padding to 1536 means the tail is legitimately zero; the
    // model's own dimensions must not be.
    const populated = v.filter(x => x !== 0).length;

    const problems = [];
    if (nan) problems.push(`${nan} NaN`);
    if (nonFinite - nan) problems.push(`${nonFinite - nan} infinite`);
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.01) problems.push(`norm ${norm.toFixed(4)}, expected 1`);
    if (populated < 64) problems.push(`only ${populated} non-zero components`);

    console.log(`  vector ${i}: dims ${v.length}, populated ${populated}, norm ${Number.isFinite(norm) ? norm.toFixed(4) : "NaN"}` +
                (problems.length ? `  <-- ${problems.join(", ")}` : "  ok"));
    if (problems.length) failed = true;
  });

  // Two different sentences must not produce the same vector, which is what a
  // silently broken pooling or a constant output looks like.
  if (!failed && vectors.length > 1) {
    const [a, b] = vectors;
    const dot = a.reduce((s, x, i) => s + x * b[i], 0);
    console.log(`  cosine between two different texts: ${dot.toFixed(4)}`);
    if (dot > 0.999) {
      console.error("FAIL: different texts produced effectively the same vector");
      failed = true;
    }
  }

  if (failed) {
    console.error("\nThis embedder is not usable. Do not benchmark it, do not ship it.");
    process.exit(1);
  }
  console.log("\nOK: embedder returns finite, unit-length, distinct vectors.");
})();
