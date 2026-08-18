// lib/services/usi.js -- Universal Semantic Index
// Indexes all connected service data into pgvector for cross-service semantic search.
// Two phases: instant embedding (Phase 1), then LLM enrichment (Phase 2).
// Qwen models served per-token via DeepInfra (same models as the old self-hosted stack,
// so existing vectors stay compatible).

const { supabase } = require("../../user-store");
const { recordUsage } = require("../usage");

// Machinery endpoints resolve env → runtime config (the wizard's provider save)
// → the DeepInfra defaults. A complete provider (OpenAI, Gemini, Ollama with
// models pulled) points all of these at itself with one key; the key falls back
// to the DeepInfra key so plain DEEPINFRA_API_KEY installs behave as ever.
function _mconf(k) { return require("../config").getConfCached(k); }
function DEEPINFRA_API_KEY() { return process.env.DEEPINFRA_API_KEY || _mconf("DEEPINFRA_API_KEY"); }
function embedKey() { return process.env.EMBED_API_KEY || _mconf("EMBED_API_KEY") || DEEPINFRA_API_KEY(); }
function isLocalEmbed() { return String(EMBED_MODEL()).startsWith("local:"); }
// Embeddings are configured when a hosted key exists OR the local embedder is
// the chosen model (no key involved).
function hasEmbedConfig() { return isLocalEmbed() || !!embedKey(); }
function machineryKey() { return process.env.ENRICH_API_KEY || _mconf("ENRICH_API_KEY") || DEEPINFRA_API_KEY(); }
function EMBED_URL() { return process.env.EMBED_API_URL || _mconf("EMBED_API_URL") || "https://api.deepinfra.com/v1/openai/embeddings"; }
// Passive recall's live data_vectors were indexed with Qwen3-Embedding-4B. Query
// and index must use the SAME model or every cosine collapses to ~0 (different
// models live in incompatible vector spaces). Default matches the data so recall
// still works if the EMBED_MODEL env override is ever lost. Changing this model
// requires a full re-index of data_vectors, it is not a hot swap — which is why
// the wizard locks the first EMBED_MODEL it writes.
function EMBED_MODEL() { return process.env.EMBED_MODEL || _mconf("EMBED_MODEL") || "Qwen/Qwen3-Embedding-4B"; }
function ENRICH_URL() { return process.env.ENRICH_API_URL || _mconf("ENRICH_API_URL") || "https://api.deepinfra.com/v1/openai/chat/completions"; }
function ENRICH_MODEL() { return process.env.ENRICH_MODEL || _mconf("ENRICH_MODEL") || "deepseek-ai/DeepSeek-V4-Flash"; }
function ENRICH_FALLBACK_MODEL() { return process.env.ENRICH_FALLBACK_MODEL || _mconf("ENRICH_FALLBACK_MODEL") || "Qwen/Qwen3-30B-A3B"; }
function VISION_MODEL() { return process.env.VISION_MODEL || _mconf("VISION_MODEL") || "Qwen/Qwen3-VL-30B-A3B-Instruct"; }
const ENRICH_DAILY_CAP = parseInt(process.env.ENRICH_DAILY_CAP || "50000", 10); // global, all users
const ENRICH_USER_DAILY_CAP = parseInt(process.env.ENRICH_USER_DAILY_CAP || "5000", 10); // per user
const VISION_DAILY_CAP = parseInt(process.env.VISION_DAILY_CAP || "300", 10); // attachment images/day, global
const BATCH_SIZE = 32;
// A local embedder holds the whole batch in memory as tensors, and a self-host
// box is usually a few GB. Smaller batches also mean the pass writes rows every
// few seconds, so if the process dies mid-mailbox the work already done stays
// done instead of restarting from nothing.
const BATCH_SIZE_LOCAL = 8;
function batchSize() { return isLocalEmbed() ? BATCH_SIZE_LOCAL : BATCH_SIZE; }
const MAX_TEXT_LEN = 8000; // Per-text limit for embedding (hosted)
// A local CPU embedder's cost scales with tokens, and full-length bodies turned
// a pass into hours. Subject, sender and opening lines carry nearly all of the
// retrieval signal, so the local path reads far less and finishes.
const MAX_TEXT_LEN_LOCAL = 1200;
function maxTextLen() { return isLocalEmbed() ? MAX_TEXT_LEN_LOCAL : MAX_TEXT_LEN; }
const EMBED_DIMS = 1536; // Matryoshka truncation from native 4096 (fits pgvector index limit)
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
const SUPPORTED_ATTACHMENT_TYPES = new Set(["pdf", "docx", "doc", "txt", "csv", "xlsx", "xls", "pptx", "rtf", "md", "html", "htm", "jpg", "jpeg", "png", "gif", "webp"]);

// ============================================================================
// LOCAL EMBEDDING
// ============================================================================

// Latched on 402 so an empty balance doesn't produce a request/log storm (resets daily)
let _embedBillingDeadDay = "";

/**
 * Embed one or more texts via Qwen3-Embedding (DeepInfra). Returns array of vectors.
 * opts.quick: interactive mode — single attempt, 5s cap, no backoff. Used for
 * query embeds (search, passive recall) where a user is waiting and keyword
 * fallback exists. Background indexing keeps full retries: a failed batch
 * there wastes already-paid enrichment spend, while a failed query embed
 * just downgrades one search to keywords.
 */
