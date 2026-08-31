// lib/conversation.js — Conversation history, vectorisation, tool response compression

const ctx = require("./context");
const { saveStore } = require("./storage");
const { getInternalClient } = require("./llm");

function getConversation(userId) {
  if (!ctx.store.conversations[userId]) {
    ctx.store.conversations[userId] = [];
  }
  return ctx.store.conversations[userId];
}

// Raw turns leaving the window are archived to data_cache before anything else
// happens, under the same contract every other source follows: raw is kept
// forever and keyword-searchable, and the digest in data_vectors is a copy,
// never the sole survivor. Overflow used to be the one place an automatic
// process destroyed original text; now only the user deletes, and every
// deletion surface (/clear, thread delete, the dashboard wipes) removes these
// rows too. Deterministic ids (thread id plus running offset) make a retried
// archive an upsert no-op rather than a duplicate. Text only: attachment
// blocks become bracketed placeholders, so no image data lands here.
async function _archiveTurns(userId, threadId, turns) {
  const { supabase } = require("../user-store");
  const chat = threadId || "no-thread";
  const { count, error: countErr } = await supabase
    .from("data_cache")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("source", "conversation")
    .eq("data->>chat", chat);
  if (countErr) throw new Error(countErr.message);
  const base = count || 0;
  const now = new Date().toISOString();
  const textOf = (c) => typeof c === "string" ? c
    : Array.isArray(c)
      ? c.map(b => b && b.type === "text" ? b.text : `[${(b && b.type) || "attachment"}]`).join(" ")
      : "";
  const rows = turns.map((m, i) => ({
    user_id: userId,
    source: "conversation",
    type: "message",
    external_id: `conv-${chat}-${base + i}`,
    data: {
      chat,
      chat_name: "conversation",
      sender: m.role === "assistant" ? "ClosedHand" : "me",
      // The date is the archive moment, not the turn's: conversation messages
      // carry no timestamps, and an honest approximation beats an invented one.
      text: textOf(m.content).substring(0, 4000),
      date: now,
    },
    synced_at: now,
    received_at: now,
  })).filter(row => row.data.text);
  for (let i = 0; i < rows.length; i += 50) {
    const { error } = await supabase.from("data_cache")
      .upsert(rows.slice(i, i + 50), { onConflict: "user_id,source,external_id" });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

/**
 * Vectorise old messages when context window exceeds 75%.
 * Archives the raw turns to data_cache, summarises them, embeds the summary
 * into data_vectors, then removes them from the live window. The digest is a
 * copy; the raw survives in the cache.
 */
async function vectoriseOldMessages(userId, systemPrompt, tools, provider) {
  const { estimateContextTokens, estimateMessageTokens, getContextWindow } = require("./token-tracker");
  const conversation = getConversation(userId);

  const estimate = estimateContextTokens(conversation, systemPrompt, tools, provider);
  if (estimate.fillRate < 0.75) return;

  // Calculate how many messages to remove to get back to ~40% fill
  const contextWindow = getContextWindow(provider);
  const targetMessageTokens = Math.floor(0.40 * contextWindow) - estimate.breakdown.system - estimate.breakdown.tools - estimate.breakdown.reserved;

  let currentTokens = estimate.breakdown.messages;
  let removeCount = 0;
  for (let i = 0; i < conversation.length; i++) {
    if (currentTokens <= targetMessageTokens) break;
    currentTokens -= estimateMessageTokens(conversation[i]);
    removeCount++;
  }

  // Always keep at least the last 6 messages
  removeCount = Math.min(removeCount, Math.max(0, conversation.length - 6));
  if (removeCount < 3) return; // Not worth summarising fewer than 3 messages

  const toSummarise = conversation.slice(0, removeCount);

  // Raw first, always. If the archive cannot be written, nothing is trimmed
  // this round and the next message retries the whole pass: losing headroom
  // for a while beats destroying the only copy of what was said.
  try {
    await _archiveTurns(userId, ctx.activeThreadId, toSummarise);
  } catch (e) {
    console.error(`[Conversation] Raw archive failed, trim deferred: ${e.message}`);
    return;
  }

  try {
    const condensed = toSummarise
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[complex content]"}`)
      .join("\n");

    const { client: internalClient, model: internalModel } = getInternalClient(userId);
    const response = await internalClient.messages.create({
      model: internalModel,
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Summarise this conversation history in 2-3 short paragraphs. Write it as a self-contained overview a stranger could follow months later: full names for people and companies, explicit objects and amounts ("the £1,096 Hurlands pro forma", never "the invoice" or "he"), since the reader will have none of this conversation's context. Focus on key topics discussed, decisions made, and important context. CRITICAL: Frame EVERYTHING as completed/past - use past tense throughout. Never leave action items sounding open or pending. Be concise.\n\n${condensed}`,
      }],
    });

    const summary = response.content[0]?.text || "";
    if (!summary) {
      // Fallback: just trim
      ctx.store.conversations[userId] = conversation.slice(removeCount);
      saveStore();
      return;
    }

    // Add timestamp range to the summary
    const firstDate = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const summaryWithDate = `[Conversation from ${firstDate}]\n${summary}`;

    // Embed into data_vectors
    try {
      const { embedDocument } = require("./services/usi");
      const { supabase } = require("../user-store");
      const embedding = await embedDocument(summaryWithDate);
      if (embedding) {
        await supabase.from("data_vectors").upsert({
          user_id: userId,
          service: "memory",
          item_type: "conversation_summary",
          external_id: `conv_summary_${Date.now()}`,
          content: summaryWithDate.substring(0, 2000),
          embedding: JSON.stringify(embedding),
          enrichment_level: "full",
          source_metadata: {
            thread_id: ctx.activeThreadId || null,
            date: firstDate,
          },
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,service,external_id" });
      }
    } catch (e) {
      console.log(`[Conversation] Vector embed failed (non-blocking): ${e.message}`);
    }

    // Remove summarised messages from conversation
    ctx.store.conversations[userId] = conversation.slice(removeCount);
    saveStore();

    console.log(`[Conversation] Vectorised ${removeCount} old messages for user ${userId} (${conversation.length - removeCount} remaining)`);
  } catch (error) {
    console.error("[Conversation] Vectorisation error:", error.message);
    // The raw is already archived, so trimming here loses nothing. Trim only
    // what was archived: the old fallback cut to the last six messages,
    // discarding turns that had neither summary nor archive.
    ctx.store.conversations[userId] = conversation.slice(removeCount);
    saveStore();
  }
}

// Compress large tool responses that are no longer relevant to the conversation
const TOOL_RESPONSE_COMPRESS_THRESHOLD = 500; // Characters
const COMPRESS_EXCLUDE_RECENT = 4; // Don't touch the last N messages

async function compressToolResponses(userId) {
  const conversation = getConversation(userId);

  const searchRange = Math.max(0, conversation.length - COMPRESS_EXCLUDE_RECENT);
  const candidates = [];
  for (let i = 0; i < searchRange; i++) {
    const msg = conversation[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type !== "tool_result") continue;
        if (typeof block.content === "string" && block.content.startsWith("[Compressed]")) continue;

        let size = 0;
        let isMedia = false;
        if (typeof block.content === "string") {
          size = block.content.length;
        } else if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part.type === "image" || part.type === "document") {
              isMedia = true;
              size += (part.source?.data?.length || 0);
            } else if (part.type === "text") {
              size += (part.text?.length || 0);
            }
          }
        }

        if (size > TOOL_RESPONSE_COMPRESS_THRESHOLD || isMedia) {
          const preview = isMedia
            ? `[${block.content.find(p => p.type === "text")?.text || "media file"}]`
            : (typeof block.content === "string" ? block.content.substring(0, 200) : "[complex content]");
          candidates.push({ index: i, blockIndex: j, preview, isMedia });
        }
      }
    }
  }

  if (candidates.length === 0) return;

  let compressed = 0;
  const textCandidates = [];

  for (let c = 0; c < candidates.length; c++) {
    const { index, blockIndex, isMedia } = candidates[c];
    const block = conversation[index].content[blockIndex];

    if (isMedia) {
      const textPart = Array.isArray(block.content)
        ? block.content.find(p => p.type === "text")?.text || "media file"
        : "media file";
      block.content = `[Compressed] Previously viewed: ${textPart}`;
      compressed++;
    } else {
      textCandidates.push(candidates[c]);
    }
  }

  if (textCandidates.length > 0) {
    const recentUserMessages = conversation
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .slice(-5)
      .map((m) => m.content)
      .join("\n");

    try {
      const { client: internalClient, model: internalModel } = getInternalClient(userId);
      const numbered = textCandidates.map((c, i) => `${i + 1}. ${c.preview}`).join("\n");
      const response = await internalClient.messages.create({
        model: internalModel,
        max_tokens: 50,
        messages: [{
          role: "user",
          content: `Which of these tool responses is the user still likely asking about? Reply with ONLY the numbers that are still relevant, comma-separated. Reply "none" if none are relevant.

Recent user messages:
${recentUserMessages}

Tool responses:
${numbered}`,
        }],
      });

      const reply = response.content[0]?.text?.trim().toLowerCase() || "";
      const stillRelevant = new Set();
      if (reply !== "none") {
        const nums = reply.match(/\d+/g) || [];
        for (const n of nums) stillRelevant.add(parseInt(n, 10) - 1);
      }

      for (let c = 0; c < textCandidates.length; c++) {
        if (stillRelevant.has(c)) continue;

        const { index, blockIndex } = textCandidates[c];
        const block = conversation[index].content[blockIndex];

        try {
          const summary = await internalClient.messages.create({
            model: internalModel,
            max_tokens: 150,
            messages: [{
              role: "user",
              content: `Summarise this tool response in 1-2 sentences. Keep key facts, dates, names, numbers. No preamble.\n\n${block.content.substring(0, 3000)}`,
            }],
          });
          block.content = `[Compressed] ${summary.content[0]?.text || block.content.substring(0, 200)}`;
          compressed++;
        } catch (e) {
          block.content = `[Truncated] ${block.content.substring(0, 300)}...`;
          compressed++;
        }
      }
    } catch (error) {
      console.error("Tool compression error:", error.message);
    }
  }

  if (compressed > 0) {
    saveStore();
    console.log(`Compressed ${compressed} tool responses (${candidates.length - compressed} still relevant).`);
  }
}

