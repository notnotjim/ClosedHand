// lib/embed-backfill.js: every row of the index has a vector.
//
// Any row without one gets it, in small pieces behind anything a person is
// waiting on: Pinned facts and Context Notes first, then mail and calendar
// newest first, then File Search. The text is what was embedded the first
// time: a note's own words, and for mail and calendar the stored summary with
// the item rebuilt from the cache, so nothing is summarised again. It runs
// every ten minutes and catches a row left without a vector for any reason
// (an embed that failed, a file chunk saved while the model was loading, an
// index cleared for a new model). Until then the row is found by its words.
const { supabase } = require("../user-store");

const PIECE = 16;
const EVERY_MS = 10 * 60000;
// Saved in place of a File Search chunk's words under zero residency.
const NO_TEXT = "[Zero residency - text not stored]";

// What to embed for each row, as it was the first time.
async function textsFor(rows) {
  const usi = require("./services/usi");
  const limit = usi.maxTextLen();
  const cached = new Map();
  const fromCache = rows.filter((r) => (r.service === "email" || r.service === "calendar") && r.source_metadata && r.source_metadata._source_table === "data_cache");
  for (const userId of [...new Set(fromCache.map((r) => r.user_id))]) {
    const ids = fromCache.filter((r) => r.user_id === userId).map((r) => r.external_id);
    const { data } = await supabase.from("data_cache").select("external_id, type, data").eq("user_id", userId).in("external_id", ids);
    for (const c of data || []) cached.set(`${userId}:${c.external_id}`, c);
  }
  return rows.map((r) => {
    const c = cached.get(`${r.user_id}:${r.external_id}`);
    if (!c) return String(r.content || "");
    const item = (c.type === "event" ? usi._eventRowToIndexItem : usi._emailRowToIndexItem)({ ...c, external_id: r.external_id });
    const raw = String(item.text || "").substring(0, limit);
    return r.enrichment_level === "full" && r.content ? `${r.content}\n\n${raw}` : raw || String(r.content || "");
  });
}

const PASSES = [
  { table: "data_vectors", select: "id, user_id, service, external_id, content, enrichment_level, source_metadata", where: (q) => q.eq("service", "memory") },
  { table: "data_vectors", select: "id, user_id, service, external_id, content, enrichment_level, source_metadata", where: (q) => q.neq("service", "memory").order("updated_at", { ascending: false }) },
  // A picture's or a sound's chunk is only ever stored with its vector
  // (rag-processor's mediaRows): its words are a label, not what it is.
  { table: "rag_chunks", select: "id, user_id, content, metadata", where: (q) => q.neq("content", NO_TEXT).order("created_at", { ascending: false }) },
];

// One run over everything without a vector. Returns how many got one.
const _skip = new Set(); // rows with nothing to embed, not retried this run of the bot
async function backfillOnce(deps = {}) {
  const usi = deps.usi || require("./services/usi");
  if (!usi.isLocalEmbed()) return 0; // a hosted embedder's index is not filled from here
  let done = 0;
  for (const pass of PASSES) {
    for (;;) {
      const { data: rows, error } = await pass.where(supabase.from(pass.table).select(pass.select).is("embedding", null)).limit(PIECE + _skip.size);
      if (error) { console.log(`[embed-backfill] ${pass.table}: ${error.message}`); break; }
      const todo = (rows || []).filter((r) => !_skip.has(r.id)).slice(0, PIECE);
      if (!todo.length) break;
      const texts = await textsFor(todo);
      const keep = todo.filter((r, i) => (texts[i].trim() && !r.metadata?.modality) || (_skip.add(r.id), false));
      if (!keep.length) continue;
      const vectors = await usi.embedBatch(keep.map((r) => texts[todo.indexOf(r)]));
      if (vectors.length !== keep.length) { console.log("[embed-backfill] the embedder is not answering; trying again later"); return done; }
      for (let i = 0; i < keep.length; i++) {
        const { error: e } = await supabase.from(pass.table).update({ embedding: JSON.stringify(vectors[i]) }).eq("id", keep[i].id);
        if (!e) done++;
      }
    }
  }
  if (done) console.log(`[embed-backfill] ${done} rows embedded`);
  return done;
}

let _timer = null, _running = false;
function start() {
  if (_timer) return;
  const run = async () => {
    if (_running) return;
    _running = true;
    try {
      await backfillOnce();
    } catch (e) {
      console.log(`[embed-backfill] ${e.message}`);
    } finally { _running = false; }
  };
  setTimeout(run, 20000).unref?.();
  _timer = setInterval(run, EVERY_MS);
  _timer.unref?.();
}

module.exports = { start, backfillOnce, textsFor, NO_TEXT };