async function embedBatch(texts, opts = {}) {
  if (!hasEmbedConfig() || texts.length === 0) return [];
  if (_embedBillingDeadDay === new Date().toISOString().slice(0, 10)) return [];
  // 429 engine_overloaded is common and transient: retry with backoff before giving up,
  // because a failed embed wastes the enrichment spend already made for the batch.
  // Local embedder: no HTTP, no billing, no retry ladder. Failures surface in
  // LOCAL_MODELS_STATUS (wizard/dashboard) and the next call retries the load.
  if (isLocalEmbed()) {
    try {
      const { localEmbed } = require("../local-models");
      return await localEmbed(texts.map(t => t.substring(0, maxTextLen())), { query: !!opts.quick, dims: EMBED_DIMS });
    } catch (e) {
      console.log(`[USI] Local embed failed: ${e.message}`);
      return [];
    }
  }
  const delays = opts.quick ? [0] : [0, 3000, 8000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const resp = await fetch(EMBED_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${embedKey()}` },
        signal: AbortSignal.timeout(opts.quick ? 5000 : 60000),
        body: JSON.stringify({
          model: EMBED_MODEL(),
          input: texts.map(t => t.substring(0, MAX_TEXT_LEN)),
          encoding_format: "float",
        }),
      });
      if (!resp.ok) {
        if (resp.status === 402) {
          console.log(`[USI] DeepInfra balance exhausted (402). Embedding disabled until tomorrow/top-up+restart.`);
          _embedBillingDeadDay = new Date().toISOString().slice(0, 10);
          return [];
        }
        const errText = await resp.text().catch(() => "");
        console.log(`[USI] Embed error: ${resp.status} ${errText.substring(0, 200)} (attempt ${attempt + 1}/${delays.length})`);
        if (resp.status === 429 || resp.status >= 500) continue;
        return [];
      }
      const data = await resp.json();
      recordUsage("embeddings", EMBED_MODEL(), data.usage);
      // Sort by index to maintain order
      const sorted = (data.data || []).sort((a, b) => a.index - b.index);
      // Matryoshka truncation to EMBED_DIMS + L2 normalize
      return sorted.map(d => {
        const truncated = d.embedding.slice(0, EMBED_DIMS);
        const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0)) || 1;
        return truncated.map(v => v / norm);
      });
    } catch (e) {
      console.log(`[USI] Embed failed: ${e.message} (attempt ${attempt + 1}/${delays.length})`);
    }
  }
  return [];
}

/** Embed a single text. Returns vector array or null. */
async function embedText(text, opts = {}) {
  if (!text || !hasEmbedConfig()) return null;
  const results = await embedBatch([text], opts);
  return results[0] || null;
}

/** Embed a document (alias for embedText) */
async function embedDocument(text) {
  return embedText(text);
}

// ============================================================================
// PHASE 1 — Local Embedding
// ============================================================================

/**
 * Embed a batch of items from any service into data_vectors.
 * Only embeds items that are new or changed (checks existing vectors).
 */
async function indexItems(userId, service, itemType, items) {
  if (!items || items.length === 0) return { indexed: 0 };
  if (!hasEmbedConfig()) { console.log("[USI] No embedding config, skipping"); return { indexed: 0 }; }
  // Enrichment runs BEFORE embedding, so if embedding is billing-dead the summary
  // spend is wasted and repeats every cycle. Skip the whole pass instead.
  if (_embedBillingDeadDay === new Date().toISOString().slice(0, 10)) {
    console.log(`[USI] Embedding billing-dead today, skipping ${service}/${itemType} indexing pass`);
    return { indexed: 0 };
  }

  // Check which items already exist and their content hashes.
  // MUST paginate: supabase caps selects at 1000 rows, and a silently-truncated hash set
  // made everything past row 1000 look "new" on every sync (cost incident 2026-07-19).
  const existingHashes = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: pageErr } = await supabase
      .from("data_vectors")
      .select("external_id, source_metadata")
      .eq("user_id", userId)
      .eq("service", service)
      .range(from, from + PAGE - 1);
    if (pageErr) {
      // Fail CLOSED: without the full dedup set, treating items as new re-bills enrichment
      console.log(`[USI] Hash fetch failed (${pageErr.message}), skipping indexing pass`);
      return { indexed: 0 };
    }
    for (const e of (page || [])) {
      existingHashes[e.external_id] = e.source_metadata?._content_hash || null;
    }
    if (!page || page.length < PAGE) break;
  }

  // Generate content hash for each item, only embed if new or content changed
  const crypto = require("crypto");
  for (const item of items) {
    item._content_hash = crypto.createHash("md5").update(item.text).digest("hex");
  }

  const newItems = items.filter(i => {
    const existingHash = existingHashes[i.external_id];
    if (!existingHash) return true; // new item
    if (existingHash !== i._content_hash) return true; // content changed
    return false;
  });
  if (newItems.length === 0) {
    console.log(`[USI] Phase 1: 0 new ${service}/${itemType} items (${items.length} already indexed)`);
    return { indexed: 0 };
  }

  // Canary: probe the embedder before spending on enrichment. DeepInfra 429-storms
  // (engine_overloaded) otherwise burn a batch of summaries per cycle for nothing.
  // The canary exists to catch a billing-dead hosted embedder before spending
  // on enrichment. A local embedder cannot be billing-dead, and a single-text
  // call costs it ~20s (batches amortise to well under a second each), so the
  // probe would be the most expensive thing in the pass.
  if (!isLocalEmbed() && (await embedBatch(["ping"])).length === 0) {
    console.log(`[USI] Embedder unavailable (canary failed), skipping ${service}/${itemType} pass. Will retry next cycle.`);
    return { indexed: 0 };
  }

  await upsertProgress(userId, service, { phase1_total: newItems.length, status: "indexing" });
  await _seedCountersFromDb(userId);
  let indexed = 0;

  // Single-pass: enrich with LLM summary first, then embed once
  let consecutiveEmbedFailures = 0;
  const BATCH = batchSize();
  for (let i = 0; i < newItems.length; i += BATCH) {
    if (_embedBillingDeadDay === new Date().toISOString().slice(0, 10)) {
      console.log(`[USI] Embedding went billing-dead mid-run, stopping ${service} pass`);
      break;
    }
    if (consecutiveEmbedFailures >= 2) {
      console.log(`[USI] Embedder failing repeatedly (overloaded?), stopping ${service} pass to avoid wasted enrichment. Will retry next cycle.`);
      break;
    }
    const batch = newItems.slice(i, i + BATCH);

    try {
      const summaries = {};
      {
        // 10 concurrent summaries: same total cost, ~2.5x faster initial
        // indexing (matters most for new-user onboarding)
        const limit = _pLimit(10);
        await Promise.allSettled(batch.map(item => limit(async () => {
          // Items can opt out of enrichment (e.g. still-live Slack conversations).
          // Short calendar events are already summary-shaped; only summarize when
          // text exceeds what the content column stores complete.
          if (item._skipEnrich) return;
          if (service === "calendar" && item.text.length <= 500) return;
          const s = await _enrichSummarize(userId, service, item.text);
          if (s) summaries[item.external_id] = s;
        })));
      }

      // Embed: use enriched summary if available, otherwise raw text
      const textsToEmbed = batch.map(item => {
        const summary = summaries[item.external_id];
        return summary ? `${summary}\n\n${item.text.substring(0, maxTextLen())}` : item.text.substring(0, maxTextLen());
      });
      const embeddings = await embedBatch(textsToEmbed);

      if (embeddings.length === 0) {
        console.log(`[USI] Batch embed returned 0 vectors for ${batch.length} items`);
        consecutiveEmbedFailures++;
        continue;
      }
      consecutiveEmbedFailures = 0;

      for (let j = 0; j < batch.length; j++) {
        if (!embeddings[j]) continue;
        const item = batch[j];
        const summary = summaries[item.external_id];
        const enriched = !!summary;
        const { error } = await supabase.from("data_vectors").upsert({
          user_id: userId,
          service,
          item_type: itemType,
          external_id: item.external_id,
          content: summary || item.text.substring(0, 500),
          embedding: JSON.stringify(embeddings[j]),
          enrichment_level: enriched ? "full" : "basic",
          source_metadata: {
            ...(item.metadata || {}),
            _content_hash: item._content_hash,
            _source_table: "data_cache",
            _lookup: `Full raw data in data_cache (accessed via search_cache/search_calendar). For actual attachment files use fetch_attachment.`,
          },
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,service,external_id" });
        if (!error) indexed++;
      }

      await upsertProgress(userId, service, { phase1_done: i + batch.length });
    } catch (e) {
      console.error(`[USI] Batch embed error: ${e.message}`);
    }
  }

  await upsertProgress(userId, service, { phase1_done: newItems.length, status: indexed > 0 ? "indexed" : "error" });
  console.log(`[USI] Phase 1: ${indexed} new ${service}/${itemType} items indexed (${items.length - newItems.length} already existed)`);
  return { indexed };
}

// ============================================================================
// ATTACHMENT TEXT EXTRACTION
// ============================================================================

/** Extract text from an attachment buffer based on file type */
async function extractAttachmentText(buffer, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  if (!SUPPORTED_ATTACHMENT_TYPES.has(ext)) return null;
  try {
    if (ext === "txt" || ext === "md" || ext === "csv" || ext === "html" || ext === "htm" || ext === "rtf") {
      return buffer.toString("utf-8").substring(0, 5000);
    }
    if (ext === "pdf") {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      return (data.text || "").substring(0, 5000);
    }
    if (ext === "docx" || ext === "doc") {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return (result.value || "").substring(0, 5000);
    }
    if (ext === "xlsx" || ext === "xls") {
      const XLSX = require("xlsx");
      const wb = XLSX.read(buffer, { type: "buffer" });
      return wb.SheetNames.map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join("\n").substring(0, 5000);
    }
    // Images: use Qwen vision to describe/OCR.
    // Metered + capped: image tokens dwarf text tokens, and marketing emails are full
    // of inline images. This was the last unmetered DeepInfra path (2026-07-19).
    if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
      if (!machineryKey() || !_visionBudgetOk()) return null;
      if (buffer.length < 10 * 1024) return null; // skip tracking pixels / tiny logos
      const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
      const base64 = buffer.toString("base64");
      _visionCount++;
      const resp = await fetch(ENRICH_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${machineryKey()}` },
        body: JSON.stringify({
          model: VISION_MODEL(),
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:${mimeMap[ext] || "image/jpeg"};base64,${base64}` } },
            { type: "text", text: "Describe this image briefly. Include all visible text. What is this image about? 2-3 sentences max." },
          ]}],
          max_tokens: 512,
          temperature: 0.1,
        }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      _visionTokensIn += data.usage?.prompt_tokens || 0;
      recordUsage("vision", VISION_MODEL(), data.usage);
      if (_visionCount % 25 === 0) console.log(`[USI] Vision today: ${_visionCount} images, tokens in=${_visionTokensIn}`);
      let text = data.choices?.[0]?.message?.content || "";
      text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return text.substring(0, 3000) || null;
    }
  } catch (e) {
    console.log(`[USI] Attachment extraction failed for ${filename}: ${e.message}`);
  }
  return null;
}

/**
 * The platform's eyes. Every machinery vision job goes through here on the
 * platform's DeepInfra bill, whatever chat model the user picked: chat image
 * descriptions, and substitution text when their chat model cannot see images
 * at all. Attachment OCR above uses the same model with its own budget caps.
 */
async function describeImages(images, opts = {}) {
  if (!machineryKey() || !images || !images.length) return null;
  const prompt = opts.detailed
    ? `Describe ${images.length > 1 ? "each of these images" : "this image"} thoroughly: layout, all visible text word for word, people, objects, numbers, anything a person would need to discuss it without seeing it. ${images.length > 1 ? "Number each description." : ""}`
    : (images.length > 1
      ? `Describe each of these ${images.length} images in one short sentence, max 15 words each, one per line. No preamble.`
      : "Describe this image in one short sentence, max 15 words. No preamble.");
  try {
    const resp = await fetch(ENRICH_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${machineryKey()}` },
      body: JSON.stringify({
        model: VISION_MODEL(),
        max_tokens: opts.detailed ? 700 : 200,
        temperature: 0.1,
        messages: [{ role: "user", content: [
          ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mediaType || "image/jpeg"};base64,${img.base64}` } })),
          { type: "text", text: prompt },
        ]}],
      }),
      // The detailed variant writes up to 700 tokens and is the substitute for
      // an image a text-only chat model will never see, so it gets room.
      signal: AbortSignal.timeout(opts.detailed ? 60000 : 25000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    _visionTokensIn += data.usage?.prompt_tokens || 0;
    recordUsage("vision", VISION_MODEL(), data.usage);
    const text = (data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return text || null;
  } catch (e) {
    console.log(`[USI] describeImages failed: ${e.message}`);
    return null;
  }
}

/** Fetch attachment content from the source service */
async function fetchAttachmentBuffer(userId, source, messageId, attachmentId, filename) {
  try {
    if (source.startsWith("gmail")) {
      const { googleApiRequest, serviceKeyForSourceTag } = require("./google");
      const data = await googleApiRequest("GET",
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
        null, null, serviceKeyForSourceTag(source)
      );
      if (data?.data) return Buffer.from(data.data, "base64url");
    }
    if (source.startsWith("outlook")) {
      const { microsoftApiRequest, msServiceKeyForSourceTag } = require("./microsoft");
      const data = await microsoftApiRequest("GET",
        `https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments/${attachmentId}/$value`,
        null, null, msServiceKeyForSourceTag(source)
      );
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === "string") return Buffer.from(data, "base64");
    }
  } catch (e) {
    console.log(`[USI] Attachment fetch failed (${source}/${filename}): ${e.message}`);
  }
  return null;
}

// ============================================================================
// PHASE 2 — LLM Background Enrichment
// ============================================================================

/**
 * Enrich basic vectors with LLM-generated semantic summaries.
 * Uses the per-token enrichment endpoint, separate from chat.
 * Processes items in parallel with pLimit(4).
 */
async function enrichService(userId, service) {
  console.log(`[USI] enrichService starting for ${userId}/${service}`);
  if (!machineryKey()) { console.log(`[USI] No enrichment (no DeepInfra key)`); return; }
  await _seedCountersFromDb(userId);

  let totalEnriched = 0;

  const { count: totalBasic } = await supabase
    .from("data_vectors")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("service", service)
    .eq("enrichment_level", "basic");
  if (!totalBasic || totalBasic === 0) return;
  console.log(`[USI] enrichService: ${totalBasic} basic ${service} items for ${userId}`);
  await upsertProgress(userId, service, { phase2_total: totalBasic, phase2_done: 0, status: "enriching" });

  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  while (true) {
    // Stop when budget/billing is exhausted: retrying yields nulls forever
    if (!enrichAvailable(userId)) {
      console.log(`[USI] Enrichment budget unavailable, pausing Phase 2 for ${userId}/${service}`);
      break;
    }

    const { data: basics } = await supabase
      .from("data_vectors")
      .select("id, external_id, service, item_type, source_metadata")
      .eq("user_id", userId)
      .eq("service", service)
      .eq("enrichment_level", "basic")
      .order("updated_at", { ascending: false })
      .limit(50);

    if (!basics || basics.length === 0) break;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.log(`[USI] Enrichment: ${MAX_CONSECUTIVE_ERRORS} consecutive errors, stopping for ${userId}/${service}`);
      break;
    }

    const enrichedBefore = totalEnriched;

    // Process items 10 at a time (same cost, faster catch-up enrichment)
    const limit = _pLimit(10);
    await Promise.allSettled(basics.map(item => limit(async () => {
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return;
      try {
        // Budget check BEFORE _getFullContent: attachment vision calls are the
        // expensive part and must not run once the enrichment budget is spent
        if (!_enrichBudgetOk(userId)) return;

        const fullContent = await _getFullContent(userId, item);
        if (!fullContent) return;

        const summary = await _enrichSummarize(userId, service, fullContent, 30000);
        if (!summary) return;

        const enrichedText = `${summary}\n\n${fullContent.substring(0, 2000)}`;
        const newEmbedding = await embedDocument(enrichedText);
        if (!newEmbedding) return;

        const { error: enrichWriteError } = await supabase.from("data_vectors").update({
          content: summary,
          embedding: JSON.stringify(newEmbedding),
          enrichment_level: "full",
          source_metadata: {
            ...item.source_metadata,
            _source_table: "data_cache",
            _lookup: `Full raw data in data_cache (accessed via search_cache/search_calendar). For actual attachment files use fetch_attachment.`,
          },
          updated_at: new Date().toISOString(),
        }).eq("id", item.id);
        // The summary was paid for before this write. Losing it silently means
        // the same item is summarised again next pass, at the same cost, for
        // as long as the write keeps failing.
        if (enrichWriteError) {
          console.error(`[USI] enrichment for ${item.external_id} was paid for but not saved: ${enrichWriteError.message}`);
        }

        totalEnriched++;
        consecutiveErrors = 0;
        if (totalEnriched <= 3) console.log(`[USI] Enriched ${item.external_id} (${totalEnriched} done for ${userId}/${service})`);
        await upsertProgress(userId, service, { phase2_done: totalEnriched });
      } catch (e) {
        consecutiveErrors++;
        console.log(`[USI] Enrichment error for ${item.external_id}: ${e.message.substring(0, 100)}`);
        // Mark as "skipped" so it doesn't get re-fetched in the next loop iteration
        await supabase.from("data_vectors").update({ enrichment_level: "error" }).eq("id", item.id).catch(() => {});
      }
    })));

    // Zero progress on a full pass means the same items would be re-fetched forever
    // (nulls from cap/billing/HTTP errors don't throw). Break instead of spinning.
    if (totalEnriched === enrichedBefore) {
      console.log(`[USI] Enrichment: no progress this pass, stopping for ${userId}/${service}`);
      break;
    }
  }

  const status = totalEnriched > 0 ? "enriched" : "indexed";
  await upsertProgress(userId, service, { status });
  if (totalEnriched > 0) console.log(`[USI] Phase 2: ${totalEnriched} ${service} items enriched for ${userId}`);
}

/** Get full content for an item from data_cache, falling back to data_vectors */
async function _getFullContent(userId, item) {
  let fullContent = "";
  const { data: cacheRow } = await supabase
    .from("data_cache")
    .select("data")
    .eq("user_id", userId)
    .eq("external_id", item.external_id)
    .single();
  if (cacheRow?.data) {
    const d = cacheRow.data;
    if (item.item_type === "email") {
      fullContent = `From: ${d.from || d.sender || ""}\nSubject: ${d.subject || ""}\nDate: ${d.date || ""}\n\n${d.body || d.snippet || ""}`;
      const attachments = d.attachments || item.source_metadata?.attachments || [];
      if (attachments.length > 0) {
        let attachmentTexts = [];
        for (const att of attachments) {
          const ext = (att.name || att.filename || "").split(".").pop().toLowerCase();
          if (!SUPPORTED_ATTACHMENT_TYPES.has(ext)) continue;
          if (att.size && att.size > MAX_ATTACHMENT_SIZE) continue;
          try {
            const source = item.source_metadata?.source || "gmail";
            const msgId = d.id || d.messageId || item.external_id;
            const attId = att.attachment_id || att.id || "";
            const buf = await fetchAttachmentBuffer(userId, source, msgId, attId, att.name || att.filename);
            if (buf) {
              const text = await extractAttachmentText(buf, att.name || att.filename);
              if (text) attachmentTexts.push(`[Attachment: ${att.name || att.filename}]\n${text}`);
            }
          } catch (_) {}
        }
        if (attachmentTexts.length > 0) fullContent += "\n\n--- ATTACHMENTS ---\n" + attachmentTexts.join("\n\n");
      }
    } else if (item.item_type === "event") {
      fullContent = `Event: ${d.summary || ""}\nWhen: ${d.start || ""} to ${d.end || ""}\nLocation: ${d.location || ""}\nAttendees: ${JSON.stringify(d.attendees || [])}\nDescription: ${d.description || ""}`;
    } else {
      fullContent = JSON.stringify(d).substring(0, 5000);
    }
  }
  if (!fullContent) {
    const { data: sv } = await supabase.from("data_vectors").select("content").eq("id", item.id).single();
    fullContent = sv?.content || "";
  }
  return fullContent;
}

// --- Enrichment: per-token LLM summaries with daily cost guardrails ---
// Two layers: per-user cap (fairness, sized to be invisible in normal use) and a global cap
// (wallet ceiling). Counters are in-memory (reset on redeploy); these are runaway-cost
// safety nets, not meters. Items over cap index un-enriched and Phase 2 upgrades them later.
let _enrichDay = "";
let _enrichCount = 0;
let _enrichTokensIn = 0;
let _enrichTokensOut = 0;
let _enrichCapLogged = false;
let _enrichUserCounts = new Map();
let _enrichBillingDead = false; // latched on 402 until next day/restart
let _enrichErrLogCount = 0;
let _visionCount = 0;
let _visionTokensIn = 0;
let _visionCapLogged = false;

function _visionBudgetOk() {
  if (_enrichBillingDead) return false;
  if (_visionCount >= VISION_DAILY_CAP) {
    if (!_visionCapLogged) {
      console.log(`[USI] Vision daily cap reached (${VISION_DAILY_CAP} images). Attachments index without image descriptions until tomorrow.`);
      _visionCapLogged = true;
    }
    return false;
  }
  return true;
}

let _seededGlobal = false;
let _seededUsers = new Set();

function _rollDayIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _enrichDay) {
    _enrichDay = today; _enrichCount = 0; _enrichTokensIn = 0; _enrichTokensOut = 0;
    _enrichCapLogged = false; _enrichUserCounts = new Map();
    _enrichBillingDead = false; _enrichErrLogCount = 0;
    _visionCount = 0; _visionTokensIn = 0; _visionCapLogged = false;
    _seededGlobal = false; _seededUsers = new Set();
  }
}

/**
 * Seed cap counters from data_vectors (items actually enriched today) so restarts
 * don't reset the budget. Eight deploys on 2026-07-19 each granted a fresh daily
 * cap because counters lived only in process memory.
 */
async function _seedCountersFromDb(userId) {
  _rollDayIfNeeded();
  const startISO = _enrichDay + "T00:00:00Z";
  try {
    if (!_seededGlobal) {
      _seededGlobal = true;
      const { count } = await supabase.from("data_vectors")
        .select("id", { count: "exact", head: true })
        .eq("enrichment_level", "full").gte("updated_at", startISO);
      if ((count || 0) > _enrichCount) _enrichCount = count || 0;
      console.log(`[USI] Budget seeded: ${_enrichCount} enrichments already done today (deploy-proof cap)`);
    }
    if (userId && !_seededUsers.has(userId)) {
      _seededUsers.add(userId);
      const { count } = await supabase.from("data_vectors")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("enrichment_level", "full").gte("updated_at", startISO);
      if ((count || 0) > (_enrichUserCounts.get(userId) || 0)) _enrichUserCounts.set(userId, count || 0);
    }
  } catch (e) {
    console.log(`[USI] Counter seed failed: ${e.message}`);
  }
}

function _enrichBudgetOk(userId) {
  _rollDayIfNeeded();
  if (_enrichBillingDead) return false;
  if (_enrichCount >= ENRICH_DAILY_CAP) {
    if (!_enrichCapLogged) {
      console.log(`[USI] Global enrichment cap reached (${ENRICH_DAILY_CAP}/day). Items index un-enriched until tomorrow.`);
      _enrichCapLogged = true;
    }
    return false;
  }
  const userCount = _enrichUserCounts.get(userId) || 0;
  if (userCount >= ENRICH_USER_DAILY_CAP) {
    if (userCount === ENRICH_USER_DAILY_CAP) {
      console.log(`[USI] Per-user enrichment cap reached for ${userId} (${ENRICH_USER_DAILY_CAP}/day).`);
      _enrichUserCounts.set(userId, userCount + 1);
    }
    return false;
  }
  return true;
}

/** True when enrichment can still run (budget + billing). Loops use this to stop retrying. */
function enrichAvailable(userId) {
  return !!machineryKey() && _enrichBudgetOk(userId);
}

/**
 * One completion with primary → fallback model. Always tries ENRICH_MODEL() first
 * (even if it failed last time), falls to ENRICH_FALLBACK_MODEL() on 429/5xx/
 * timeout/empty so a single overloaded model never stalls enrichment.
 * Shares the 402 latch (billing is account-wide, fallback can't help there).
 * Returns text or null.
 */
async function _enrichCompletion(systemPrompt, userContent, maxTokens, timeoutMs) {
  const models = [...new Set([ENRICH_MODEL(), ENRICH_FALLBACK_MODEL()])];
  for (const model of models) {
    try {
      const resp = await Promise.race([
        fetch(ENRICH_URL(), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${machineryKey()}` },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            // Both model families think by default and reasoning eats the whole
            // token budget on short calls, which comes back as empty summaries.
            // Each family has its own off switch: DeepSeek takes the standard
            // reasoning_effort param, Qwen only respects its template kwarg.
            ...(model.startsWith("deepseek") ? { reasoning_effort: "none" } : /^Qwen\//.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : /^grok/.test(model) ? { reasoning_effort: "low" } : {}),
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ],
          }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
      ]);
      if (!resp.ok) {
        if (resp.status === 402) {
          if (!_enrichBillingDead) console.log(`[USI] DeepInfra balance exhausted (402). Enrichment disabled until tomorrow/top-up+restart.`);
          _enrichBillingDead = true;
          return null;
        }
        const errText = await resp.text().catch(() => "");
        if (_enrichErrLogCount++ < 20) console.log(`[USI] Enrich error on ${model}: ${resp.status} ${errText.substring(0, 150)}`);
        if (resp.status === 429 || resp.status >= 500) continue; // transient: try fallback model
        break; // 4xx other than 429: fallback won't fix a bad request
      }
      const data = await resp.json();
      _enrichTokensIn += data.usage?.prompt_tokens || 0;
      _enrichTokensOut += data.usage?.completion_tokens || 0;
      recordUsage("enrichment", model, data.usage);
      const s = (data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (s) return s;
      // empty response: try fallback model
    } catch (e) {
      if (e.message !== "timeout" && _enrichErrLogCount++ < 20) console.log(`[USI] Enrich failed on ${model}: ${e.message}`);
      // timeout/network: try fallback model
    }
  }
  await new Promise(r => setTimeout(r, 2000)); // all models failed: backoff, never tight-loop
  return null;
}

/**
 * Generic one-shot completion on the cheap platform model (DeepInfra), sharing the
 * enrichment budget/metering/402-latch. Used by pulse triage. Returns text or null.
 */
async function cheapChat(userId, systemPrompt, userContent, maxTokens = 512, timeoutMs = 20000) {
  if (!machineryKey() || !_enrichBudgetOk(userId)) return null;
  _enrichCount++;
  _enrichUserCounts.set(userId, (_enrichUserCounts.get(userId) || 0) + 1);
  return _enrichCompletion(systemPrompt, userContent, maxTokens, timeoutMs);
}

/** Generate a 2-3 sentence summary of an item. Returns string or null (null = index un-enriched). */
async function _enrichSummarize(userId, service, text, timeoutMs = 15000) {
  if (!machineryKey() || !text) return null;
  if (!_enrichBudgetOk(userId)) return null;

  // Count the ATTEMPT, not the success: a failure storm must consume budget too,
  // or the cap never engages and retries run unbounded (cost incident 2026-07-19).
  _enrichCount++;
  _enrichUserCounts.set(userId, (_enrichUserCounts.get(userId) || 0) + 1);

  if (_enrichCount % 50 === 0) {
    console.log(`[USI] Enrichment today: ${_enrichCount} attempts, tokens in=${_enrichTokensIn} out=${_enrichTokensOut}`);
  }
  return _enrichCompletion(
    "You produce 2-3 sentence semantic summaries of data items. Include: what it's about, key names/dates/numbers, any actions requested. Be specific, not vague.",
    `Summarise this ${service} item:\n\n${text.substring(0, 4000)}`,
    256,
    timeoutMs
  );
}

/** Simple concurrency limiter */
function _pLimit(concurrency) {
  let active = 0;
  const queue = [];
  function next() { if (queue.length > 0 && active < concurrency) { active++; queue.shift()(); } }
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
      next();
    });
  };
}