// ============================================================================
// THREAD MANAGEMENT
// ============================================================================

async function archiveThread(userId) {
  const { supabase } = require("../user-store");
  const threadId = ctx.activeThreadId;
  if (!threadId) return null;

  const conversation = getConversation(userId);

  // Check if thread already has a title (from titleThread)
  const { data: existingThread } = await supabase.from("conversation_threads")
    .select("title").eq("id", threadId).single();
  let title = existingThread?.title || null;

  // Generate title if missing
  if (!title) {
    title = await _generateTitle(userId, conversation);
  }

  // Summarise and vector the full conversation before archiving
  if (conversation.length > 3) {
    try {
      const condensed = conversation
        .filter(m => typeof m.content === "string")
        .map(m => `${m.role}: ${m.content.substring(0, 500)}`)
        .join("\n");
      if (condensed.length > 50) {
        const { client: internalClient, model: internalModel } = getInternalClient(userId);
        const resp = await internalClient.messages.create({
          model: internalModel,
          max_tokens: 400,
          messages: [{ role: "user", content: `Summarise this conversation in 2-3 paragraphs. Focus on key topics, decisions, and outcomes. Past tense. Be concise.\n\n${condensed.substring(0, 8000)}` }],
        });
        const summary = resp.content[0]?.text || "";
        if (summary) {
          const dateStr = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          const summaryWithTitle = `[Thread: ${title}] [${dateStr}]\n${summary}`;
          try {
            const { embedDocument } = require("./services/usi");
            const embedding = await embedDocument(summaryWithTitle);
            if (embedding) {
              await supabase.from("data_vectors").upsert({
                user_id: userId,
                service: "memory",
                item_type: "thread_summary",
                external_id: `thread_${threadId}`,
                content: summaryWithTitle.substring(0, 2000),
                embedding: JSON.stringify(embedding),
                enrichment_level: "full",
                source_metadata: { thread_id: threadId, title, date: dateStr },
                updated_at: new Date().toISOString(),
              }, { onConflict: "user_id,service,external_id" });
            }
          } catch (e) { console.log(`[Conversation] Archive vector failed: ${e.message}`); }
        }
      }
    } catch (e) { console.log(`[Conversation] Archive summary failed: ${e.message}`); }
  }

  // Deactivate current thread
  await supabase.from("conversation_threads")
    .update({ is_active: false, title, updated_at: new Date().toISOString() })
    .eq("id", threadId);

  // Create new active thread
  const { data: newThread } = await supabase.from("conversation_threads")
    .insert({ user_id: userId, is_active: true, platform: ctx.activePlatform || "web" })
    .select("id")
    .single();

  const newId = newThread?.id || require("crypto").randomUUID();
  ctx.activeThreadId = newId;
  ctx.store.conversations[userId] = [];
  ctx.resetSurfacedNodes();

  return { oldTitle: title, newThreadId: newId };
}

