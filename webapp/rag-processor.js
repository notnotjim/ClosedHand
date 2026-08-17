// webapp/rag-processor.js -- RAG document processing pipeline
// Extracts text, chunks, embeds via Qwen3-Embedding (DeepInfra), stores in Supabase pgvector

const path = require("path");
const { supabase } = require("./db");

const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY;
const EMBED_URL = process.env.EMBED_API_URL || "https://api.deepinfra.com/v1/openai/embeddings";
// File Search's live rag_chunks were indexed with Qwen3-Embedding-4B. The query
// path must use the SAME model or every cosine collapses to ~0 (different models
// live in incompatible vector spaces). Default matches the data so File Search
// still works if the EMBED_MODEL env override is ever lost. Changing this model
// requires a full re-index of rag_chunks, it is not a hot swap.
const EMBED_MODEL = process.env.EMBED_MODEL || "Qwen/Qwen3-Embedding-4B";
const CHAT_URL = process.env.ENRICH_API_URL || "https://api.deepinfra.com/v1/openai/chat/completions";
// Same summariser as passive recall (data_vectors) for consistency and cost.
const ENRICH_MODEL = process.env.ENRICH_MODEL || "deepseek-ai/DeepSeek-V4-Flash";
const VISION_MODEL = process.env.VISION_MODEL || "Qwen/Qwen3-VL-30B-A3B-Instruct";
const EMBED_DIMS = 1536; // Matryoshka truncation from native 4096
const CHUNK_SIZE = 3200; // ~800 tokens
const CHUNK_OVERLAP = 200;
const EMBED_BATCH_SIZE = 32;

// One global ceiling on in-flight provider calls. Files are indexed in
// parallel and each file enriches its chunks in parallel, so without a shared
// limit the two multiply into a burst that earns 429s, and 429s cost both
// time and budget (attempts are metered). Every vision, enrichment and
// embedding request passes through here.
const LLM_CONCURRENCY = parseInt(process.env.RAG_LLM_CONCURRENCY || "12", 10);
let _llmActive = 0;
const _llmWaiters = [];
async function llmSlot(fn) {
  if (_llmActive >= LLM_CONCURRENCY) await new Promise(resolve => _llmWaiters.push(resolve));
  _llmActive++;
  try {
    return await fn();
  } finally {
    _llmActive--;
    const next = _llmWaiters.shift();
    if (next) next();
  }
}

// Dependency injection for sandbox/bridge access
let _getSandboxInfo, _sandboxFetch, _bridgeRequest;

function init({ getSandboxInfo, sandboxFetch, bridgeRequest }) {
  _getSandboxInfo = getSandboxInfo;
  _sandboxFetch = sandboxFetch;
  _bridgeRequest = bridgeRequest;
}

// --- OAuth token helpers for cloud storage ---

const { encryptTokens, decryptTokens } = require("./crypto-tokens");

async function getServiceToken(userId, service) {
  const { data } = await supabase.from("connections").select("tokens").eq("user_id", userId).eq("service", service).single();
  const tokens = decryptTokens(data?.tokens);
  if (!tokens?.access_token) throw new Error(service + " not connected");
  return tokens.access_token;
}

async function refreshGoogleToken(userId, serviceKey = "google") {
  const { data: conn } = await supabase.from("connections").select("tokens").eq("user_id", userId).eq("service", serviceKey).single();
  const tokens = decryptTokens(conn?.tokens);
  if (!tokens?.refresh_token) throw new Error("No Google refresh token");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Google token refresh failed");
  const newTokens = { ...tokens, access_token: data.access_token };
  // Checked, not fire-and-forget: the refreshed token is returned either way,
  // so a failed write leaves the caller working and the NEXT call using a
  // stale token. That surfaces later as an auth error with no connection to
  // its cause.
  const { error: tokenWriteError } = await supabase.from("connections")
    .update({ tokens: encryptTokens(newTokens) }).eq("user_id", userId).eq("service", serviceKey);
  if (tokenWriteError) console.error(`[rag] Google token refreshed but NOT saved: ${tokenWriteError.message}. The next call will use a stale token.`);
  return data.access_token;
}

async function refreshMicrosoftToken(userId, serviceKey = "microsoft") {
  const { data: conn } = await supabase.from("connections").select("tokens").eq("user_id", userId).eq("service", serviceKey).single();
  const tokens = decryptTokens(conn?.tokens);
  if (!tokens?.refresh_token) throw new Error("No Microsoft refresh token");
  const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Microsoft token refresh failed");
  const newTokens = { ...tokens, access_token: data.access_token };
  // Checked, not fire-and-forget: the refreshed token is returned either way,
  // so a failed write leaves the caller working and the NEXT call using a
  // stale token. That surfaces later as an auth error with no connection to
  // its cause.
  const { error: tokenWriteError } = await supabase.from("connections")
    .update({ tokens: encryptTokens(newTokens) }).eq("user_id", userId).eq("service", "microsoft");
  if (tokenWriteError) console.error(`[rag] Microsoft token refreshed but NOT saved: ${tokenWriteError.message}. The next call will use a stale token.`);
  return data.access_token;
}