// ============================================================================
// UNIFIED SEARCH
// ============================================================================

// Tokenising and match windows live in ./lexical.js, vendored into the webapp
// so File Search runs the same lexical arm over rag_chunks that this runs over
// data_cache. Mail is the corpus here, so the mail stop words apply.
const { lexicalTokens: _lexicalTokens, matchWindow } = require("./lexical");
const lexicalTokens = (query) => _lexicalTokens(query, { corpus: "mail" });

// Reported once: a missing lexical index degrades search rather than breaking
// it, but it should not do so silently.
let _lexUnavailableReported = false;

async function lexicalSearch(userId, tokens, opts = {}) {
  if (!tokens.length) return [];
  try {
    const { data, error } = await supabase.rpc("search_data_cache_lexical", {
      match_user_id: userId,
      query_tokens: tokens,
      match_count: opts.maxResults || 20,
      filter_type: opts.cacheType || null,
    });
    if (error) {
      if (!_lexUnavailableReported) {
        _lexUnavailableReported = true;
        console.log(`[USI] Lexical search unavailable (${error.message}); running vector-only. Apply migration 030 to enable it.`);
      }
      return [];
    }
    return (data || []).map(r => {
      const d = r.data || {};
      const isEvent = r.type === "event";
      const title = d.subject || d.summary || "";
      const body = d.body || d.description || d.snippet || "";
      const window = matchWindow(body, tokens);
      return {
        service: isEvent ? "calendar" : "email",
        type: isEvent ? "event" : "email",
        id: r.external_id,
        content: [title, window].filter(Boolean).join("\n").substring(0, 400),
        metadata: {
          subject: d.subject || undefined,
          summary: d.summary || undefined,
          from: d.from || undefined,
          date: d.date || d.start || undefined,
        },
        enriched: false,
        _lexical: true,
        _rank: r.rank,
      };
    });
  } catch (e) {
    if (!_lexUnavailableReported) {
      _lexUnavailableReported = true;
      console.log(`[USI] Lexical search failed (${e.message}); running vector-only.`);
    }
    return [];
  }
}