async function switchThread(userId, threadId) {
  const { supabase } = require("../user-store");
  const currentThreadId = ctx.activeThreadId;

  if (currentThreadId && currentThreadId !== threadId) {
    const conversation = getConversation(userId);
    // Check if outgoing thread already has a title
    const { data: outgoing } = await supabase.from("conversation_threads")
      .select("title").eq("id", currentThreadId).single();
    let title = outgoing?.title || await _generateTitle(userId, conversation);

    await supabase.from("conversation_threads")
      .update({
        is_active: false,
        title,
        messages: conversation,
        updated_at: new Date().toISOString()
      })
      .eq("id", currentThreadId);

    // Vectorise outgoing thread so its content is searchable from the new thread
    if (conversation.length > 2) {
      _vectoriseThread(userId, currentThreadId, conversation).catch(() => {});
    }
  }

  const { data: thread } = await supabase.from("conversation_threads")
    .select("id, messages, title")
    .eq("id", threadId)
    .single();

  if (!thread) return null;

  await supabase.from("conversation_threads")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", threadId);

  ctx.activeThreadId = threadId;
  ctx.store.conversations[userId] = thread.messages || [];
  ctx.resetSurfacedNodes();

  return { title: thread.title, messageCount: (thread.messages || []).length };
}

async function getThreadList(userId, limit = 10) {
  const { supabase } = require("../user-store");
  const { data } = await supabase.from("conversation_threads")
    .select("id, title, is_active, messages, created_at, updated_at")
    .eq("user_id", userId)
    .eq("archived", false)
    .order("updated_at", { ascending: false })
    .limit(limit);
  // Add message_count computed from messages array, then strip raw messages
  return (data || []).map(t => ({
    id: t.id,
    title: t.title,
    is_active: t.is_active,
    message_count: Array.isArray(t.messages) ? t.messages.length : 0,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }));
}

