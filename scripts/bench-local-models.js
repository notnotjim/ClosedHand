#!/usr/bin/env node
// scripts/bench-local-models.js — report every dimension at once, always.
//
// This exists because of a repeated mistake, not because benchmarking is hard.
// Twice in one week a setting was changed having measured a single dimension:
//
//   enableCpuMemArena: false   measured memory (saved ~800MB), shipped.
//                              Nobody measured latency. It costs about 2x.
//   dtype: fp16                measured latency (2x faster) and memory (half),
//                              shipped-ready. Nobody measured OUTPUT. Every
//                              vector was NaN.
//
// Both look like good decisions if you see one column. Neither survives seeing
// four. So there is no "latency check" or "memory check" here: there is one
// command that prints correctness, latency, memory and event-loop availability
// together, and the rule is that a change to model precision, thread count,
// arena, runtime or worker layout pastes this output into its commit message.
//
// A CI check cannot do this. It needs the model on disk, a quiet machine, and a
// human to judge the trade. What it can do is remove the excuse for looking at
// one number, which is what the mistakes actually had in common.
//
//   docker exec -w /app closedhand-bot node scripts/bench-local-models.js
//
// Env overrides work as normal, so a candidate change can be measured without
// editing code: LOCAL_EMBED_DTYPE=fp32 LOCAL_ORT_THREADS=2 node scripts/...

const SINGLE = "title: none | text: the filing deadline is 31 January and we need your statements";
const OTHER = "title: none | text: weekly aviation news, new routes and reader photography";

function meter() {
  let ticks = 0;
  const h = setInterval(() => { ticks++; }, 5);
  const t0 = Date.now();
  return () => {
    clearInterval(h);
    const ms = Date.now() - t0;
    return { ms, pct: Math.min(100, Math.round((ticks / Math.max(1, Math.floor(ms / 5))) * 100)) };
  };
}
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

(async () => {
  const lm = require("../lib/local-models");
  const baseRss = rss();

  console.log(`dtype   : ${process.env.LOCAL_EMBED_DTYPE || "(default)"}`);
  console.log(`threads : ${process.env.LOCAL_ORT_THREADS || "(default)"}`);
  console.log(`cores   : ${require("os").cpus().length}`);
  console.log("");

  // 1. CORRECTNESS. First, and fatal, because everything below is meaningless
  //    if the numbers coming out are not numbers.
  const [a, b] = await lm.localEmbed([SINGLE, OTHER], { dims: 1536 });
  const nan = a.filter(Number.isNaN).length;
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const cosAB = a.reduce((s, x, i) => s + x * b[i], 0);
  const ok = !nan && Number.isFinite(norm) && Math.abs(norm - 1) < 0.01 && cosAB < 0.999;
  console.log(`CORRECTNESS  ${ok ? "ok" : "BROKEN"}  (NaN ${nan}, norm ${Number.isFinite(norm) ? norm.toFixed(4) : "NaN"}, cosine between two texts ${Number.isFinite(cosAB) ? cosAB.toFixed(4) : "NaN"})`);
  if (!ok) {
    console.error("\nOutput is not usable. Every number below would be the speed of producing garbage.");
    process.exit(1);
  }

  // 2. LATENCY, single (the hot path) and batched (indexing).
  const singles = [];
  for (let i = 0; i < 7; i++) {
    const t = Date.now();
    await lm.localEmbed([`${SINGLE} ${i}`], { dims: 1536 });
    singles.push(Date.now() - t);
  }
  const tB = Date.now();
  await lm.localEmbed(Array.from({ length: 8 }, (_, i) => `${SINGLE} batch ${i}`), { dims: 1536 });
  const batchMs = Date.now() - tB;
  console.log(`LATENCY      single median ${median(singles)}ms (min ${Math.min(...singles)}, max ${Math.max(...singles)}) | batch of 8 ${batchMs}ms = ${Math.round(batchMs / 8)}ms each`);

  // 3. MEMORY.
  console.log(`MEMORY       rss ${rss()}MB (baseline before models ${baseRss}MB, delta +${rss() - baseRss}MB)`);

  // 4. RESPONSIVENESS. What fraction of the time the process could have done
  //    anything else, like answer a message.
  const stop = meter();
  await lm.localEmbed(Array.from({ length: 12 }, (_, i) => `${SINGLE} loop ${i}`), { dims: 1536 });
  const loop = stop();
  console.log(`RESPONSIVE   event loop free ${loop.pct}% during a batch of 12 (${loop.ms}ms)`);

  // Reranker, same treatment.
  const docs = Array.from({ length: 20 }, (_, i) => `document ${i} discussing the filing deadline and bank statements`);
  const stopR = meter();
  const scores = await lm.localRerankScores("what did the accountant say about the deadline", docs);
  const r = stopR();
  const finite = scores.filter(Number.isFinite).length;
  console.log(`RERANKER     ${r.ms}ms for 20 docs | loop free ${r.pct}% | ${finite}/${scores.length} finite scores`);

  console.log("\nPaste this into the commit message of any change to precision, threads,");
  console.log("arena, runtime or worker layout. One column is how the last two mistakes happened.");
  process.exit(0);
})().catch((e) => { console.error("bench failed:", e.message); process.exit(1); });