// Fetch with token refresh on 401
async function fetchWithRefresh(userId, service, url, options = {}) {
  let token = await getServiceToken(userId, service);
  options.headers = { ...options.headers, Authorization: "Bearer " + token };
  let resp = await fetch(url, options);
  if (resp.status === 401) {
    if (/^google/.test(service)) token = await refreshGoogleToken(userId, service);
    else if (/^microsoft/.test(service)) token = await refreshMicrosoftToken(userId, service);
    else throw new Error(service + " token expired");
    options.headers.Authorization = "Bearer " + token;
    resp = await fetch(url, options);
  }
  return resp;
}

const RAG_FILE_TYPES = {
  ".pdf": "pdf", ".docx": "docx", ".txt": "txt", ".md": "md", ".csv": "csv",
  ".xlsx": "xlsx", ".xls": "xls", ".pptx": "pptx",
  ".html": "html", ".htm": "htm",
  ".json": "json", ".xml": "xml", ".rtf": "rtf", ".eml": "eml",
  ".zip": "zip",
  ".jpg": "jpg", ".jpeg": "jpeg", ".png": "png", ".webp": "webp",
  ".gif": "gif", ".tiff": "tiff", ".bmp": "bmp",
};

const IMAGE_MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", tiff: "image/tiff", bmp: "image/bmp",
};

/**
 * Shrink an image before sending it to the vision model. A modern phone photo
 * is ~24MP / 4MB, which becomes ~5MB of base64 on the wire and takes the model
 * a very long time to process, for no benefit: descriptions and text
 * transcription work fine from ~1400px. Optional dependency, so if sharp is
 * unavailable in the deploy we fall back to the original rather than failing.
 */
async function downscaleImage(buffer, maxEdge = 1400) {
  try {
    const sharp = require("sharp");
    const out = await sharp(buffer, { failOn: "none" })
      .rotate() // honour EXIF orientation
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { buffer: out, mimeType: "image/jpeg" };
  } catch (e) {
    return null;
  }
}