async function deleteThread(userId, threadId) {
  const { supabase } = require("../user-store");
  await supabase.from("conversation_threads").delete().eq("id", threadId).eq("user_id", userId);

  // Delete means delete. The thread's distilled copies live on in vector
  // memory, keyed two ways: the archive summary under thread_<id>, and any
  // rolling summaries carrying the thread id in their metadata. Left behind,
  // a deleted conversation keeps surfacing through recall for ever, which is
  // the opposite of what the user just asked for. Attachments are deliberately
  // not touched: they are user artefacts with their own Files surface, not
  // part of the conversation record.
  await supabase.from("data_vectors").delete()
    .eq("user_id", userId).eq("service", "memory")
    .eq("external_id", `thread_${threadId}`);
  await supabase.from("data_vectors").delete()
    .eq("user_id", userId).eq("service", "memory")
    .in("item_type", ["conversation_summary", "thread_summary"])
    .eq("source_metadata->>thread_id", threadId);
  // And the raw turns the overflow archiver banked for this thread.
  {
    const { error } = await supabase.from("data_cache").delete()
      .eq("user_id", userId).eq("source", "conversation")
      .eq("data->>chat", threadId);
    if (error) console.error(`[Conversation] thread raw-archive delete failed: ${error.message}`);
  }

  if (ctx.activeThreadId === threadId) {
    const { data: newThread } = await supabase.from("conversation_threads")
      .insert({ user_id: userId, is_active: true, platform: ctx.activePlatform || "web" })
      .select("id").single();
    ctx.activeThreadId = newThread?.id || require("crypto").randomUUID();
    ctx.store.conversations[userId] = [];
  }
}

async function clearAllThreads(userId) {
  const { supabase } = require("../user-store");
  await supabase.from("conversation_threads").delete().eq("user_id", userId);

  // Every thread is going, so every distilled conversation memory goes with
  // it. Scoped by item_type so the wipe cannot touch fact mirrors or anything
  // else sharing the memory service.
  await supabase.from("data_vectors").delete()
    .eq("user_id", userId).eq("service", "memory")
    .in("item_type", ["conversation_summary", "thread_summary"]);
  // Every thread is going, so the overflow archiver's raw copies go with them.
  {
    const { error } = await supabase.from("data_cache").delete()
      .eq("user_id", userId).eq("source", "conversation");
    if (error) console.error(`[Conversation] raw-archive clear failed: ${error.message}`);
  }

  const { data: newThread } = await supabase.from("conversation_threads")
    .insert({ user_id: userId, is_active: true, platform: ctx.activePlatform || "web" })
    .select("id").single();
  ctx.activeThreadId = newThread?.id || require("crypto").randomUUID();
  ctx.store.conversations[userId] = [];
}

/**
 * Summarise and vectorise a thread's messages so they're searchable from other threads.
 * Fire-and-forget. Used when switching threads, auto-creating new threads, or archiving.
 */