/**
 * Hybrid retrieval: a vector arm and a lexical arm as co-equal retrievers over
 * the same corpus, fused by Reciprocal Rank Fusion.
 *
 * RRF rather than a weighted score blend because cosine similarity and
 * ts_rank_cd are on incomparable, query-dependent scales; any fixed alpha needs
 * calibration that drifts. RRF reads only ordinal position, needs no tuning,
 * and degrades to "whatever the other arm found" when one returns nothing.
 * An item both arms find scores the sum of its two contributions, so agreement
 * promotes it rather than costing it a second slot in a fixed budget.
 *
 * WHAT THE RRF SCORE IS NOT: a relevance signal. This step decides which
 * candidates the cross-encoder gets to see, and nothing more. Observed on a
 * real query, the RRF order came back close to the REVERSE of the reranker's:
 * the three items both arms agreed on scored highest on RRF and lowest on
 * rerank, and the second-best answer was a keyword-only hit near the bottom of
 * the RRF list. That is not a defect to tune out. Agreement between a semantic
 * and a lexical retriever means "both noticed this", which is a good reason to
 * show it to a judge and a poor reason to believe it. The cross-encoder is the
 * only component here that reads the query and the document together, so it is
 * the only one whose ordering is a quality judgement.
 *
 * Do not sort, threshold, truncate or report on _rrf as though it ranked
 * anything. It exists to fill the candidate set.
 */