async function extractTextFromImage(buffer, mimeType, attempt = 0) {
  if (!DEEPINFRA_API_KEY) throw new Error("No DEEPINFRA_API_KEY for image OCR");

  // Smaller image on the retry: if the first pass timed out, the most likely
  // cause is size, so shrink harder rather than repeating the same request.
  const maxEdge = attempt === 0 ? 1400 : 900;
  const shrunk = await downscaleImage(buffer, maxEdge);
  const sendBuf = shrunk ? shrunk.buffer : buffer;
  const sendMime = shrunk ? shrunk.mimeType : mimeType;
  if (shrunk) {
    console.log(`[RAG] Image downscaled for vision: ${(buffer.length / 1048576).toFixed(1)}MB -> ${(sendBuf.length / 1048576).toFixed(2)}MB`);
  }

  try {
    const resp = await llmSlot(() => fetch(CHAT_URL, {
      method: "POST",
      // Hard timeout: without it, one hung vision call stalls the whole source
      // indexing loop forever and every later file in the folder never indexes.
      signal: AbortSignal.timeout(90000),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPINFRA_API_KEY}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${sendMime};base64,${sendBuf.toString("base64")}` } },
            // Focused rather than "exhaustive": generation length drives most
            // of the latency, and search only needs what someone would type.
            // People get explicit physical detail because that is how photos
            // actually get searched for ("blue eyes", "red dress", "the guy
            // with the beard"). A description that omits an attribute makes
            // that attribute unsearchable, however good the embedding is.
            { type: "text", text: "Describe this image for search. Cover: any visible text (transcribe it exactly); each person's hair colour and style, eye colour if visible, approximate age, clothing and what they are doing; notable objects with their colours; the setting and occasion. Around 130 words, concrete and specific. Output only the description." },
          ],
        }],
        max_tokens: 700,
        temperature: 0.1,
      }),
    }));

    if (!resp.ok) throw new Error(`Vision OCR failed: ${resp.status}`);
    const data = await resp.json();
    let text = data.choices?.[0]?.message?.content || "";
    // Strip <think> tags from Qwen responses
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text && attempt === 0) return extractTextFromImage(buffer, mimeType, 1);
    return text;
  } catch (e) {
    // Timeouts and provider blips are transient: one retry at a smaller size
    // rather than dropping the image from the index permanently.
    if (attempt === 0) {
      console.log(`[RAG] Vision attempt failed (${e.message}), retrying smaller`);
      return extractTextFromImage(buffer, mimeType, 1);
    }
    throw e;
  }
}

// --- Text extraction ---

async function extractText(buffer, fileType) {
  if (fileType === "txt" || fileType === "md") {
    return buffer.toString("utf-8");
  }
  if (fileType === "csv") {
    return buffer.toString("utf-8");
  }
  if (fileType === "pdf") {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (fileType === "docx") {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (fileType === "xlsx" || fileType === "xls") {
    const XLSX = require("xlsx");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const texts = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      texts.push(`Sheet: ${sheetName}\n${csv}`);
    }
    return texts.join("\n\n");
  }
  if (fileType === "pptx") {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(buffer);
    const texts = [];
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.match(/^ppt\/slides\/slide\d+\.xml$/)) {
        const xml = entry.getData().toString("utf-8");
        const matches = xml.match(/<a:t>([^<]*)<\/a:t>/g) || [];
        const slideText = matches.map(m => m.replace(/<\/?a:t>/g, "")).join(" ");
        if (slideText.trim()) texts.push(slideText.trim());
      }
    }
    return texts.join("\n\n") || "No text found in presentation";
  }
  if (fileType === "html" || fileType === "htm") {
    const cheerio = require("cheerio");
    const $ = cheerio.load(buffer.toString("utf-8"));
    $("script, style, noscript").remove();
    return $("body").text().replace(/\s+/g, " ").trim();
  }
  if (fileType === "json") {
    try {
      const obj = JSON.parse(buffer.toString("utf-8"));
      return JSON.stringify(obj, null, 2);
    } catch (e) {
      return buffer.toString("utf-8");
    }
  }
  if (fileType === "xml") {
    const text = buffer.toString("utf-8");
    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (fileType === "rtf") {
    const text = buffer.toString("utf-8");
    return text
      .replace(/\{\\[^{}]*\}/g, "")
      .replace(/\\[a-z]+\d* ?/gi, "")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (fileType === "eml") {
    const text = buffer.toString("utf-8");
    const parts = text.split(/\r?\n\r?\n/);
    const headers = parts[0] || "";
    const body = parts.slice(1).join("\n\n");
    const from = (headers.match(/^From:\s*(.+)$/mi) || [])[1] || "";
    const to = (headers.match(/^To:\s*(.+)$/mi) || [])[1] || "";
    const subject = (headers.match(/^Subject:\s*(.+)$/mi) || [])[1] || "";
    const date = (headers.match(/^Date:\s*(.+)$/mi) || [])[1] || "";
    return `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}`;
  }
  if (fileType === "zip") {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(buffer);
    const texts = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const ext = "." + entry.entryName.split(".").pop().toLowerCase();
      const innerType = RAG_FILE_TYPES[ext];
      if (innerType && innerType !== "zip") {
        try {
          const innerBuffer = entry.getData();
          const innerText = await extractText(innerBuffer, innerType);
          if (innerText && innerText.trim()) {
            texts.push(`--- ${entry.entryName} ---\n${innerText}`);
          }
        } catch (e) { /* skip files that fail */ }
      }
    }
    return texts.join("\n\n") || "No supported files found in archive";
  }
  if (IMAGE_MIME[fileType]) {
    return await extractTextFromImage(buffer, IMAGE_MIME[fileType]);
  }
  throw new Error(`Unsupported file type: ${fileType}`);
}

// --- Chunking ---

function chunkText(text) {
  if (!text || text.trim().length === 0) return [];

  // Split on paragraph boundaries first
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 <= CHUNK_SIZE) {
      current += (current ? "\n\n" : "") + trimmed;
    } else {
      if (current) chunks.push(current);
      // If single paragraph exceeds chunk size, split on sentences
      if (trimmed.length > CHUNK_SIZE) {
        const sentences = trimmed.match(/[^.!?]+[.!?]+\s*/g) || [trimmed];
        let sentChunk = "";
        for (const sent of sentences) {
          if (sentChunk.length + sent.length <= CHUNK_SIZE) {
            sentChunk += sent;
          } else {
            if (sentChunk) chunks.push(sentChunk.trim());
            sentChunk = sent;
          }
        }
        if (sentChunk) current = sentChunk.trim();
      } else {
        current = trimmed;
      }
    }
  }
  if (current) chunks.push(current);

  // Add overlap: prepend last N chars from previous chunk
  const overlapped = chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const prev = chunks[i - 1];
    const overlap = prev.slice(-CHUNK_OVERLAP);
    return overlap + "\n\n" + chunk;
  });

  return overlapped;
}

// --- Semantic enrichment ---
// Prepends a topic/meaning summary to each chunk before embedding.
// The embedding then captures what the chunk is ABOUT, not just its keywords.
// Uses Qwen (free) so cost isn't a factor.

async function enrichChunks(chunks, fileName) {
  if (!DEEPINFRA_API_KEY) {
    console.log(`[RAG] No DEEPINFRA_API_KEY for enrichment, using raw chunks`);
    return chunks;
  }

  console.log(`[RAG] Enriching ${chunks.length} chunks from ${fileName}`);
  const enriched = new Array(chunks.length);

  // Enrichment is one LLM call per chunk and was running strictly
  // sequentially, so a folder of a few hundred documents took hours of
  // wall-clock (and any restart in that window lost the unfinished files).
  // Same token cost, ~8x faster, matching the email indexer's concurrency.
  const CONCURRENCY = 8;
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= chunks.length) return;
      const chunk = chunks[i];
      // Skip enrichment for very short chunks
      if (chunk.length < 50) {
        enriched[i] = chunk;
        continue;
      }
      enriched[i] = await enrichOneChunk(chunk, fileName);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

  console.log(`[RAG] Enrichment complete: ${enriched.filter(c => c && c.startsWith("[About:")).length}/${chunks.length} chunks enriched`);
  return enriched;
}

/** Contextualise one chunk. Returns the enriched text, or the raw chunk on any failure. */
async function enrichOneChunk(chunk, fileName) {
  try {
    const resp = await llmSlot(() => fetch(CHAT_URL, {
      method: "POST",
      // Without a timeout one hung call blocks a worker for the whole run
      signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPINFRA_API_KEY}` },
      body: JSON.stringify({
        model: ENRICH_MODEL,
        // Suppress model "thinking" so it does not eat the 200-token budget.
        // DeepSeek uses reasoning_effort, Qwen only respects its template kwarg.
        ...(ENRICH_MODEL.startsWith("deepseek") ? { reasoning_effort: "none" } : { chat_template_kwargs: { enable_thinking: false } }),
        messages: [{
          role: "user",
          content: `Describe what this text excerpt is about in 2-3 sentences. What topics does it cover? What questions could it answer? What concepts or entities does it mention? Be specific.\n\nFile: ${fileName}\nExcerpt:\n${chunk.substring(0, 2000)}`,
        }],
        max_tokens: 200,
        temperature: 0.1,
      }),
    }));
    if (resp.ok) {
      const data = await resp.json();
      let summary = data.choices?.[0]?.message?.content || "";
      summary = summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (summary) return `[About: ${summary}]\n\n${chunk}`;
    }
  } catch (e) {
    // Enrichment failed for this chunk, index it raw rather than losing it
  }
  return chunk;
}