async function _vectoriseThread(userId, threadId, messages) {
  if (!messages || messages.length < 3) return;
  const { supabase } = require("../user-store");

  // Check if this thread already has a vector
  const { data: existing } = await supabase.from("data_vectors")
    .select("id").eq("user_id", userId).eq("external_id", `thread_${threadId}`).single();
  if (existing) return; // Already vectorised

  try {
    const condensed = messages
      .filter(m => typeof m.content === "string")
      .map(m => `${m.role}: ${m.content.substring(0, 500)}`)
      .join("\n");
    if (condensed.length < 50) return;

    const { getInternalClient } = require("./llm");
    const { client, model } = getInternalClient(userId);
    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 400,
        messages: [{ role: "user", content: `Summarise this conversation in 2-3 paragraphs. Focus on key topics, decisions, and outcomes. Past tense. Be concise.\n\n${condensed.substring(0, 8000)}` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
    ]);
    let summary = resp.content?.[0]?.text || "";
    summary = summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!summary) return;

    // Get or generate title
    const { data: thread } = await supabase.from("conversation_threads")
      .select("title").eq("id", threadId).single();
    const title = thread?.title || "Conversation";
    const dateStr = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const summaryWithTitle = `[Thread: ${title}] [${dateStr}]\n${summary}`;

    const { embedDocument } = require("./services/usi");
    const embedding = await embedDocument(summaryWithTitle);
    if (embedding) {
      await supabase.from("data_vectors").upsert({
        user_id: userId,
        service: "memory",
        item_type: "thread_summary",
        external_id: `thread_${threadId}`,
        content: summaryWithTitle.substring(0, 2000),
        embedding: JSON.stringify(embedding),
        enrichment_level: "full",
        source_metadata: { thread_id: threadId, title, date: dateStr },
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,service,external_id" });
      console.log(`[Conversation] Vectorised thread ${threadId} for ${userId}`);
    }
  } catch (e) {
    console.log(`[Conversation] Thread vectorise failed: ${e.message}`);
  }
}

// Generate a short title for a thread using the LLM (fire-and-forget)
async function _generateTitle(userId, conversation) {
  try {
    const userMsgs = conversation
      .filter(m => m.role === "user" && typeof m.content === "string")
      .slice(0, 3)
      .map(m => m.content.substring(0, 200));
    if (userMsgs.length === 0) return "Chat, " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const { getInternalClient } = require("./llm");
    const { client, model } = getInternalClient(userId);
    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 30,
        messages: [{ role: "user", content: `Give this conversation a short title (3-6 words, no quotes):\n${userMsgs.join("\n")}` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
    ]);
    const title = (resp.content?.[0]?.text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return title || userMsgs[0].substring(0, 50);
  } catch (e) {
    // Fallback to first message
    const first = conversation.find(m => m.role === "user" && typeof m.content === "string");
    return first ? first.content.substring(0, 50) : "Chat, " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
}

/**
 * Generate and save a title for the current thread after the 3rd user message.
 * Called fire-and-forget after LLM response is sent.
 */
async function titleThread(userId) {
  const { supabase } = require("../user-store");
  const threadId = ctx.activeThreadId;
  if (!threadId) return;

  // Don't regenerate if title already exists
  const { data: thread } = await supabase.from("conversation_threads")
    .select("title").eq("id", threadId).single();
  if (thread?.title) return;

  // Only generate after 3+ user messages
  const conversation = getConversation(userId);
  const userMsgCount = conversation.filter(m => m.role === "user").length;
  if (userMsgCount < 3) return;

  const title = await _generateTitle(userId, conversation);
  await supabase.from("conversation_threads")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", threadId);
}

/**
 * Check if the bot should nudge the user to start a new thread.
 * Returns true if 30+ messages AND hasn't nudged in the last 7 days.
 */
function shouldNudgeNewThread(userId) {
  const conversation = getConversation(userId);
  if (conversation.length < 30) return false;
  const lastNudge = ctx.store.facts?.["_last-thread-nudge"];
  if (lastNudge) {
    const val = typeof lastNudge === "object" ? lastNudge.value : lastNudge;
    const nudgeDate = new Date(val);
    if (!isNaN(nudgeDate.getTime()) && Date.now() - nudgeDate.getTime() < 7 * 86400000) return false;
  }
  return true;
}

/**
 * Format a relative time string for thread listing.
 */
function formatRelativeTime(date) {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return "today";
  if (s < 172800) return "yesterday";
  if (s < 604800) return Math.floor(s / 86400) + " days ago";
  if (s < 2592000) return Math.floor(s / 604800) + " weeks ago";
  return new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

module.exports = {
  getConversation, vectoriseOldMessages, compressToolResponses,
  archiveThread, switchThread, getThreadList, deleteThread, clearAllThreads,
  titleThread, shouldNudgeNewThread, formatRelativeTime, _vectoriseThread,
  TOOL_RESPONSE_COMPRESS_THRESHOLD, COMPRESS_EXCLUDE_RECENT,
};