const RRF_K = 60;

async function search(userId, query, opts = {}) {
  const tokens = lexicalTokens(query);
  // Both arms in parallel: the lexical arm is a GIN index scan and the vector
  // arm is dominated by the query embed, so hybrid costs one round trip, not
  // the sum of the two.
  const [embedding, lexRows] = await Promise.all([
    embedText(query, { quick: true }),
    lexicalSearch(userId, tokens, opts),
  ]);

  let vecRows = [];
  let vecError = null;
  if (embedding) {
    const { data, error } = await supabase.rpc("search_data_vectors", {
      query_embedding: JSON.stringify(embedding),
      match_user_id: userId,
      match_threshold: opts.threshold || 0.3,
      match_count: opts.maxResults || 30,
      filter_service: opts.service || null,
    });
    if (error) vecError = error.message;
    else vecRows = (data || []).map(r => ({
      service: r.service,
      type: r.item_type,
      id: r.external_id,
      content: r.content,
      metadata: r.source_metadata,
      enriched: r.enrichment_level === "full",
      similarity: r.similarity,
    }));
  }

  // A dead embedder no longer means a dead search: lexical alone is a genuine
  // result set, not a consolation prize.
  if (!embedding && !lexRows.length) {
    return { results: [], error: "Semantic search temporarily unavailable. Fall back to search_cache keyword search now." };
  }
  if (vecError && !lexRows.length) return { results: [], error: vecError };

  const fused = new Map();
  const contribute = (row, rank, arm) => {
    const key = row.id || `${arm}:${rank}`;
    const prev = fused.get(key);
    const score = 1 / (RRF_K + rank + 1);
    if (!prev) {
      fused.set(key, { score, vec: arm === "vec" ? row : null, lex: arm === "lex" ? row : null });
      return;
    }
    prev.score += score;
    if (arm === "vec") prev.vec = prev.vec || row;
    else prev.lex = prev.lex || row;
  };
  vecRows.forEach((r, i) => contribute(r, i, "vec"));
  lexRows.forEach((r, i) => contribute(r, i, "lex"));

  const merged = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, vec, lex }) => {
      // Prefer the enriched summary the vector arm carries, since it reads
      // better than a raw window. Except when the matched token is absent from
      // it: then the summary cannot show why this row was retrieved, and the
      // window is the only thing that can.
      let base = vec || lex;
      if (vec && lex) {
        const summary = String(vec.content || "").toLowerCase();
        const missing = tokens.length && !tokens.some(t => summary.includes(t.toLowerCase()));
        base = missing ? { ...vec, content: lex.content } : vec;
      }
      // _rrf is candidate-generation bookkeeping, not a score anyone should
      // rank on. See the note above the function.
      return { ...base, _rrf: score, _arms: vec && lex ? "both" : vec ? "vector" : "lexical" };
    })
    .slice(0, opts.maxResults || 30);

  return { results: merged };
}

