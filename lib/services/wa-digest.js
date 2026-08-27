// lib/services/wa-digest.js — one Context Note per WhatsApp chat per day.
//
// The raw messages land in data_cache as they arrive and are keyword-searchable
// immediately; that side needs nothing from this file. This is the meaning
// layer, and it deliberately does NOT work per message: a ten-word chat message
// has no standalone meaning, and embedding each one would pay per-message model
// costs to index noise. The unit of a chat is a stretch of conversation, so
// once a day each chat that had activity gets ONE summary and ONE embedding
// covering everything said in it.
//
// Rules agreed 2026-08-27 (OSS-PLAN session 9):
//   - forward-only: buckets exist from linking day on; historic chats stay
//     keyword-only, with no backfill and no opt-in button
//   - a day is digested only once it is COMPLETE in the user's timezone
//   - runs are idempotent and resumable: a bucket is skipped if its vector
//     already exists, so downtime is caught up on the next pass
//   - the expensive call (the LLM summary) degrades to the cheap one: if the
//     summariser is unavailable, the raw transcript is embedded instead and
//     the row is marked partially enriched rather than lost
//
// Self-host only in practice: the cloud edition never loads the linked-device
// adapter, so it never has whatsapp rows and every pass here no-ops.

const LOOKBACK_DAYS = 5;        // how far back a pass looks for undigested days
const MAX_BUCKETS_PER_RUN = 100;
const MIN_BUCKET_CHARS = 120;   // below this a day is chit-chat; keyword covers it
const MIN_BUCKET_MSGS = 3;
const TRANSCRIPT_CAP = 6000;    // chars of transcript handed to the summariser
const RUN_EVERY_MS = 60 * 60 * 1000;

let _running = false;
let _timer = null;

function dayInTz(iso, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(iso));
  } catch (_) {
    return String(iso).substring(0, 10);
  }
}

async function runWhatsAppDigest() {
  if (_running) return;
  _running = true;
  try {
    const { supabase } = require("../../user-store");

    // Who has WhatsApp rows at all. Self-host is one user; on anything bigger
    // this stays a bounded read of recent rows, not a table scan.
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const { data: rows, error } = await supabase
      .from("data_cache")
      .select("user_id, data")
      .eq("source", "whatsapp")
      .eq("type", "message")
      .gte("synced_at", cutoff)
      .limit(20000);
    if (error || !rows || rows.length === 0) return;

    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(r.data || {});
    }

    for (const [userId, msgs] of byUser) {
      await _digestForUser(supabase, userId, msgs);
    }
  } catch (e) {
    console.error(`[wa-digest] pass failed: ${e.message}`);
  } finally {
    _running = false;
  }
}

async function _digestForUser(supabase, userId, msgs) {
  const { data: profile } = await supabase
    .from("profiles").select("timezone").eq("id", userId).single();
  const tz = profile?.timezone || "Europe/London";
  const today = dayInTz(new Date().toISOString(), tz);

  // Bucket by (chat, local day). Today's bucket is still being written to, so
  // it waits for tomorrow's pass.
  const buckets = new Map();
  for (const m of msgs) {
    if (!m.chat || !m.date || !m.text) continue;
    const day = dayInTz(m.date, tz);
    if (day >= today) continue;
    const key = `${m.chat}|${day}`;
    if (!buckets.has(key)) buckets.set(key, { chat: m.chat, chat_name: m.chat_name, day, items: [] });
    buckets.get(key).items.push(m);
  }
  if (buckets.size === 0) return;

  // Skip buckets already digested. The external id is the idempotence key.
  const wanted = [...buckets.values()].map(b => `wa-day-${b.chat}-${b.day}`);
  const { data: existing } = await supabase
    .from("data_vectors").select("external_id")
    .eq("user_id", userId).eq("service", "whatsapp")
    .in("external_id", wanted);
  const done = new Set((existing || []).map(e => e.external_id));

  let processed = 0;
  for (const b of buckets.values()) {
    if (processed >= MAX_BUCKETS_PER_RUN) break;
    const extId = `wa-day-${b.chat}-${b.day}`;
    if (done.has(extId)) continue;

    b.items.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const totalChars = b.items.reduce((n, m) => n + (m.text || "").length, 0);

    // A day of "ok" and "on my way" is not a memory. The raw rows stay
    // keyword-searchable; there is just nothing here worth a fingerprint.
    if (b.items.length < MIN_BUCKET_MSGS && totalChars < MIN_BUCKET_CHARS) continue;

    // The self-chat is the user talking TO ClosedHand; those exchanges are
    // already conversation memory through the engine, and digesting them
    // again here would put the same dialogue into recall twice. A bucket
    // where every line is the user's own is that chat (or notes-to-self,
    // which keep keyword search and lose little).
    if (b.items.every(m => m.sender === "me")) continue;

    let transcript = b.items.map(m => `${m.sender}: ${m.text}`).join("\n");
    if (transcript.length > TRANSCRIPT_CAP) transcript = transcript.substring(0, TRANSCRIPT_CAP);

    const { cheapChat, embedDocument } = require("./usi");
    let summary = null;
    try {
      summary = await cheapChat(
        userId,
        "You summarise one day of a WhatsApp conversation in 2-3 sentences for long-term memory. Write it self-contained, past tense, with full names, specific objects and amounts, so a stranger could follow it months later. Output only the summary.",
        `Chat with ${b.chat_name || b.chat}, ${b.day}:\n\n${transcript}`,
        300,
      );
    } catch (_) { /* summariser down or over budget: fall through to raw */ }

    const enriched = !!summary;
    const content = `[WhatsApp ${b.chat_name || b.chat}, ${b.day}] ${summary || transcript.substring(0, 1800)}`;

    const embedding = await embedDocument(content).catch(() => null);
    // No embedding, no row: an unembedded vector row is unreachable by the
    // search it exists for, and leaving the bucket unwritten means the next
    // pass simply retries it.
    if (!embedding) continue;

    const { error: writeErr } = await supabase.from("data_vectors").upsert({
      user_id: userId,
      service: "whatsapp",
      item_type: "chat_day",
      external_id: extId,
      content: content.substring(0, 2000),
      embedding: JSON.stringify(embedding),
      enrichment_level: enriched ? "full" : "partial",
      source_metadata: {
        chat: b.chat, chat_name: b.chat_name || null, date: b.day,
        message_count: b.items.length,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service,external_id" });
    if (writeErr) {
      console.error(`[wa-digest] ${extId}: ${writeErr.message}`);
      continue;
    }
    processed++;
  }
  if (processed > 0) console.log(`[wa-digest] wrote ${processed} chat-day digest(s) for ${userId}`);
}

// Hourly, not at literal midnight: a pass only digests days that are complete
// in the user's timezone, so running often just means downtime is caught up
// quickly and every timezone gets its midnight within the hour.
function startWhatsAppDigest() {
  if (_timer) return;
  _timer = setInterval(() => runWhatsAppDigest().catch(() => {}), RUN_EVERY_MS);
  setTimeout(() => runWhatsAppDigest().catch(() => {}), 2 * 60 * 1000);
}

module.exports = { runWhatsAppDigest, startWhatsAppDigest };
