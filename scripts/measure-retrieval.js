#!/usr/bin/env node
// scripts/measure-retrieval.js — measure the real retrieval loop, end to end,
// against whatever database and models the environment points at.
//
// This exercises the shipped code (usi.search then reranker.rerank), not a
// reimplementation, so the numbers describe what users actually get. It is a
// script rather than something run from a developer machine because the only
// way to reach a hosted embedder is with the deployment's own key, and a
// production key should not have to travel to measure a query.
//
// Run it where the environment already exists:
//
//   railway run node scripts/measure-retrieval.js            (hosted)
//   docker exec closedhand-bot node scripts/measure-retrieval.js   (self-host)
//
// Optionally pass queries:  ... measure-retrieval.js "invoice 8837" "the deadline"

const DEFAULT_QUERIES = [
  "find the email with the invoice number",
  "what did the accountant say about the deadline",
  "flight booking confirmation",
];

function ms(t) { return ((Date.now() - t)).toFixed(0).padStart(5) + "ms"; }

(async () => {
  const { supabase } = require("../user-store");
  const usi = require("../lib/services/usi");
  const { rerank, rerankMode } = require("../lib/services/reranker");

  // Whose data: the account with rows, not merely the first profile. Picking
  // the wrong user is how an earlier run of this measurement reported zero
  // hits and looked like a broken feature.
  const { data: owners, error: ownerErr } = await supabase
    .from("data_cache").select("user_id").limit(1000);
  if (ownerErr) { console.error("could not read data_cache:", ownerErr.message); process.exit(1); }
  const counts = {};
  for (const r of owners || []) counts[r.user_id] = (counts[r.user_id] || 0) + 1;
  const userId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  if (!userId) { console.error("data_cache is empty; nothing to measure."); process.exit(1); }

  const { count: corpusRows } = await supabase
    .from("data_cache").select("id", { count: "exact", head: true }).eq("user_id", userId);
  const { count: vectorRows } = await supabase
    .from("data_vectors").select("id", { count: "exact", head: true }).eq("user_id", userId);

  console.log(`corpus      : ${corpusRows} cached rows, ${vectorRows} vectors`);
  console.log(`rerank mode : ${rerankMode()}`);
  console.log(`embed model : ${process.env.EMBED_MODEL || "(runtime config)"}`);
  console.log();

  const queries = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_QUERIES;
  for (const q of queries) {
    const t0 = Date.now();
    const r = await usi.search(userId, q, { threshold: 0.25, maxResults: 20 });
    const tSearch = Date.now();
    const fused = r.results || [];
    const ranked = await rerank(q, fused, 7);
    const tRank = Date.now();

    const arms = fused.reduce((a, x) => { a[x._arms] = (a[x._arms] || 0) + 1; return a; }, {});
    console.log("=".repeat(76));
    console.log(`QUERY: ${q}`);
    console.log(`  search ${ms(t0).trim()} | rerank ${(tRank - tSearch)}ms | total ${tRank - t0}ms`);
    console.log(`  fused ${fused.length} (${JSON.stringify(arms)}) -> final ${ranked.length}, unique ${new Set(ranked.map(x => x.id)).size}`);
    ranked.slice(0, 7).forEach((x, i) => {
      // Subjects are the user's own mail: print a short label, never the body.
      const label = (x.metadata?.subject || x.metadata?.summary || x.service || "?").toString().slice(0, 46);
      console.log(`   ${i + 1}. [${String(x._arms).padEnd(7)} rrf=${(x._rrf || 0).toFixed(5)} rerank=${x._rerank_score !== undefined ? x._rerank_score.toFixed(3) : "n/a"}] ${label}`);
    });
    console.log();
  }
  process.exit(0);
})().catch(e => { console.error("measure failed:", e.message); process.exit(1); });
