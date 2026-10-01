// webapp/fact-vectors.js (vendored from lib/services/fact-vectors.js) — keeping a pinned fact and its Context Brain
// entry in step.
//
// A fact lives in two stores. The `facts` row is what the bot reads into its
// prompt on every turn and what get_facts returns. A matching `data_vectors`
// row (service "memory", external_id "fact_<key>") is what the dashboard's
// Context Brain lists and what passive recall searches. Write one without the
// other and the two disagree: a fact the assistant knows but cannot show, or
// worse, one it still recalls after the user deleted it.
//
// Three callers write facts (the pin_fact tool, the dashboard, the onboarding
// mailbox scan) and they live in two services that cannot import each other,
// so this is vendored into webapp/fact-vectors.js and held byte-identical by
// scripts/check-vendored-identical.js. Dependencies are injected rather than
// required, which is what lets the two copies be identical: the bot embeds
// through services/usi and the webapp through rag-processor, and both talk to
// their own supabase client.

// Keys the assistant treats as plumbing rather than memory. Pulse state, sync
// markers and flight rows are machine state that happens to live in the same
// table; embedding them puts pulse logs into the user's Context Brain where
// they read as things ClosedHand "knows about" them.
function isInternalFactKey(k) {
  const key = String(k || "");
  return key.startsWith("_") || key.startsWith("flight-") || /^pulse[-_ ]/i.test(key) || key === "pulse" || key === "Pulse";
}

/**
 * @param {object} deps
 * @param {object} deps.supabase  a client for the database holding data_vectors
 * @param {(text: string) => Promise<number[]|null>} deps.embed  single-text embedder
 */
function factVectors({ supabase, embed }) {
  /**
   * Write (or rewrite) the vector for one fact. Returns false when the key is
   * plumbing and was deliberately not mirrored. Throws when the mirror was
   * wanted and did not happen, so callers can decide whether that is fatal.
   */
  async function mirrorFact(userId, key, value) {
    if (isInternalFactKey(key)) return false;
    const content = `${key}: ${value}`;
    const embedding = await embed(content);
    // No embedding, no upsert. Writing new text against an old vector leaves a
    // row that reads correctly in Context Brain and is retrieved by the wrong
    // queries, which is worse than an honest failure.
    if (!embedding) throw new Error("embedder unavailable");
    const { error } = await supabase.from("data_vectors").upsert({
      user_id: userId,
      service: "memory",
      item_type: "fact",
      external_id: `fact_${key}`,
      content,
      embedding: JSON.stringify(embedding),
      enrichment_level: "full",
      source_metadata: { key },
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service,external_id" });
    if (error) throw new Error(error.message);
    return true;
  }

  /**
   * Mirror many facts, one at a time. Sequential on purpose: the only caller
   * that passes a batch is a background scan, and a burst of embed calls
   * competes with the indexing the same scan just kicked off.
   *
   * Never throws. A fact whose vector fails is still saved in `facts`, so the
   * assistant knows it either way; the report says which ones recall cannot
   * reach yet.
   */
  async function mirrorFacts(userId, entries) {
    const result = { mirrored: 0, skipped: 0, failed: [] };
    for (const [key, value] of entries) {
      try {
        const done = await mirrorFact(userId, key, value);
        if (done) result.mirrored++; else result.skipped++;
      } catch (e) {
        result.failed.push({ key, reason: e.message });
      }
    }
    return result;
  }

  async function removeFactVector(userId, key) {
    const { error } = await supabase.from("data_vectors").delete()
      .eq("user_id", userId)
      .eq("service", "memory")
      .eq("external_id", `fact_${key}`);
    if (error) throw new Error(error.message);
  }

  return { mirrorFact, mirrorFacts, removeFactVector };
}

module.exports = { factVectors, isInternalFactKey };