// --- Embedding ---

/** Embed a batch of texts via Qwen3-Embedding (DeepInfra). Returns array of vectors. */
async function embedBatch(texts) {
  if (!DEEPINFRA_API_KEY || texts.length === 0) return [];
  try {
    const resp = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPINFRA_API_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts.map(t => t.substring(0, 8000)), encoding_format: "float" }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Embed error ${resp.status}: ${errText.substring(0, 200)}`);
    }
    const data = await resp.json();
    const sorted = (data.data || []).sort((a, b) => a.index - b.index);
    // Matryoshka truncation to EMBED_DIMS + L2 normalize
    return sorted.map(d => {
      const truncated = d.embedding.slice(0, EMBED_DIMS);
      const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0)) || 1;
      return truncated.map(v => v / norm);
    });
  } catch (e) {
    console.log(`[RAG] Embed batch failed: ${e.message}`);
    return [];
  }
}

/** Embed a single text. Returns vector array or null. */
async function embedSingle(text) {
  if (!text || !DEEPINFRA_API_KEY) return null;
  const results = await embedBatch([text]);
  return results[0] || null;
}

// --- Folder scanning ---

async function scanFolder(userId, origin, folderPath, opts = {}) {
  // origin says WHICH kind of store (gdrive/onedrive); account (a connection
  // service key) says WHICH account of it. Null account -> primary.
  const gKey = opts.account || "google";
  const msKey = opts.account || "microsoft";
  if (origin === "cloud") {
    const info = await _getSandboxInfo(userId);
    if (!info) throw new Error("Cloud Computer not active");
    const result = await _sandboxFetch(info, "POST", "/files/list", { path: folderPath });
    return (result.files || result || []).map(f => ({ name: f.name, type: f.type, size: f.size, modified: f.modified || f.mtime }));
  } else if (origin === "bridge") {
    let files = [];
    try {
      const result = await _bridgeRequest(userId, "files.list", { path: folderPath }, 15000);
      const rawFiles = result?.items || result?.files || (Array.isArray(result) ? result : []);
      files = rawFiles.map(f => ({ name: f.name, type: f.isDirectory || f.type === "directory" ? "directory" : "file", size: f.size || 0, modified: f.modified || f.modifiedDate || f.mtime }));
    } catch (e) { /* fall through to ls fallback */ }
    // Supplement with ls if files.list returned few results
    if (files.length < 5) {
      try {
        const cleanPath = folderPath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
        const lsPath = folderPath === "~" || folderPath === "~/" ? "$HOME" : `$HOME/${cleanPath}`;
        const lsResult = await _bridgeRequest(userId, "shell.run", { command: `ls -1p "${lsPath}" 2>/dev/null` }, 10000);
        const lsOut = (lsResult?.result?.stdout || lsResult?.stdout || "").trim();
        if (lsOut) {
          const existing = new Set(files.map(f => f.name));
          for (const line of lsOut.split("\n").filter(Boolean)) {
            const isDir = line.endsWith("/");
            const name = isDir ? line.slice(0, -1) : line;
            if (name && !name.startsWith(".") && !existing.has(name)) {
              files.push({ name, type: isDir ? "directory" : "file", size: 0, modified: null });
            }
          }
        }
      } catch (_) {}
    }
    return files;
  } else if (origin === "gdrive") {
    // Two modes. The folder browser wants one level (folders included) so the
    // user can navigate. Indexing wants everything underneath the chosen
    // folder: a single-level scan meant "index my Drive" indexed only the
    // files sitting loose in the root and silently ignored every subfolder.
    // Both modes paginate; the old 200-item single page truncated big folders.
    const MAX_FILES = parseInt(process.env.RAG_MAX_FILES || "2000", 10);
    const MAX_DEPTH = 8;
    const listPage = async (parentId, pageToken) => {
      const q = encodeURIComponent("'" + parentId + "' in parents and trashed = false");
      const fields = encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,size)");
      let url = "https://www.googleapis.com/drive/v3/files?q=" + q + "&fields=" + fields + "&pageSize=200";
      if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
      const resp = await fetchWithRefresh(userId, gKey, url);
      if (!resp.ok) throw new Error("Google Drive API error: " + resp.status);
      return resp.json();
    };
    const toEntry = (f) => ({
      name: f.name,
      type: f.mimeType === "application/vnd.google-apps.folder" ? "directory" : "file",
      size: parseInt(f.size) || 0,
      modified: f.modifiedTime,
      id: f.id,
      mimeType: f.mimeType,
    });

    const out = [];
    const queue = [{ id: folderPath || "root", depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      let pageToken = null;
      do {
        const data = await listPage(id, pageToken);
        for (const f of (data.files || [])) {
          const entry = toEntry(f);
          if (entry.type === "directory") {
            if (!opts.recursive) { out.push(entry); continue; } // browser shows folders
            if (depth < MAX_DEPTH) queue.push({ id: f.id, depth: depth + 1 });
            continue; // indexing traverses folders rather than listing them
          }
          out.push(entry);
        }
        pageToken = data.nextPageToken;
        if (out.length >= MAX_FILES) break;
      } while (pageToken);
      if (!opts.recursive) break; // browser: this folder only
      if (out.length >= MAX_FILES) break;
    }
    if (opts.recursive) {
      // Listing is cheap, indexing is not. Scan wide, then order by recency so
      // the indexing budget is spent on the files most likely to be searched
      // for; anything cut is the oldest, which is a defensible thing to lose.
      out.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
      if (out.length >= MAX_FILES) {
        console.log(`[RAG] gdrive scan hit the ${MAX_FILES}-file listing cap. Raise RAG_MAX_FILES to scan more.`);
      }
    }
    return out;
  } else if (origin === "onedrive") {
    const folderP = folderPath || "/";
    const url = folderP === "/"
      ? "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=200"
      : "https://graph.microsoft.com/v1.0/me/drive/root:" + folderP + ":/children?$top=200";
    const resp = await fetchWithRefresh(userId, msKey, url);
    if (!resp.ok) throw new Error("OneDrive API error: " + resp.status);
    const data = await resp.json();
    return (data.value || []).map(f => ({
      name: f.name,
      type: f.folder ? "directory" : "file",
      size: f.size || 0,
      modified: f.lastModifiedDateTime,
      id: f.id,
    }));
  } else if (origin === "dropbox") {
    const dropboxPath = folderPath || "";
    const token = await getServiceToken(userId, "dropbox");
    const resp = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ path: dropboxPath, limit: 200 }),
    });
    if (!resp.ok) throw new Error("Dropbox API error: " + resp.status);
    const data = await resp.json();
    return (data.entries || []).map(f => ({
      name: f.name,
      type: f[".tag"] === "folder" ? "directory" : "file",
      size: f.size || 0,
      modified: f.server_modified || null,
      id: f.id,
    }));
  }
  throw new Error("Unknown origin: " + origin);
}

// --- File content fetching ---

async function fetchFileContent(userId, origin, filePath, account) {
  const gKey = account || "google";
  const msKey = account || "microsoft";
  if (origin === "cloud") {
    const info = await _getSandboxInfo(userId);
    if (!info) throw new Error("Cloud Computer not active");
    const result = await _sandboxFetch(info, "POST", "/files/download", { path: filePath });
    return Buffer.from(result.content, result.encoding || "base64");
  } else if (origin === "bridge") {
    const result = await _bridgeRequest(userId, "files.read", { path: filePath, encoding: "base64" }, 30000);
    return Buffer.from(result.content, "base64");
  } else if (origin === "gdrive") {
    // filePath is the Drive file ID; fetch metadata to check for Google Docs types
    const metaResp = await fetchWithRefresh(userId, gKey,
      "https://www.googleapis.com/drive/v3/files/" + filePath + "?fields=mimeType,name");
    if (!metaResp.ok) throw new Error("Google Drive metadata error: " + metaResp.status);
    const meta = await metaResp.json();
    const googleDocTypes = [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ];
    let resp;
    if (googleDocTypes.includes(meta.mimeType)) {
      // Export as PDF for Google Docs/Sheets/Slides
      resp = await fetchWithRefresh(userId, gKey,
        "https://www.googleapis.com/drive/v3/files/" + filePath + "/export?mimeType=" + encodeURIComponent("application/pdf"));
    } else {
      resp = await fetchWithRefresh(userId, gKey,
        "https://www.googleapis.com/drive/v3/files/" + filePath + "?alt=media");
    }
    if (!resp.ok) throw new Error("Google Drive download error: " + resp.status);
    return Buffer.from(await resp.arrayBuffer());
  } else if (origin === "onedrive") {
    // filePath is the OneDrive item ID
    const resp = await fetchWithRefresh(userId, msKey,
      "https://graph.microsoft.com/v1.0/me/drive/items/" + filePath + "/content");
    if (!resp.ok) throw new Error("OneDrive download error: " + resp.status);
    return Buffer.from(await resp.arrayBuffer());
  } else if (origin === "dropbox") {
    // filePath is the full Dropbox path
    const token = await getServiceToken(userId, "dropbox");
    const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Dropbox-API-Arg": JSON.stringify({ path: filePath }),
      },
    });
    if (!resp.ok) throw new Error("Dropbox download error: " + resp.status);
    return Buffer.from(await resp.arrayBuffer());
  }
  throw new Error("Unknown origin: " + origin);
}

// --- Main processing pipeline ---

async function processDocument(documentId, userId, fileBuffer, fileName, fileType, sourceContext = null) {
  try {
    // Update status to processing
    await supabase.from("rag_documents").update({ status: "processing" }).eq("id", documentId);

    // 1. Extract text
    console.log(`[RAG] Extracting text from ${fileName} (${fileType})`);
    const text = await extractText(fileBuffer, fileType);
    if (!text || text.trim().length < 10) {
      throw new Error("No text content could be extracted from this file");
    }

    // 2. Chunk. Per-document ceiling so one enormous file cannot consume the
    // whole indexing budget: enrichment cost is per chunk, so a 500-page PDF
    // would otherwise cost as much as several hundred ordinary documents.
    let chunks = chunkText(text);
    const MAX_CHUNKS_PER_DOC = parseInt(process.env.RAG_MAX_CHUNKS_PER_DOC || "80", 10);
    if (chunks.length > MAX_CHUNKS_PER_DOC) {
      console.log(`[RAG] ${fileName}: ${chunks.length} chunks, indexing the first ${MAX_CHUNKS_PER_DOC}`);
      chunks = chunks.slice(0, MAX_CHUNKS_PER_DOC);
    }
    console.log(`[RAG] ${fileName}: ${text.length} chars -> ${chunks.length} chunks`);
    if (chunks.length === 0) throw new Error("No chunks produced from text");

    // 3. Enrich chunks with semantic summaries (Qwen, free)
    // This makes search match on meaning/topics, not just keywords
    const enrichedChunks = await enrichChunks(chunks, fileName);

    // 4. Embed enriched chunks in batches
    const allEmbeddings = [];
    for (let i = 0; i < enrichedChunks.length; i += EMBED_BATCH_SIZE) {
      const batch = enrichedChunks.slice(i, i + EMBED_BATCH_SIZE);
      console.log(`[RAG] Embedding batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}/${Math.ceil(enrichedChunks.length / EMBED_BATCH_SIZE)}`);
      const embeddings = await embedBatch(batch);
      allEmbeddings.push(...embeddings);
    }

    // Check user's data residency setting
    const { data: _profile } = await supabase.from("profiles").select("settings").eq("id", userId).single();
    const residency = _profile?.settings?.rag_residency || "standard";

    // 5. Insert chunks with embeddings (store original text, embed enriched version)
    const rows = chunks.map((content, idx) => ({
      document_id: documentId,
      user_id: userId,
      chunk_index: idx,
      content: residency === "zero" ? "[Zero residency - text not stored]" : content,
      embedding: JSON.stringify(allEmbeddings[idx]), // embedded from enriched version
      metadata: { source_file: fileName, chunk_of: chunks.length, ...(sourceContext || {}) },
    }));

    // Insert in batches of 50 to avoid payload limits
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const { error } = await supabase.from("rag_chunks").insert(batch);
      if (error) throw new Error(`Chunk insert failed: ${error.message}`);
    }

    // 5. Update document status
    await supabase.from("rag_documents").update({
      status: "ready",
      chunk_count: chunks.length,
      metadata: { word_count: text.split(/\s+/).length, char_count: text.length },
      updated_at: new Date().toISOString(),
    }).eq("id", documentId);

    console.log(`[RAG] ${fileName}: ready (${chunks.length} chunks)`);
    return { chunks: chunks.length };
  } catch (e) {
    console.error(`[RAG] Processing failed for ${fileName}:`, e.message);
    await supabase.from("rag_documents").update({
      status: "error",
      error_message: e.message,
      updated_at: new Date().toISOString(),
    }).eq("id", documentId);
    return { error: e.message };
  }
}

// --- Source processing pipeline ---

async function processSource(sourceId, userId, origin, folderPath, selectedFiles, account) {
  try {
    // 1. Update source status to indexing
    await supabase.from("rag_sources").update({ status: "indexing", updated_at: new Date().toISOString() }).eq("id", sourceId);

    // 2. Scan folder for files
    // recursive: indexing a folder means everything underneath it
    const files = await scanFolder(userId, origin, folderPath, { recursive: true, account });

    // Google Docs mimeTypes that we can export as PDF
    const GOOGLE_DOC_TYPES = [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ];

    // 3. Filter to supported file types
    let supported = files.filter(f => {
      if (f.type === "directory" || f.type === "dir") return false;
      // Google Docs/Sheets/Slides can be exported as PDF
      if (origin === "gdrive" && f.mimeType && GOOGLE_DOC_TYPES.includes(f.mimeType)) return true;
      const ext = path.extname(f.name).toLowerCase();
      return !!RAG_FILE_TYPES[ext];
    });

    // 3b. Filter to selected files if specified
    if (selectedFiles && selectedFiles.length > 0) {
      const selIds = new Set(selectedFiles.map(f => f.id));
      const selNames = new Set(selectedFiles.map(f => f.name));
      supported = supported.filter(f => {
        if (origin === "gdrive" && f.id) return selIds.has(f.id);
        return selNames.has(f.name);
      });
    }

    // 4. Get existing documents for this source
    const { data: existingDocs } = await supabase
      .from("rag_documents")
      .select("id, name, file_path, metadata, status")
      .eq("user_id", userId)
      .eq("source_id", sourceId);
    const existingMap = {};
    for (const doc of existingDocs || []) {
      if (doc.file_path) existingMap[doc.file_path] = doc;
    }

    let totalChunks = 0;
    const processedPaths = new Set();

    // 5. Process each supported file
    // Indexing budget, counted in CHUNKS because that is the unit that costs
    // money (one enrichment call each). A file count would be meaningless: a
    // folder of photos and a folder of long PDFs differ ~50x in cost for the
    // same number of files. Files are processed newest-first, so if the budget
    // runs out the oldest content is what goes unindexed.
    const CHUNK_BUDGET = parseInt(process.env.RAG_CHUNK_BUDGET || "3000", 10);
    let skippedForBudget = 0;
    let processed = 0;
    const retryQueue = [];

    // Live progress. Counts were only written when the whole source finished,
    // so a multi-minute run looked frozen at its previous totals with no way
    // to tell work from a stall. note carries the denominator (how many files
    // the scan found) since the row has no dedicated progress column.
    const publishProgress = async () => {
      await supabase.from("rag_sources").update({
        file_count: processed,
        chunk_count: totalChunks,
        error_message: `${processed} of ${supported.length} files indexed`,
        updated_at: new Date().toISOString(),
      }).eq("id", sourceId).then(() => {}, () => {});
    };
    await publishProgress();

    // Resolve the path of EVERY supported file up front. processedPaths drives
    // the "delete documents whose file disappeared" step below, so a file that
    // is merely skipped (budget, or unchanged) must still register as present,
    // otherwise the cleanup deletes a perfectly good index entry for it.
    const items = supported.map(file => {
      let filePath;
      if (origin === "gdrive") {
        filePath = file.id; // Drive file ID
      } else if (origin === "onedrive") {
        filePath = file.id; // OneDrive item ID
      } else if (origin === "dropbox") {
        filePath = (folderPath === "" ? "" : folderPath) + "/" + file.name; // Full Dropbox path
      } else {
        filePath = folderPath.replace(/\/$/, "") + "/" + file.name;
      }
      processedPaths.add(filePath);
      return { file, filePath };
    });

    const indexOne = async ({ file, filePath }) => {
      // Skip if unchanged AND successfully processed (has chunks)
      const existing = existingMap[filePath];
      if (existing && existing.metadata?.modified === file.modified && existing.status === "ready") {
        const { count } = await supabase.from("rag_chunks").select("id", { count: "exact", head: true }).eq("document_id", existing.id);
        if (count > 0) {
          totalChunks += count;
          return;
        }
      }

      // If there is an old version, delete its chunks (will be re-processed)
      if (existing) {
        await supabase.from("rag_chunks").delete().eq("document_id", existing.id);
        await supabase.from("rag_documents").delete().eq("id", existing.id);
      }

      // Fetch file content
      const ext = path.extname(file.name).toLowerCase();
      const fileType = (origin === "gdrive" && file.mimeType && GOOGLE_DOC_TYPES.includes(file.mimeType))
        ? "pdf" // Google Docs exported as PDF
        : RAG_FILE_TYPES[ext];
      let buffer;
      try {
        buffer = await fetchFileContent(userId, origin, filePath, account);
      } catch (e) {
        console.error(`[RAG] Failed to fetch ${filePath}:`, e.message);
        return;
      }

      // Create document record
      const { data: doc, error: docErr } = await supabase.from("rag_documents").insert({
        user_id: userId,
        source_id: sourceId,
        name: file.name,
        file_type: fileType,
        size_bytes: file.size || buffer.length,
        file_path: filePath,
        origin: origin,
        status: "pending",
        metadata: { modified: file.modified },
      }).select("id").single();

      if (docErr) {
        console.error(`[RAG] Doc insert failed for ${file.name}:`, docErr.message);
        return;
      }

      // Process the document. Isolated: one unreadable or slow file must not
      // abort the whole folder and leave every later file unindexed.
      try {
        const result = await processDocument(doc.id, userId, buffer, file.name, fileType, { origin, path: filePath });
        totalChunks += result.chunks || 0;
      } catch (fileErr) {
        console.error(`[RAG] ${file.name} failed, continuing with the rest:`, fileErr.message);
        await supabase.from("rag_documents")
          .update({ status: "error", error_message: String(fileErr.message).substring(0, 300) })
          .eq("id", doc.id).then(() => {}, () => {});
        // Transient failures (timeout, rate limit, provider blip) get one more
        // go at the end, when whatever was overloaded has had time to recover.
        // Without this a single slow moment permanently removes a file from
        // search with no signal to the user that it is missing.
        if (/timeout|abort|429|50\d|network|fetch failed/i.test(fileErr.message)) {
          retryQueue.push({ file, filePath, fileType, docId: doc.id });
        }
      }
    };

    // Files in parallel. Each file also enriches its own chunks in parallel,
    // so the shared llmSlot ceiling keeps the product of the two bounded
    // rather than letting 4 files x 8 chunks become a 32-call burst.
    const FILE_CONCURRENCY = parseInt(process.env.RAG_FILE_CONCURRENCY || "4", 10);
    let fileCursor = 0;
    const fileWorker = async () => {
      while (true) {
        const i = fileCursor++;
        if (i >= items.length) return;
        if (totalChunks >= CHUNK_BUDGET) { skippedForBudget++; continue; }
        try {
          await indexOne(items[i]);
        } catch (e) {
          console.error(`[RAG] Unexpected failure on ${items[i].file.name}:`, e.message);
        }
        processed++;
        await publishProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, items.length) }, fileWorker));

    // Second pass over transient failures
    for (const item of retryQueue) {
      if (totalChunks >= CHUNK_BUDGET) break;
      try {
        console.log(`[RAG] Retrying ${item.file.name}`);
        const buf = await fetchFileContent(userId, origin, item.filePath, account);
        const result = await processDocument(item.docId, userId, buf, item.file.name, item.fileType, { origin, path: item.filePath });
        totalChunks += result.chunks || 0;
        await publishProgress();
      } catch (e) {
        console.error(`[RAG] Retry failed for ${item.file.name}:`, e.message);
        await supabase.from("rag_documents")
          .update({ status: "error", error_message: `Failed twice: ${String(e.message).substring(0, 250)}` })
          .eq("id", item.docId).then(() => {}, () => {});
      }
    }

    // 6. Remove documents for files no longer in folder
    for (const [filePath, doc] of Object.entries(existingMap)) {
      if (!processedPaths.has(filePath)) {
        await supabase.from("rag_chunks").delete().eq("document_id", doc.id);
        await supabase.from("rag_documents").delete().eq("id", doc.id);
      }
    }

    // 7. Update source stats
    const { count: fileCount } = await supabase.from("rag_documents").select("id", { count: "exact", head: true }).eq("source_id", sourceId);
    await supabase.from("rag_sources").update({
      status: "ready",
      file_count: fileCount || 0,
      chunk_count: totalChunks,
      // Never truncate silently: if the budget stopped us, say so where the
      // user can see it rather than letting the index look complete.
      error_message: skippedForBudget > 0
        ? `Indexing budget reached (${totalChunks} chunks). ${skippedForBudget} older file(s) not indexed.`
        : null,
      last_indexed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", sourceId);

    console.log(`[RAG] Source ${sourceId}: ready (${fileCount} files, ${totalChunks} chunks${skippedForBudget ? `, ${skippedForBudget} skipped for budget` : ""})`);
  } catch (e) {
    console.error(`[RAG] processSource failed for ${sourceId}:`, e.message);
    await supabase.from("rag_sources").update({
      status: "error",
      error_message: e.message,
      updated_at: new Date().toISOString(),
    }).eq("id", sourceId);
  }
}

/**
 * Documents pinned at "processing" (webapp restarted mid-file, or a provider
 * call hung before the timeout existed) are never retried by the source-level
 * resume, so they sit unindexed and invisible forever. Mark them failed so
 * the next source run treats them as changed and re-processes them, and so
 * the user can see which files did not make it in.
 */
async function recoverStalledDocuments() {
  const STALL_MS = 20 * 60 * 1000;
  const cutoff = new Date(Date.now() - STALL_MS).toISOString();
  try {
    const { data: docs } = await supabase.from("rag_documents")
      .select("id, name").eq("status", "processing").lt("updated_at", cutoff);
    for (const d of (docs || [])) {
      await supabase.from("rag_documents")
        .update({ status: "error", error_message: "Indexing was interrupted (restart or provider timeout). Re-index to retry." })
        .eq("id", d.id);
      console.log(`[RAG] Recovered stalled document: ${d.name}`);
    }
  } catch (e) {
    console.error("[RAG] recoverStalledDocuments failed:", e.message);
  }
}

module.exports = { init, processDocument, processSource, scanFolder, fetchFileContent, extractText, chunkText, embedBatch, embedSingle, getServiceToken, fetchWithRefresh, recoverStalledDocuments };