// ============================================================================
// EMAIL/CALENDAR INDEXING HOOKS
// ============================================================================

async function indexCachedEmails(userId) {
  let offset = 0;
  const PAGE_SIZE = 300;
  let totalIndexed = 0;
  const allIndexedIds = new Set();

  // DEDUP: Build cloud Message-ID set ONCE across ALL emails (not per page)
  const { data: connections } = await supabase.from("connections").select("service").eq("user_id", userId);
  const cloudEmailSources = new Set();
  for (const c of (connections || [])) {
    if (c.service === "google") cloudEmailSources.add("gmail");
    if (c.service.startsWith("google_extra_")) cloudEmailSources.add("gmail_" + c.service.slice("google_extra_".length));
    if (c.service === "microsoft") cloudEmailSources.add("outlook");
    if (c.service.startsWith("microsoft_extra_")) cloudEmailSources.add("outlook_" + c.service.slice("microsoft_extra_".length));
  }

  const cloudMessageIds = new Set();
  if (cloudEmailSources.size > 0) {
    const cloudSources = [...cloudEmailSources];
    const { data: cloudEmails } = await supabase
      .from("data_cache")
      .select("data")
      .eq("user_id", userId)
      .eq("type", "email")
      .in("source", cloudSources);
    for (const e of (cloudEmails || [])) {
      const d = e.data || {};
      const msgId = d.messageId_header || d.messageId || d.id || "";
      if (msgId) cloudMessageIds.add(msgId);
    }
  }

  while (true) {
    const { data: emails } = await supabase
      .from("data_cache")
      .select("external_id, data, source, synced_at")
      .eq("user_id", userId)
      .eq("type", "email")
      .order("synced_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (!emails || emails.length === 0) break;

    // Debug: log source breakdown on first page
    if (offset === 0) {
      const sources = {};
      for (const e of emails) { sources[e.source] = (sources[e.source] || 0) + 1; }
      console.log(`[USI] Email page 0: ${emails.length} total, sources: ${JSON.stringify(sources)}, cloudSources: [${[...cloudEmailSources]}], cloudMsgIds: ${cloudMessageIds.size}`);
    }

    const dedupedEmails = emails.filter(e => {
      if (e.source.startsWith("gmail") || e.source === "outlook") return true;
      const d = e.data || {};
      const msgId = d.messageId_header || d.messageId || d.id || "";
      if (msgId && cloudMessageIds.has(msgId)) return false;
      const account = (d.account || "").toLowerCase();
      if (account.includes("gmail") && cloudEmailSources.has("gmail")) return false;
      if ((account.includes("outlook") || account.includes("exchange")) && cloudEmailSources.has("outlook")) return false;
      return true;
    });

    const items = dedupedEmails.map(e => {
      const d = e.data || {};
      const attNames = (d.attachments || []).map(a => a.name || a.filename || "").filter(Boolean);
      const text = [
        `From: ${d.from || d.sender || ""}`,
        `To: ${d.to || ""}`,
        `Subject: ${d.subject || ""}`,
        `Date: ${d.date || ""}`,
        `Account: ${d.account || ""}`,
        d.body || d.snippet || "",
        attNames.length > 0 ? `Attachments: ${attNames.join(", ")}` : "",
      ].filter(Boolean).join("\n");

      return {
        external_id: e.external_id || d.id || d.messageId || "",
        text,
        metadata: {
          from: d.from || d.sender,
          to: d.to,
          subject: d.subject,
          date: d.date,
          source: e.source,
          has_attachments: !!(d.attachments && d.attachments.length > 0),
          attachment_names: (d.attachments || []).map(a => a.name || a.filename).filter(Boolean),
          _cache_updated_at: e.synced_at,
        },
      };
    }).filter(i => i.external_id && i.text.length > 20);

    // Debug: log filtering pipeline on first page
    if (offset === 0) {
      const noExtId = dedupedEmails.filter(e => !(e.external_id || (e.data || {}).id || (e.data || {}).messageId)).length;
      console.log(`[USI] Email pipeline: ${emails.length} raw -> ${dedupedEmails.length} after dedup -> ${items.length} after filter (${noExtId} missing external_id)`);
    }

    for (const item of items) allIndexedIds.add(item.external_id);

    const result = await indexItems(userId, "email", "email", items);
    totalIndexed += result.indexed;

    if (emails.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Clean up vectors for emails that no longer exist in cache
  if (allIndexedIds.size > 0) {
    const { data: staleVectors } = await supabase
      .from("data_vectors")
      .select("id, external_id")
      .eq("user_id", userId)
      .eq("service", "email");
    const toDelete = (staleVectors || []).filter(v => !allIndexedIds.has(v.external_id));
    if (toDelete.length > 0) {
      for (const v of toDelete) {
        const { error: delError } = await supabase.from("data_vectors").delete().eq("id", v.id);
        if (delError) console.error(`[USI] could not delete stale vector ${v.id}: ${delError.message}`);
      }
      console.log(`[USI] Cleaned ${toDelete.length} stale email vectors`);
    }
  }

  return { indexed: totalIndexed };
}

async function indexCachedCalendar(userId) {
  let offset = 0;
  const PAGE_SIZE = 300;
  let totalIndexed = 0;
  const allIndexedIds = new Set();

  // DEDUP: Build cloud iCalUID set upfront
  const { data: cloudEvents } = await supabase
    .from("data_cache")
    .select("data")
    .eq("user_id", userId)
    .eq("type", "event")
    .in("source", ["gcal", "outlook_cal"]);
  const cloudUIDs = new Set();
  for (const e of (cloudEvents || [])) {
    const uid = e.data?.uid || e.data?.iCalUID || "";
    if (uid) cloudUIDs.add(uid);
  }

  while (true) {
    const { data: events } = await supabase
      .from("data_cache")
      .select("external_id, data, source, synced_at")
      .eq("user_id", userId)
      .eq("type", "event")
      .order("synced_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (!events || events.length === 0) break;

    const dedupedEvents = events.filter(e => {
      if (e.source.startsWith("gcal") || e.source === "outlook_cal") return true;
      const uid = e.data?.uid || e.data?.iCalUID || "";
      if (uid && cloudUIDs.has(uid)) return false;
      return true;
    });

    const items = dedupedEvents.map(e => {
      const d = e.data || {};
      const attendeeStr = (d.attendees || []).map(a =>
        typeof a === "string" ? a : `${a.name || a.email || ""} (${a.status || ""})`
      ).join(", ");

      let durationStr = "";
      try {
        const s = new Date(d.start || d.date);
        const en = new Date(d.end);
        if (!isNaN(s.getTime()) && !isNaN(en.getTime())) {
          const mins = Math.round((en - s) / 60000);
          if (mins > 0 && mins < 1440) durationStr = `${mins} minutes`;
          else if (mins >= 1440) durationStr = `${Math.round(mins / 1440)} day(s)`;
        }
      } catch (_) {}

      const text = [
        `Event: ${d.summary || ""}`,
        `When: ${d.start || d.date || ""} to ${d.end || ""}`,
        durationStr ? `Duration: ${durationStr}` : "",
        `Location: ${d.location || ""}`,
        `Calendar: ${d.calendar || ""}`,
        `Attendees: ${attendeeStr}`,
        `Description: ${d.description || ""}`,
        (d.attachments && d.attachments.length) ? `Attachments: ${d.attachments.map(a => a.name).filter(Boolean).join(", ")}` : "",
        d.recurrence ? `Recurrence: ${d.recurrence}` : "",
      ].filter(Boolean).join("\n");

      return {
        external_id: e.external_id || d.id || d.uid || "",
        text,
        metadata: {
          summary: d.summary,
          start: d.start || d.date,
          end: d.end,
          location: d.location,
          calendar: d.calendar,
          source: e.source,
          attendees: d.attendees,
          canceled: d.canceled || false,
          has_attachments: !!(d.attachments && d.attachments.length),
          attachments: d.attachments || [],
          _cache_updated_at: e.synced_at,
        },
      };
    }).filter(i => i.external_id && i.text.length > 20);

    for (const item of items) allIndexedIds.add(item.external_id);

    const result = await indexItems(userId, "calendar", "event", items);
    totalIndexed += result.indexed;

    if (events.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Clean up vectors for events no longer in cache
  if (allIndexedIds.size > 0) {
    const { data: staleVectors } = await supabase
      .from("data_vectors")
      .select("id, external_id")
      .eq("user_id", userId)
      .eq("service", "calendar");
    const toDelete = (staleVectors || []).filter(v => !allIndexedIds.has(v.external_id));
    if (toDelete.length > 0) {
      for (const v of toDelete) {
        const { error: delError } = await supabase.from("data_vectors").delete().eq("id", v.id);
        if (delError) console.error(`[USI] could not delete stale vector ${v.id}: ${delError.message}`);
      }
      console.log(`[USI] Cleaned ${toDelete.length} stale calendar vectors`);
    }
  }

  return { indexed: totalIndexed };
}

// ============================================================================
// PROGRESS TRACKING
// ============================================================================

async function upsertProgress(userId, service, updates) {
  const row = { user_id: userId, service, ...updates, updated_at: new Date().toISOString() };
  try {
    const { error } = await supabase.from("index_progress").upsert(row, { onConflict: "user_id,service" });
    // Progress drives the wizard's indexing display. A lost write makes the
    // dashboard report a stall that is not happening, or hide one that is.
    if (error) console.log(`[USI] progress write failed for ${service}: ${error.message}`);
  } catch (e) { console.log(`[USI] progress write failed for ${service}: ${e.message}`); }
}

async function getProgress(userId) {
  const { data } = await supabase.from("index_progress").select("*").eq("user_id", userId);
  return data || [];
}

// ============================================================================
// SYNC HOOKS
// ============================================================================

// A pass over a large mailbox takes minutes and the sync loop comes round every
// few. Without this guard each cycle piled another pass on top of the unfinished
// one; on a local CPU embedder they fought for the same core and none of them
// reached its first write, so an install could sync for an hour and index
// nothing.
//
// A start time rather than a flag, because a pass that hangs would otherwise
// hold the lock for the life of the process and stop that user ever being
// indexed again, which is a worse failure than the overlap this prevents. The
// token check stops a late-finishing stale pass from clearing its successor.
const STALE_PASS_MS = 30 * 60 * 1000;
const _passStartedAt = new Map();

async function runPostSyncIndex(userId) {
  const startedAt = _passStartedAt.get(userId);
  if (startedAt && Date.now() - startedAt < STALE_PASS_MS) {
    console.log(`[USI] pass already running for ${userId}, skipping this cycle`);
    return;
  }
  if (startedAt) {
    console.log(`[USI] previous pass for ${userId} has been running ${Math.round((Date.now() - startedAt) / 60000)}min; treating it as stuck and starting a fresh one`);
  }
  const token = Date.now();
  _passStartedAt.set(userId, token);
  console.log(`[USI] runPostSyncIndex starting for ${userId}`);
  try {
    const { count: emailCount } = await supabase.from("data_cache").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("type", "email");
    const { count: calCount } = await supabase.from("data_cache").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("type", "event");
    console.log(`[USI] data_cache for ${userId}: emails=${emailCount || 0}, events=${calCount || 0}`);
    const indexResults = await Promise.allSettled([
      indexCachedEmails(userId),
      indexCachedCalendar(userId),
    ]);
    for (const r of indexResults) {
      if (r.status === "rejected") console.error(`[USI] Index task rejected: ${r.reason?.message || r.reason}`);
      else console.log(`[USI] Index task completed: indexed=${r.value?.indexed || 0}`);
    }
    // Phase 2: LLM enrichment (fire-and-forget, uses dedicated enrichment server)
    (async () => {
      try {
        await enrichService(userId, "email");
        await enrichService(userId, "calendar");
      } catch (e) { console.log(`[USI] Enrichment error for ${userId}: ${e.message}`); }
    })();
  } catch (e) {
    console.error(`[USI] Post-sync index error for ${userId}: ${e.message}`);
  } finally {
    if (_passStartedAt.get(userId) === token) _passStartedAt.delete(userId);
  }
}

module.exports = {
  cheapChat,
  describeImages,
  extractAttachmentText,
  embedDocument,
  embedText,
  embedBatch,
  indexItems,
  enrichService,
  search,
  indexCachedEmails,
  indexCachedCalendar,
  runPostSyncIndex,
  getProgress,
};
