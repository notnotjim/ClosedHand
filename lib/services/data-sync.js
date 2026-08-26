// lib/services/data-sync.js -- Background data cache sync service
// Syncs recent emails and calendar events from all connected sources into Supabase data_cache.
// Runs on timers, never blocks user message processing.

const ctx = require("../context");
const { acquireUserMutex } = require("../user-mutex");
const { UserStore, supabase } = require("../../user-store");
const { swapToCloudStore, syncAdapterBack, cleanupUserContext } = require("../storage");
const { isGoogleConnected, googleApiRequest, loadGoogleTokens, listGoogleAccounts, markGoogleScopeFailure } = require("./google");
const { isMicrosoftConnected, microsoftApiRequest, listMicrosoftAccounts } = require("./microsoft");
const { bridgeRequest } = require("./bridge-relay");

// --- Gmail body extraction (full body variant, not truncated) ---
const cheerio = require("cheerio");

function stripHtml(html) {
  if (!html) return "";
  try {
    const $ = cheerio.load(html);
    $("script, style, head").remove();
    let text = $.text();
    text = text.split("\n").filter(line => !line.trimStart().startsWith(">")).join("\n");
    const sigIdx = text.indexOf("\n-- \n");
    if (sigIdx > 0) text = text.substring(0, sigIdx);
    const discIdx = text.search(/CONFIDENTIALITY NOTICE|DISCLAIMER|This email.*is intended/i);
    if (discIdx > 0) text = text.substring(0, discIdx);
    text = text.replace(/\s+/g, " ").trim();
    return text;
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function extractGmailBodyFull(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractGmailBodyFull(part);
      if (result) return result;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    const html = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    return stripHtml(html);
  }
  return "";
}

// Metadata only, never the bytes: knowing a message has "invoice.pdf" and
// "Screenshot 16.47.28.jpg" costs a few dozen characters per email, while the
// images themselves would be megabytes in the cache and thousands of tokens in
// every prompt that touched them. Fetch the content on demand, when it matters.
function extractGmailAttachments(payload, out = []) {
  if (!payload) return out;
  const headers = payload.headers || [];
  const cid = headers.find(h => h.name.toLowerCase() === "content-id")?.value || null;
  const disposition = headers.find(h => h.name.toLowerCase() === "content-disposition")?.value || "";

  if (payload.filename && payload.body?.attachmentId) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType || "application/octet-stream",
      size: payload.body.size || 0,
      attachmentId: payload.body.attachmentId,
      // Inline parts are the images sitting in the body text, which is what a
      // reader sees as part of the message rather than as a separate file.
      inline: /inline/i.test(disposition) || Boolean(cid),
    });
  }
  for (const part of payload.parts || []) extractGmailAttachments(part, out);
  return out;
}

function getGmailHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

// --- Concurrency limiter ---
function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    while (active < concurrency && queue.length > 0) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => { active--; next(); });
    }
  }
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// Supabase caps selects at 1000 rows; dedup ID sets MUST paginate or items past
// row 1000 look "new" every sync and get re-fetched/re-embedded (cost incident 2026-07-19)
async function fetchCachedIds(userId, source, type) {
  const ids = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await supabase
      .from("data_cache")
      .select("external_id")
      .eq("user_id", userId)
      .eq("source", source)
      .eq("type", type)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`cached-id fetch failed: ${error.message}`);
    for (const r of (page || [])) ids.add(r.external_id);
    if (!page || page.length < PAGE) break;
  }
  return ids;
}

// --- Timeout wrapper ---
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ============================================================================
// UPSERT + EVICTION
// ============================================================================

async function upsertCacheItems(userId, source, type, items) {
  if (!items || items.length === 0) return;

  // No embedding here, deliberately. data_cache used to carry its own 768-dim
  // vector per email, written on every sync (one API call per message, with
  // rate-limit sleeps) and read by exactly one RPC, match_cached_emails, whose
  // last caller was removed when explicit search moved to usi.search. The
  // proper 1536-dim embedding lives in data_vectors via the USI indexer; this
  // one cost every sync real time and money to keep an index nothing read.
  const rows = items.map((item) => {
    const row = {
      user_id: userId,
      source,
      type,
      external_id: String(item.external_id || item.id || ""),
      data: item,
      synced_at: new Date().toISOString(),
      received_at: (() => {
        if (!item.date) return null;
        let d = new Date(item.date);
        if (!isNaN(d.getTime())) return d.toISOString();
        const cleaned = String(item.date).replace(/^\w+,\s*/, "").replace(" at ", " ");
        d = new Date(cleaned);
        return isNaN(d.getTime()) ? null : d.toISOString();
      })(),
    };
    return row;
  });

  // Batch upsert in chunks of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase
      .from("data_cache")
      .upsert(batch, { onConflict: "user_id,source,external_id" });
    if (error) {
      console.error(`[data-sync] Upsert error for ${source}/${type}: ${error.message}`);
    }
  }
}

/**
 * Remove cached events that Google no longer returns for a window we fully
 * synced. Only ever deletes inside that window, and only ids that were absent
 * from a complete fetch, so a shortened sync cannot wipe real events.
 */
async function reconcileDeletedEvents(userId, source, items, windowStart, windowEnd, syncedCalendars) {
  try {
    const liveIds = new Set(items.map(i => String(i.external_id || i.id || "")));

    const { data: cached, error } = await supabase
      .from("data_cache")
      // Plain columns only: the self-host Postgres shim does not speak
      // PostgREST's "alias:expression" select, so asking for
      // calendar:data->>calendar made every reconcile fail with
      // column "calendar:data" does not exist, on every calendar source.
      // Reading the json and picking the field in JS works on both.
      .select("external_id, data")
      .eq("user_id", userId)
      .eq("source", source)
      .eq("type", "event")
      .gte("received_at", windowStart.toISOString())
      .lte("received_at", windowEnd.toISOString());

    if (error) {
      console.error(`[data-sync] Reconcile read failed for ${source}: ${error.message}`);
      return;
    }

    const gone = (cached || [])
      // Only judge calendars this run actually read. Anything else is unknown,
      // not deleted, and unknown must never mean delete.
      .filter(r => !syncedCalendars || !r.data?.calendar || syncedCalendars.has(r.data.calendar))
      .map(r => r.external_id)
      .filter(id => id && !liveIds.has(id));
    if (gone.length === 0) return;

    for (let i = 0; i < gone.length; i += 100) {
      const chunk = gone.slice(i, i + 100);
      await supabase.from("data_cache").delete()
        .eq("user_id", userId).eq("source", source).eq("type", "event").in("external_id", chunk);
      // The semantic index holds its own copy, so a deleted event would still
      // surface through recall even once the cache row is gone.
      await supabase.from("data_vectors").delete()
        .eq("user_id", userId).eq("service", "calendar").in("external_id", chunk);
    }
    console.log(`[data-sync] GCal: removed ${gone.length} deleted event(s) for ${userId} (${source})`);
  } catch (e) {
    console.error(`[data-sync] Reconcile failed for ${source}: ${e.message}`);
  }
}

async function evictOldItems(userId, source, type, keepCount) {
  // Get IDs to keep (most recent by received_at)
  const { data: keep, error: keepErr } = await supabase
    .from("data_cache")
    .select("id")
    .eq("user_id", userId)
    .eq("source", source)
    .eq("type", type)
    .order("received_at", { ascending: false })
    .limit(keepCount);

  if (keepErr) {
    console.error(`[data-sync] Eviction query error: ${keepErr.message}`);
    return;
  }

  if (!keep || keep.length < keepCount) return; // Nothing to evict

  const keepIds = keep.map(r => r.id);

  // Delete everything not in the keep set
  const { error: delErr } = await supabase
    .from("data_cache")
    .delete()
    .eq("user_id", userId)
    .eq("source", source)
    .eq("type", type)
    .not("id", "in", `(${keepIds.join(",")})`);

  if (delErr) {
    console.error(`[data-sync] Eviction delete error: ${delErr.message}`);
  }
}

// ============================================================================
// GMAIL SYNC
// ============================================================================

async function syncGmail(userId, userStore, serviceKey = "google", sourceTag = "gmail") {
  if (!loadGoogleTokens(userStore, serviceKey)) return;
  // Which mailbox these belong to. Without it a cached draft says nothing about
  // where it lives, so a write defaults to the primary account and lands in the
  // wrong inbox, which is exactly how an edit to a draft on one account created
  // a new draft on another.
  const accountEmail = userStore?.getConnection?.(serviceKey)?.metadata?.email || null;

  try {
    // Get IDs already in cache to avoid re-fetching (paginated: >1000 rows)
    const cachedIds = await fetchCachedIds(userId, sourceTag, "email");

    // Fetch recent inbox AND sent message IDs (both needed for thread context)
    // Drafts matter as much as received mail: an unsent reply is the clearest
    // signal the user owes someone an answer, and without it "what is
    // outstanding" silently misses the thing they are most likely chasing.
    const [inboxData, sentData, draftData] = await Promise.all([
      withTimeout(googleApiRequest("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&labelIds=INBOX", null, userStore, serviceKey), 20000, "Gmail inbox"),
      withTimeout(googleApiRequest("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=300&labelIds=SENT", null, userStore, serviceKey), 20000, "Gmail sent"),
      // drafts.list, not messages?labelIds=DRAFT. A draft has TWO ids: the
      // message id, which is what the messages endpoint returns, and the draft
      // id, which is the only one drafts.update accepts. Caching the message id
      // and calling it the draft is why editing a draft 404'd and the agent
      // ended up creating a new draft just to have an id that worked.
      withTimeout(googleApiRequest("GET", "https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=100", null, userStore, serviceKey), 45000, "Gmail drafts")
        .catch((e) => {
          // Say it out loud. A silent catch here would look identical to "this
          // account has no drafts", which is the failure mode that hid the
          // missing reply in the first place.
          console.error(`[data-sync] Gmail(${sourceTag}) drafts fetch failed: ${e.message}`);
          // failed, not empty. Anything that reasons about which drafts exist
          // has to be able to tell those two apart, because treating a timeout
          // as an empty mailbox means concluding every draft was deleted.
          return { drafts: [], failed: true };
        }),
    ]);
    // drafts.list returns { id: <draft id>, message: { id: <message id> } }
    const draftIdByMessage = {};
    for (const d of (draftData.drafts || [])) {
      if (d?.message?.id) draftIdByMessage[d.message.id] = d.id;
    }
    const draftIds = new Set(Object.keys(draftIdByMessage));
    const allIds = [...new Set([
      ...(inboxData.messages || []).map(m => m.id),
      ...(sentData.messages || []).map(m => m.id),
      ...draftIds,
    ])];

    // Before the early return below, which is exactly the path taken when every
    // draft has been deleted and there is nothing new to fetch.
    //
    // Only when this run actually saw the whole draft list. A timed-out fetch
    // returns nothing, and a truncated one returns some, and in both cases the
    // drafts not mentioned are unknown rather than deleted.
    if (!draftData.failed && !draftData.nextPageToken) {
      await reconcileDeletedDrafts(userId, sourceTag, new Set(allIds));
    } else if (draftData.failed) {
      console.log(`[data-sync] Gmail(${sourceTag}): draft list unavailable, skipping draft reconcile`);
    }

    // Only fetch details for messages NOT already in cache. Drafts are the
    // exception and are always re-fetched: a sent message never changes, but a
    // draft is edited constantly, so caching one once and skipping it forever
    // means holding wording the user has since rewritten. It is also why adding
    // draft_id did not reach any existing draft.
    const newIds = allIds.filter(id => !cachedIds.has(id) || draftIds.has(id));

    if (newIds.length === 0 && draftIds.size === 0) {
      // Counts included, because "all cached" on an account that is actually
      // receiving mail means the API is handing back a stale or partial list,
      // and that is invisible when the line only reports a single total.
      console.log(`[data-sync] Gmail(${sourceTag}): ${allIds.length} messages (${(inboxData.messages || []).length} inbox, ${(sentData.messages || []).length} sent, ${draftIds.size} drafts), all cached. No new fetches needed.`);
      return;
    }

    console.log(`[data-sync] Syncing Gmail(${sourceTag}) for ${userId}: ${newIds.length} new of ${allIds.length} total`);

    // Fetch full message details only for NEW messages
    const limit = pLimit(10);
    const results = await Promise.allSettled(
      newIds.map(id => limit(() =>
        withTimeout(
          googleApiRequest("GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, null, userStore, serviceKey),
          10000, "Gmail fetch"
        )
      ))
    );

    const items = [];
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const detail = result.value;
      const headers = detail.payload?.headers || [];
      let body = extractGmailBodyFull(detail.payload);
      if (body.length > 10000) body = body.substring(0, 10000);

      items.push({
        external_id: detail.id,
        id: detail.id,
        threadId: detail.threadId,
        from: getGmailHeader(headers, "From"),
        to: getGmailHeader(headers, "To"),
        subject: getGmailHeader(headers, "Subject"),
        date: getGmailHeader(headers, "Date"),
        messageId_header: getGmailHeader(headers, "Message-ID"),
        snippet: detail.snippet,
        body,
        labels: detail.labelIds,
        // Explicit rather than leaving it to be inferred from the label list: an
        // unsent draft is an outstanding action, not a message that happened.
        is_draft: (detail.labelIds || []).includes("DRAFT"),
        // The id gmail_draft_update needs. Null for anything that is not a draft.
        draft_id: draftIdByMessage[detail.id] || null,
        account: accountEmail,
        attachments: extractGmailAttachments(detail.payload),
      });
    }

    await upsertCacheItems(userId, sourceTag, "email", items);
    await evictOldItems(userId, sourceTag, "email", 5000);
    console.log(`[data-sync] Gmail(${sourceTag}): synced ${items.length} messages for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] Gmail(${sourceTag}) sync error for ${userId}: ${e.message}`);
    await markGoogleScopeFailure(e, userStore, serviceKey);
  }
}

/**
 * Remove cached drafts that no longer exist in Gmail.
 *
 * Calendar events have had this since deleted events kept surfacing; drafts
 * never did, so a draft deleted in Gmail stayed in the cache forever. That is
 * not merely untidy: ClosedHand reads the cache to find a draft's id, so it
 * would offer to delete, or try to edit, something that had not existed for
 * days.
 *
 * A row is only removed when its message id is absent from everything this run
 * saw live. Vanishing from drafts.list alone is not enough, because that is
 * also what happens when a draft is sent, and a sent mail must be kept.
 */
async function reconcileDeletedDrafts(userId, source, liveMessageIds) {
  try {
    const { data: cached, error } = await supabase
      .from("data_cache")
      .select("external_id")
      .eq("user_id", userId)
      .eq("source", source)
      .eq("type", "email")
      .not("data->>draft_id", "is", null);

    if (error) {
      console.error(`[data-sync] Draft reconcile read failed for ${source}: ${error.message}`);
      return;
    }

    const gone = (cached || []).map(r => r.external_id).filter(id => id && !liveMessageIds.has(id));
    if (gone.length === 0) return;

    for (let i = 0; i < gone.length; i += 100) {
      const chunk = gone.slice(i, i + 100);
      await supabase.from("data_cache").delete()
        .eq("user_id", userId).eq("source", source).eq("type", "email").in("external_id", chunk);
      // The semantic index keeps its own copy, so recall would still return it.
      await supabase.from("data_vectors").delete()
        .eq("user_id", userId).eq("service", "email").in("external_id", chunk);
    }
    console.log(`[data-sync] Gmail(${source}): removed ${gone.length} deleted draft(s) for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] Draft reconcile failed for ${source}: ${e.message}`);
  }
}

// ============================================================================
// GOOGLE CALENDAR SYNC
// ============================================================================

async function syncGoogleCalendar(userId, userStore, serviceKey = "google", sourceTag = "gcal") {
  if (!loadGoogleTokens(userStore, serviceKey)) return;
  console.log(`[data-sync] Syncing Google Calendar(${sourceTag}) for ${userId}`);

  try {
    const now = new Date();
    const start = new Date(now.getTime() - 365 * 86400000);
    const end = new Date(now.getTime() + 365 * 86400000);
    const timeMin = encodeURIComponent(start.toISOString());
    const timeMax = encodeURIComponent(end.toISOString());

    // The Google grant is deliberately events-only (see the OAuth scope note in
    // the webapp): it reads and writes events but cannot enumerate calendars, so
    // a calendarList call always 403s. Sync the primary calendar directly, which
    // is addressable without the list, rather than make a doomed call and log
    // its failure every cycle. Beyond-primary calendars are holiday calendars
    // and other noise the product intentionally leaves out.
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&maxResults=2500&singleEvents=true&orderBy=startTime`;
    const data = await withTimeout(googleApiRequest("GET", url, null, userStore, serviceKey), 15000, "GCal primary");
    const items = (data.items || [])
      .filter(e => e.status !== "cancelled")
      .map(e => ({
        external_id: e.id, id: e.id, summary: e.summary,
        start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
        location: e.location || null,
        description: e.description ? e.description.substring(0, 5000) : null,
        attachments: (e.attachments || []).map(a => ({ name: a.title || "", url: a.fileUrl || "", fileId: a.fileId || "" })).filter(a => a.name || a.url),
        attendees: (e.attendees || []).map(a => ({ email: a.email, name: a.displayName || "", status: a.responseStatus || "" })),
        status: e.status, calendar: "primary", uid: e.iCalUID || e.id, date: e.start?.dateTime || e.start?.date,
      }));

    await upsertCacheItems(userId, sourceTag, "event", items);
    // The date range scopes what we FETCH, but upsert only adds and updates, so
    // an event deleted in Google would stay cached forever and keep being
    // reported as upcoming. Anything inside the window we just synced that
    // Google did not return has been deleted there, so drop it here too.
    await reconcileDeletedEvents(userId, sourceTag, items, start, end, new Set(["primary"]));
    console.log(`[data-sync] GCal: synced ${items.length} events for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] GCal sync error for ${userId}: ${e.message}`);
    await markGoogleScopeFailure(e, userStore, serviceKey);
  }
}

// ============================================================================
// MICROSOFT OUTLOOK SYNC
// ============================================================================

async function syncOutlookMail(userId, userStore, serviceKey = "microsoft", sourceTag = "outlook") {
  if (!isMicrosoftConnected(userStore, serviceKey)) return;

  try {
    // Check what's already cached (paginated: >1000 rows)
    const cachedIds = await fetchCachedIds(userId, sourceTag, "email");

    // Fetch inbox + sent for thread context
    const [inboxData, sentData] = await Promise.all([
      withTimeout(microsoftApiRequest("GET", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=500&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments,internetMessageId&$orderby=receivedDateTime desc", null, userStore, serviceKey), 20000, "Outlook inbox"),
      withTimeout(microsoftApiRequest("GET", "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$top=300&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments,internetMessageId&$orderby=receivedDateTime desc", null, userStore, serviceKey), 20000, "Outlook sent").catch(() => ({ value: [] })),
    ]);
    const data = { value: [...(inboxData.value || []), ...(sentData.value || [])] };

    const items = (data.value || []).map(msg => {
      let body = msg.body?.content || msg.bodyPreview || "";
      if (msg.body?.contentType === "html") body = stripHtml(body);
      if (body.length > 10000) body = body.substring(0, 10000);

      return {
        external_id: msg.id,
        id: msg.id,
        from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ""} <${msg.from.emailAddress.address}>` : "",
        to: (msg.toRecipients || []).map(r => r.emailAddress?.address || "").join(", "),
        subject: msg.subject || "",
        date: msg.receivedDateTime || "",
        messageId_header: msg.internetMessageId || "",
        body,
        snippet: (msg.bodyPreview || "").substring(0, 200),
      };
    });

    // Only upsert items not already in cache
    const newItems = items.filter(i => !cachedIds.has(i.external_id));
    if (newItems.length === 0) {
      console.log(`[data-sync] Outlook: ${items.length} messages, all cached.`);
      return;
    }
    await upsertCacheItems(userId, sourceTag, "email", newItems);
    await evictOldItems(userId, sourceTag, "email", 5000);
    console.log(`[data-sync] Outlook: ${newItems.length} new of ${items.length} total for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] Outlook mail sync error for ${userId}: ${e.message}`);
  }
}

// ============================================================================
// MICROSOFT OUTLOOK CALENDAR SYNC
// ============================================================================

async function syncOutlookCalendar(userId, userStore, serviceKey = "microsoft", sourceTag = "mscal") {
  if (!isMicrosoftConnected(userStore, serviceKey)) return;
  console.log(`[data-sync] Syncing Outlook Calendar(${sourceTag}) for ${userId}`);

  try {
    const now = new Date();
    const start = new Date(now.getTime() - 365 * 86400000).toISOString();
    const end = new Date(now.getTime() + 365 * 86400000).toISOString();
    const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=1000&$select=id,subject,start,end,location,attendees,bodyPreview,hasAttachments,iCalUId`;

    const data = await withTimeout(microsoftApiRequest("GET", url, null, userStore, serviceKey), 15000, "Outlook Calendar");

    const items = (data.value || []).map(e => ({
      external_id: e.id,
      id: e.id,
      summary: e.subject || "",
      start: e.start?.dateTime ? e.start.dateTime + (e.start.timeZone === "UTC" ? "Z" : "") : "",
      end: e.end?.dateTime ? e.end.dateTime + (e.end.timeZone === "UTC" ? "Z" : "") : "",
      location: e.location?.displayName || null,
      description: e.bodyPreview ? e.bodyPreview.substring(0, 500) : null,
      attendees: (e.attendees || []).map(a => a.emailAddress?.address || ""),
      status: e.responseStatus?.response || "",
      calendar: "Outlook",
      uid: e.iCalUId || e.id,
      date: e.start?.dateTime || "",
    }));

    await upsertCacheItems(userId, "outlook_cal", "event", items);
    // No eviction cap for calendar events
    console.log(`[data-sync] Outlook Calendar: synced ${items.length} events for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] Outlook Calendar sync error for ${userId}: ${e.message}`);
  }
}

// ============================================================================
// SLACK SYNC — recent messages from channels/DMs, indexed for semantic recall
// ============================================================================

async function syncSlack(userId, userStore) {
  const conn = userStore.getConnection("slack");
  const token = conn?.access_token;
  if (!token) return;

  const api = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `Slack API ${r.status}`);
    return j;
  };

  try {
    // Resolve user IDs to real names so messages are searchable by person
    const userMap = {};
    try {
      const users = await api("https://slack.com/api/users.list?limit=200");
      for (const u of (users.members || [])) userMap[u.id] = u.profile?.real_name || u.real_name || u.name || u.id;
    } catch (_) {}

    const convs = await api("https://slack.com/api/conversations.list?types=public_channel,private_channel,im,mpim&exclude_archived=true&limit=100");
    const channels = (convs.channels || []).filter(c => c.is_member !== false).slice(0, 25);

    const items = [];
    const threadCandidates = [];
    for (const ch of channels) {
      try {
        const hist = await api(`https://slack.com/api/conversations.history?channel=${ch.id}&limit=50`);
        const chName = ch.is_im ? `DM with ${userMap[ch.user] || ch.user || "unknown"}` : `#${ch.name || ch.id}`;
        for (const m of (hist.messages || [])) {
          if (!m.text || m.subtype) continue; // skip joins, bot notices, etc.
          items.push({
            external_id: `${ch.id}_${m.ts}`,
            id: `${ch.id}_${m.ts}`,
            _channelId: ch.id,
            ts: m.ts,
            channel: chName,
            from: userMap[m.user] || m.user || m.username || "",
            text: m.text.substring(0, 4000),
            thread_ts: m.thread_ts || null,
            reply_count: m.reply_count || 0,
            date: new Date(parseFloat(m.ts) * 1000).toISOString(),
          });
          if (m.reply_count > 0 && (!m.thread_ts || m.thread_ts === m.ts)) {
            threadCandidates.push({ chId: ch.id, chName, ts: m.ts, reply_count: m.reply_count, latest_reply: m.latest_reply || m.ts });
          }
        }
      } catch (_) { /* not_in_channel etc. — skip this conversation */ }
    }
    if (items.length === 0) return;

    // Thread replies: fetch only threads whose reply_count changed since last sync,
    // most recently active first, capped per cycle to respect Slack rate limits.
    const threadVecItems = [];
    if (threadCandidates.length > 0) {
      const parentIds = threadCandidates.map(t => `${t.chId}_${t.ts}`);
      const cachedCounts = {};
      try {
        const { data: cachedParents } = await supabase.from("data_cache")
          .select("external_id, data").eq("user_id", userId).eq("source", "slack")
          .in("external_id", parentIds.slice(0, 200));
        for (const c of (cachedParents || [])) cachedCounts[c.external_id] = c.data?.reply_count || 0;
      } catch (_) {}

      const toFetch = threadCandidates
        .filter(t => (cachedCounts[`${t.chId}_${t.ts}`] || 0) !== t.reply_count)
        .sort((a, b) => String(b.latest_reply).localeCompare(String(a.latest_reply)))
        .slice(0, 15);

      const GAP_MS_T = 30 * 60 * 1000;
      for (const t of toFetch) {
        try {
          const rep = await api(`https://slack.com/api/conversations.replies?channel=${t.chId}&ts=${t.ts}&limit=30`);
          const msgs = (rep.messages || []).filter(m => m.text && !m.subtype).map(m => ({
            external_id: `${t.chId}_${m.ts}`,
            id: `${t.chId}_${m.ts}`,
            _channelId: t.chId,
            ts: m.ts,
            channel: t.chName,
            from: userMap[m.user] || m.user || m.username || "",
            text: m.text.substring(0, 4000),
            thread_ts: m.thread_ts || null,
            reply_count: m.reply_count || 0,
            date: new Date(parseFloat(m.ts) * 1000).toISOString(),
          }));
          if (msgs.length === 0) continue;
          for (const m of msgs) items.push(m); // replies join the raw cache (upsert dedups parents)
          const convo = msgs.map(m => `[${m.from}]: ${m.text}`).join("\n").substring(0, 8000);
          const lastTime = new Date(msgs[msgs.length - 1].date).getTime();
          threadVecItems.push({
            external_id: `${t.chId}_thread_${t.ts}`,
            text: `Slack thread in ${t.chName} starting ${msgs[0].date} (${msgs.length} messages):\n${convo}`,
            metadata: { channel: t.chName, date: msgs[0].date, source: "slack", thread: true, message_count: msgs.length },
            _skipEnrich: Date.now() - lastTime < GAP_MS_T,
          });
        } catch (_) { /* thread gone or no access — skip */ }
      }
    }

    await upsertCacheItems(userId, "slack", "message", items);
    await evictOldItems(userId, "slack", "message", 3000);
    console.log(`[data-sync] Slack: synced ${items.length} messages for ${userId}`);

    // Index at CONVERSATION level, not per message. A conversation = messages in
    // the same channel with <30 min of silence between them; a 30+ min gap starts
    // a new one. Individual messages lack self-contained meaning; the exchange is
    // the unit worth summarizing. Raw messages stay in data_cache for exact lookup.
    const GAP_MS = 30 * 60 * 1000;
    const byChannel = {};
    // Thread replies live in their thread's own vector item; only parents and
    // unthreaded messages flow into the channel's time-gap segments.
    for (const m of items.filter(m => !m.thread_ts || m.thread_ts === m.ts)) {
      (byChannel[m._channelId] = byChannel[m._channelId] || []).push(m);
    }
    const segments = [];
    for (const msgs of Object.values(byChannel)) {
      msgs.sort((a, b) => a.date.localeCompare(b.date));
      let seg = null;
      let prevTime = 0;
      for (const m of msgs) {
        const t = new Date(m.date).getTime();
        if (!seg || t - prevTime > GAP_MS) {
          seg = { channel: m.channel, chId: m._channelId, startTs: m.date, msgs: [] };
          segments.push(seg);
        }
        seg.msgs.push(m);
        prevTime = t;
      }
    }
    const now = Date.now();
    const { indexItems } = require("./usi");
    const usiItems = segments.map(seg => {
      const convo = seg.msgs.map(m => `[${m.from}]: ${m.text}`).join("\n").substring(0, 8000);
      const lastTime = new Date(seg.msgs[seg.msgs.length - 1].date).getTime();
      return {
        // Keyed on the segment's first message, so closed conversations are stable
        // and only the live tail re-indexes as new messages extend it.
        external_id: `${seg.chId}_conv_${seg.startTs}`,
        text: `Slack conversation in ${seg.channel} starting ${seg.startTs} (${seg.msgs.length} messages):\n${convo}`,
        metadata: { channel: seg.channel, date: seg.startTs, source: "slack", message_count: seg.msgs.length },
        // Still live (quiet for <30 min): embed raw now, enrich once it goes quiet.
        _skipEnrich: now - lastTime < GAP_MS,
      };
    }).filter(i => i.text.length > 40);
    await indexItems(userId, "slack", "conversation", [...usiItems, ...threadVecItems]);
  } catch (e) {
    console.error(`[data-sync] Slack sync error for ${userId}: ${e.message}`);
  }
}

// ============================================================================
// NOTION SYNC — recently edited pages with content, indexed for semantic recall
// ============================================================================

async function syncNotion(userId, userStore) {
  const conn = userStore.getConnection("notion");
  const token = conn?.access_token;
  if (!token) return;

  const api = async (url, method = "GET", body = null) => {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (j.object === "error") throw new Error(j.message || j.code);
    return j;
  };

  try {
    const search = await api("https://api.notion.com/v1/search", "POST", {
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 30,
    });
    const pages = search.results || [];
    if (pages.length === 0) return;

    // Skip content fetch for pages unchanged since last sync
    const { data: cachedRows } = await supabase.from("data_cache")
      .select("external_id, data").eq("user_id", userId).eq("source", "notion");
    const cachedEdited = {};
    for (const c of (cachedRows || [])) cachedEdited[c.external_id] = c.data?.last_edited;

    const items = [];
    for (const page of pages) {
      let title = "";
      for (const prop of Object.values(page.properties || {})) {
        if (prop.type === "title") { title = (prop.title || []).map(t => t.plain_text).join(""); break; }
      }
      if (cachedEdited[page.id] === page.last_edited_time) continue;

      let content = "";
      try {
        const blocks = await api(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`);
        content = (blocks.results || [])
          .map(b => ((b[b.type] || {}).rich_text || []).map(t => t.plain_text).join(""))
          .filter(Boolean).join("\n").substring(0, 8000);
      } catch (_) {}

      items.push({
        external_id: page.id,
        id: page.id,
        title,
        content,
        url: page.url,
        last_edited: page.last_edited_time,
        date: page.last_edited_time,
      });
    }
    if (items.length === 0) {
      console.log(`[data-sync] Notion: ${pages.length} pages, all unchanged.`);
      return;
    }

    await upsertCacheItems(userId, "notion", "page", items);
    await evictOldItems(userId, "notion", "page", 500);
    console.log(`[data-sync] Notion: synced ${items.length} changed page(s) for ${userId}`);

    const { indexItems } = require("./usi");
    const usiItems = items.map(p => ({
      external_id: p.external_id,
      text: `Notion page: ${p.title}\nLast edited: ${p.last_edited}\n\n${p.content}`,
      metadata: { title: p.title, url: p.url, date: p.last_edited, source: "notion" },
    })).filter(i => i.text.length > 30);
    await indexItems(userId, "notion", "page", usiItems);
  } catch (e) {
    console.error(`[data-sync] Notion sync error for ${userId}: ${e.message}`);
  }
}

// ============================================================================
// BRIDGE CALENDAR SYNC
// ============================================================================

async function syncBridgeCalendar(userId) {
  const { data: bridge } = await supabase.from("user_bridges").select("status").eq("user_id", userId).single();
  if (!bridge || bridge.status !== "connected") return;
  console.log(`[data-sync] Syncing Bridge calendar for ${userId}`);

  try {
    // Capture: title, start, end, location, description (contains Teams links, agendas), calendar name
    const icalBuddyArgs = `-f -nc -nrd -iep "title,datetime,location,notes" -po "title,datetime,location,notes" -ps "|||" -df "%A, %d %B %Y at %H:%M:%S" -ec "United States holidays,Holidays in the United Kingdom,UK Holidays,Birthdays,Siri Suggestions,Scheduled Reminders" eventsFrom:"-90d" to:"+180d"`;
    const icalBuddyCmd = `/Applications/ClosedHandBridge.app/Contents/Resources/icalBuddy ${icalBuddyArgs} 2>/dev/null || icalBuddy ${icalBuddyArgs} 2>/dev/null`;
    // Description: grab first 200 chars, replace newlines with spaces in JS (not AppleScript, too slow)
    const appleScriptCmd = `osascript -e 'tell application "Calendar" to launch' -e 'delay 2' -e 'tell application "Calendar"' -e 'set output to ""' -e 'set skipCals to {"United States holidays", "Holidays in the United Kingdom", "Holidays in United Kingdom", "UK Holidays", "Birthdays", "Siri Suggestions", "Scheduled Reminders"}' -e 'repeat with cal in calendars' -e 'set calName to name of cal' -e 'if calName is not in skipCals then' -e 'set evts to (every event of cal whose start date >= ((current date) - (90 * days)) and start date <= ((current date) + (180 * days)))' -e 'repeat with e in evts' -e 'try' -e 'set t to summary of e' -e 'set sd to start date of e as string' -e 'set ed to end date of e as string' -e 'set loc to location of e' -e 'if loc is missing value then set loc to ""' -e 'set desc to ""' -e 'try' -e 'set desc to text 1 thru 2000 of (description of e as text)' -e 'end try' -e 'set atts to ""' -e 'try' -e 'set attList to attendees of e' -e 'repeat with a in attList' -e 'try' -e 'set atts to atts & display name of a & " <" & email of a & "> " & status of a & ","' -e 'end try' -e 'end repeat' -e 'end try' -e 'set output to output & t & "~|~" & sd & "~|~" & ed & "~|~" & loc & "~|~" & desc & "~|~" & calName & "~|~" & atts & (ASCII character 10)' -e 'end try' -e 'end repeat' -e 'end if' -e 'end repeat' -e 'return output' -e 'end tell'`;

    // Try icalBuddy first (instant, no app launch needed), fall back to AppleScript
    const calCmd = `${icalBuddyCmd} || ${appleScriptCmd}`;

    let shellResp;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        shellResp = await bridgeRequest(userId, "shell.run", { command: calCmd, timeout: 40 }, 45000);
        if (shellResp?.stdout) break;
        console.log(`[data-sync] Bridge calendar attempt ${attempt + 1}: no output, retrying...`);
      } catch (e) {
        console.log(`[data-sync] Bridge calendar attempt ${attempt + 1} failed: ${e.message}`);
        if (attempt === 0) await new Promise(r => setTimeout(r, 3000)); // brief pause before retry
      }
    }

    if (!shellResp?.stdout) {
      console.log(`[data-sync] Bridge calendar: no output after retries. stderr=${(shellResp?.stderr || "").substring(0, 300)}, exitCode=${shellResp?.exitCode}`);
      return;
    }

    const raw = shellResp.stdout.trim();
    // Parse both icalBuddy format (title|||datetime|||location per line) and AppleScript format (title|||start|||location|||calendar per line)
    // Parse: AppleScript uses ~|~ delimiter, icalBuddy uses |||
    const delim = raw.includes("~|~") ? "~|~" : "|||";
    const lines = raw.split("\n").filter(l => l.includes(delim));
    const items = lines.map((line, idx) => {
      const parts = line.split(delim).map(p => p.trim());
      // Format: title~|~start~|~end~|~location~|~description~|~calendar~|~attendees (AppleScript)
      // or: title|||datetime|||location|||notes (icalBuddy, fewer fields)
      const summary = parts[0] || "";
      const start = parts[1] || "";
      const end = parts.length >= 6 ? parts[2] : start;
      const location = parts.length >= 6 ? parts[3] : (parts[2] || "");
      const description = (parts.length >= 6 ? parts[4] : (parts[3] || "")).replace(/[\r\n]+/g, " ").replace(/\|\|\|/g, " ").substring(0, 1000);
      const calendar = parts.length >= 6 ? parts[5] : "Mac Calendar";
      // Parse attendees from 7th field: "Name <email> status,Name2 <email2> status2,..."
      const attendeeStr = parts.length >= 7 ? parts[6] : "";
      const attendees = attendeeStr ? attendeeStr.split(",").filter(Boolean).map(a => {
        const match = a.trim().match(/^(.+?)\s*<(.+?)>\s*(.*)$/);
        if (match) return { name: match[1].trim(), email: match[2].trim(), status: (match[3] || "").trim() };
        return { name: a.trim(), email: "", status: "" };
      }) : [];
      const stableId = ("mac_" + idx + "_" + summary).replace(/[^a-zA-Z0-9]/g, "_").substring(0, 100);
      return {
        external_id: stableId,
        id: stableId,
        uid: stableId,
        summary,
        start,
        end: end || start,
        location,
        description: description ? description.substring(0, 1000) : "",
        attendees,
        calendar,
        date: start,
      };
    });

    // Flag duplicate-titled events at different times (likely rescheduled, one may be stale)
    const titleCounts = {};
    for (const item of items) { if (item.summary) titleCounts[item.summary] = (titleCounts[item.summary] || 0) + 1; }
    for (const item of items) {
      if (titleCounts[item.summary] > 1) {
        item.possible_duplicate = true;
      }
    }
    const dedupedItems = items;

    // Clear old mac_calendar events then insert fresh
    const { error: delErr } = await supabase.from("data_cache").delete().eq("user_id", userId).eq("source", "mac_calendar").eq("type", "event");
    if (delErr) console.log(`[data-sync] Bridge cal delete error: ${delErr.message}`);

    // Insert one at a time to handle any constraint issues gracefully
    let inserted = 0;
    for (const item of dedupedItems) {
      const row = {
        user_id: userId, source: "mac_calendar", type: "event",
        external_id: item.external_id,
        data: item,
        synced_at: new Date().toISOString(),
        received_at: (() => {
          const raw = item.date || item.start || "";
          let d = new Date(raw);
          if (isNaN(d.getTime()) && raw) {
            d = new Date(String(raw).replace(/^\w+,\s*/, "").replace(" at ", " "));
          }
          return isNaN(d.getTime()) ? null : d.toISOString();
        })(),
      };
      const { error } = await supabase.from("data_cache").insert(row);
      if (error) { console.log(`[data-sync] Bridge cal insert failed for "${(item.summary || "").substring(0, 40)}": ${error.message}`); }
      else { inserted++; }
    }
    // No eviction cap for calendar events
    console.log(`[data-sync] Bridge calendar: ${inserted}/${dedupedItems.length} events stored for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] Bridge calendar sync error for ${userId}: ${e.message}`);
  }
}

// ============================================================================
// PER-USER ORCHESTRATOR
// ============================================================================

async function syncUserData(userId, mode) {
  console.log(`[data-sync] Syncing user ${userId}, mode=${mode}`);

  let store;
  try {
    store = await UserStore.load(userId);
    if (!store) {
      console.log(`[data-sync] No store for user ${userId}`);
      return;
    }
    // NOTE: No swapToCloudStore here. The store is passed explicitly to all
    // sync functions so multiple users can sync in parallel without racing
    // on the shared ctx.activeUserStore singleton.
  } catch (e) {
    console.error(`[data-sync] Failed to load context for ${userId}: ${e.message}`);
    return;
  }

  try {
    if (mode === "cloud" || mode === "all") {
      await withTimeout(syncGmail(userId, store), 60000, "Gmail").catch(e => console.error(`[data-sync] Gmail failed for ${userId}: ${e.message}`));
      await withTimeout(syncGoogleCalendar(userId, store), 15000, "GCal").catch(e => console.error(`[data-sync] GCal failed for ${userId}: ${e.message}`));
      // Extra Google accounts: same syncs, per-account source tags (gmail_<slug>/gcal_<slug>)
      for (const acct of listGoogleAccounts(store).filter(a => !a.primary)) {
        await withTimeout(syncGmail(userId, store, acct.serviceKey, "gmail_" + acct.slug), 60000, "Gmail extra").catch(e => console.error(`[data-sync] Gmail(${acct.slug}) failed for ${userId}: ${e.message}`));
        await withTimeout(syncGoogleCalendar(userId, store, acct.serviceKey, "gcal_" + acct.slug), 15000, "GCal extra").catch(e => console.error(`[data-sync] GCal(${acct.slug}) failed for ${userId}: ${e.message}`));
      }
      await withTimeout(syncOutlookMail(userId, store), 20000, "Outlook").catch(e => console.error(`[data-sync] Outlook mail failed for ${userId}: ${e.message}`));
      await withTimeout(syncOutlookCalendar(userId, store), 15000, "Outlook cal").catch(e => console.error(`[data-sync] Outlook cal failed for ${userId}: ${e.message}`));
      // Extra Microsoft accounts: same syncs, per-account tags (outlook_<slug>/mscal_<slug>)
      for (const acct of listMicrosoftAccounts(store).filter(a => !a.primary)) {
        await withTimeout(syncOutlookMail(userId, store, acct.serviceKey, "outlook_" + acct.slug), 20000, "Outlook extra").catch(e => console.error(`[data-sync] Outlook(${acct.slug}) failed for ${userId}: ${e.message}`));
        await withTimeout(syncOutlookCalendar(userId, store, acct.serviceKey, "mscal_" + acct.slug), 15000, "Outlook cal extra").catch(e => console.error(`[data-sync] MsCal(${acct.slug}) failed for ${userId}: ${e.message}`));
      }
      await withTimeout(syncSlack(userId, store), 45000, "Slack").catch(e => console.error(`[data-sync] Slack failed for ${userId}: ${e.message}`));
      await withTimeout(syncNotion(userId, store), 45000, "Notion").catch(e => console.error(`[data-sync] Notion failed for ${userId}: ${e.message}`));
      // Zero-project tiers: IMAP mail and secret-ICS calendar land in the same
      // cache and index as the API syncs above.
      await withTimeout(require("./imap-mail").syncImapMail(userId, store), 150000, "IMAP").catch(e => console.error(`[data-sync] IMAP failed for ${userId}: ${e.message}`));
      await withTimeout(require("./ics-calendar").syncIcsCalendar(userId, store), 20000, "ICS cal").catch(e => console.error(`[data-sync] ICS failed for ${userId}: ${e.message}`));
      // CalDAV rides the mailbox's app password, so a user who connected mail
      // has a read-write calendar without connecting anything else.
      await withTimeout(require("./caldav").syncCalDAVCalendar(userId, store), 30000, "CalDAV").catch(e => console.error(`[data-sync] CalDAV failed for ${userId}: ${e.message}`));
    }
    if (mode === "bridge" || mode === "all") {
      // Calendar only: iCloud calendars have no cloud API route. Apple Mail sync was
      // removed 2026-07 (AppleScript-fragile, cloud mail already covered by Gmail/Outlook APIs).
      await withTimeout(syncBridgeCalendar(userId), 45000, "Bridge cal").catch(e => console.error(`[data-sync] Bridge cal failed for ${userId}: ${e.message}`));
    }
    // Sync connected third-party services (Notion, Jira, Slack, etc.)
    try {
      const { syncConnectedServices } = require("./usi-connector");
      await syncConnectedServices(userId);
    } catch (e) {
      console.log(`[USI-Connector] Service sync error for ${userId}: ${e.message}`);
    }
    console.log(`[data-sync] Finished user ${userId}`);
    // USI: index synced data into data_vectors (Phase 1 inline, Phase 2 background)
    try {
      await require("./usi").runPostSyncIndex(userId);
    } catch (e) {
      console.error(`[USI] Hook error for ${userId}: ${e.message}`);
    }
  } catch (e) {
    console.error(`[data-sync] User ${userId} sync error: ${e.message}`);
  } finally {
    try { if (store) store.save().catch(() => {}); } catch (_) {}
  }
}

// ============================================================================
// ALL-USERS SYNC
// ============================================================================

async function syncAllUsers(mode) {
  console.log(`[data-sync] Starting ${mode} sync for all users`);

  try {
    // Get users who have at least one connection
    const { data: connections, error } = await supabase
      .from("connections")
      .select("user_id")
      .in("service", ["google", "microsoft", "imap", "ics_calendar"]);

    if (error) {
      console.error(`[data-sync] Failed to fetch connected users: ${error.message}`);
      return;
    }

    // Deduplicate user IDs
    const userIds = [...new Set((connections || []).map(c => c.user_id))];

    // Also include users with bridge connected (check profiles)
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, settings")
      .not("settings", "is", null);

    for (const profile of (profiles || [])) {
      if (profile.settings?.bridge_connected && !userIds.includes(profile.id)) {
        userIds.push(profile.id);
      }
    }

    console.log(`[data-sync] Found ${userIds.length} users to sync (mode=${mode})`);

    // Parallel sync is safe: each user's store is loaded independently and passed
    // through the call chain. No shared ctx.activeUserStore in this path.
    // Concurrency tunable without a deploy; capped to avoid thundering-herd
    // 429s and memory spikes (each user fans out ~10 fetches + 10 enrichments).
    const limit = pLimit(parseInt(process.env.SYNC_USER_CONCURRENCY || "10", 10));
    await Promise.allSettled(
      userIds.map(userId => limit(() =>
        Promise.race([
          syncUserData(userId, mode),
          new Promise((_, rej) => setTimeout(() => rej(new Error("User sync timeout (5min)")), 300000)),
        ]).catch(e => console.error(`[data-sync] Failed to sync user ${userId}: ${e.message}`))
      ))
    );

    console.log(`[data-sync] ${mode} sync complete for ${userIds.length} users`);
  } catch (e) {
    console.error(`[data-sync] syncAllUsers error: ${e.message}`);
  }
}

// ============================================================================
// CACHE QUERY HELPERS (used by data-access.js)
// ============================================================================

async function queryCacheEmails(userId, query, days = 7) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Fetch ALL cached emails (don't filter by received_at since Bridge emails have null dates)
    // Filter by date in JS instead, treating null dates as recent
    const { data, error } = await supabase
      .from("data_cache")
      .select("*")
      .eq("user_id", userId)
      .eq("type", "email")
      .order("synced_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error(`[data-sync] Cache email query error: ${error.message}`);
      return null;
    }

    if (!data || data.length === 0) return null;

    // Check freshness
    const newestSync = data.reduce((max, r) => {
      const t = new Date(r.synced_at).getTime();
      return t > max ? t : max;
    }, 0);
    const cacheAgeMs = Date.now() - newestSync;
    const cacheAgeMin = Math.round(cacheAgeMs / 60000);

    // Filter by keyword if query is specific (names, subjects, companies)
    // Broad/semantic queries ("outstanding tasks", "anything important", "what should I do") should be treated as generic
    const broadPatterns = /^(urgent|task|action|required|pending|outstanding|important|todo|to.do|follow.up|what.*do|anything.*aware|should.*know|coming.*up|this.*week|need.*to|items|things)/i;
    const isGeneric = !query || query === "*" || /^(all|recent|latest|new|unread|today|inbox|email|emails)$/i.test(query.trim()) || broadPatterns.test(query.trim());

    let results = data.map(r => ({ ...r.data, source: r.source }));

    // A specific query goes through the same retriever passive recall uses,
    // rather than a private one. Three things were wrong with having its own:
    // it searched only the 500 rows loaded above, out of 8,000 cached; it ran
    // the vector arm alone, so an invoice number was matched by meaning and
    // never by the number; and it carried a third stop-word list that had
    // drifted from the one the lexical index is built with, so the tool and
    // passive recall disagreed about what a query even contained.
    //
    // usi.search fuses the vector and lexical arms by RRF over the whole
    // cache. It returns summaries, so the ids are rehydrated to full rows
    // here: writes downstream need account, thread_id and attachments, which
    // a summary does not carry.
    if (!isGeneric) {
      try {
        const { search } = require("./usi");
        const found = await search(userId, query, { cacheType: "email", service: "email", maxResults: 30 });
        const ids = [...new Set((found.results || []).map(r => r.id).filter(Boolean))];
        if (ids.length > 0) {
          const { data: rows, error: rehydrateErr } = await supabase
            .from("data_cache")
            .select("external_id, source, data")
            .eq("user_id", userId)
            .eq("type", "email")
            .in("external_id", ids);
          if (rehydrateErr) {
            console.error(`[data-sync] Email rehydrate failed: ${rehydrateErr.message}`);
          } else {
            // Ranked order comes from the fusion, not from the database.
            const byId = new Map((rows || []).map(row => [row.external_id, row]));
            const ordered = ids.map(id => byId.get(id)).filter(Boolean)
              .map(row => ({ ...row.data, source: row.source }));
            if (ordered.length > 0) {
              console.log(`[data-sync] Hybrid email search: ${ordered.length} of ${ids.length} matches for "${query.substring(0, 50)}"`);
              // Specific matches stay valid far longer than the 30-min
              // "anything new?" freshness window: old email does not go stale.
              return { results: ordered, cacheAgeMin, fresh: cacheAgeMin < 1440, source: "data_cache_hybrid" };
            }
          }
        }
        // Specific query, nothing matched: report a miss so the caller falls to
        // live search, instead of returning a pile of unrelated recent emails
        // as a fake hit.
        return null;
      } catch (e) {
        console.error(`[data-sync] Hybrid email search failed, falling back to recent: ${e.message}`);
      }
    }

    // Only generic queries reach here ("recent", "anything new?"), and those
    // want the newest mail rather than a ranked match, so there is nothing
    // left to filter. The substring matcher that used to live here, with the
    // third stop-word list, is what the hybrid path above replaces.
    return {
      results,
      cacheAgeMin,
      fresh: cacheAgeMin < 30,
      source: "data_cache",
    };
  } catch (e) {
    console.error(`[data-sync] queryCacheEmails error: ${e.message}`);
    return null;
  }
}

async function queryCacheCalendar(userId, start, end) {
  try {
    const startISO = new Date(start).toISOString();
    const endISO = new Date(end).toISOString();

    // Calendar events: filter by received_at which stores the event start date
    const { data, error } = await supabase
      .from("data_cache")
      .select("*")
      .eq("user_id", userId)
      .eq("type", "event")
      .order("received_at", { ascending: true })
      .limit(1000);

    if (error) {
      console.error(`[data-sync] Cache calendar query error: ${error.message}`);
      return null;
    }

    if (!data || data.length === 0) return null;

    // Check freshness
    const newestSync = data.reduce((max, r) => {
      const t = new Date(r.synced_at).getTime();
      return t > max ? t : max;
    }, 0);
    const cacheAgeMs = Date.now() - newestSync;
    const cacheAgeMin = Math.round(cacheAgeMs / 60000);

    // Filter events by date range in JS
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();

    const macEvents = data.filter(r => r.source === "mac_calendar");
    const gcalEvents = data.filter(r => r.source === "gcal");
    console.log(`[data-sync] queryCacheCalendar: ${data.length} total (${gcalEvents.length} gcal, ${macEvents.length} mac_calendar), range ${start} to ${end}`);
    for (const r of macEvents) {
      const d = r.data || {};
      console.log(`[data-sync]   mac_cal: "${d.summary}" | start="${d.start}" | date="${d.date}" | received_at=${r.received_at}`);
    }
    const results = data
      .map(r => ({ ...r.data, _cache_source: r.source }))
      .filter(evt => {
        const raw = evt.start || evt.date || "";
        let d = new Date(raw);
        if (isNaN(d.getTime()) && raw) {
          const cleaned = String(raw).replace(/^\w+,\s*/, "").replace(" at ", " ");
          d = new Date(cleaned);
        }
        const evtStart = d.getTime();
        if (isNaN(evtStart)) { console.log(`[data-sync] Event date parse failed: "${raw}" -> "${evt.summary}"`); return false; }
        if (evtStart < startMs || evtStart > endMs) return false;
        // Mark canceled events (Google uses "cancelled", Apple uses title prefix)
        const status = (evt.status || "").toLowerCase();
        const title = (evt.summary || "").toLowerCase();
        if (status === "cancelled" || title.startsWith("canceled:") || title.startsWith("cancelled:")) {
          evt.canceled = true;
        }
        return true;
      });

    return {
      events: results,
      cacheAgeMin,
      fresh: cacheAgeMin < 30,
      source: "data_cache",
    };
  } catch (e) {
    console.error(`[data-sync] queryCacheCalendar error: ${e.message}`);
    return null;
  }
}

// ============================================================================
// STARTUP
// ============================================================================

let cloudTimer = null;
let bridgeTimer = null;

function startDataSync() {
  console.log("[data-sync] Starting data sync service");

  // Initial sync 30s after boot
  setTimeout(() => {
    syncAllUsers("all").catch(e => console.error(`[data-sync] Initial sync error: ${e.message}`));
  }, 30000);

  // Cloud sync every 5 minutes
  cloudTimer = setInterval(() => {
    syncAllUsers("cloud").catch(e => console.error(`[data-sync] Cloud sync error: ${e.message}`));
  }, 5 * 60 * 1000);

  // Bridge calendar sync every 15 minutes (no-op unless a bridge is connected)
  bridgeTimer = setInterval(() => {
    syncAllUsers("bridge").catch(e => console.error(`[data-sync] Bridge sync error: ${e.message}`));
  }, 15 * 60 * 1000);
}

function stopDataSync() {
  if (cloudTimer) { clearInterval(cloudTimer); cloudTimer = null; }
  if (bridgeTimer) { clearInterval(bridgeTimer); bridgeTimer = null; }
  console.log("[data-sync] Stopped data sync service");
}

/**
 * Universal cache search across ALL data types and sources in data_cache.
 * For email type, delegates to queryCacheEmails (which has semantic search + keyword fallback).
 * For other types, does keyword search across the data jsonb field.
 */
async function queryCacheUniversal(userId, { query, type, source, days = 30, max_results = 50 }) {
  // Email queries get the full queryCacheEmails pipeline (semantic + keyword + distillation)
  if (type === "email" || (!type && !source)) {
    const emailResults = await queryCacheEmails(userId, query, days);
    if (emailResults && emailResults.results && emailResults.results.length > 0) {
      // If no type filter, also search non-email types and merge
      if (!type) {
        const otherResults = await _searchCacheGeneric(userId, query, source, days, max_results, "email");
        if (otherResults.length > 0) {
          emailResults.results = [...emailResults.results, ...otherResults].slice(0, max_results);
          emailResults.mixed = true;
        }
      }
      return emailResults;
    }
    if (type === "email") return emailResults; // Explicitly asked for email, return even if empty
  }

  // Non-email type search
  const results = await _searchCacheGeneric(userId, query, source, days, max_results, null);
  if (results.length === 0) return null;

  const newestSync = results.reduce((max, r) => Math.max(max, new Date(r._synced_at || 0).getTime()), 0);
  const cacheAgeMin = Math.round((Date.now() - newestSync) / 60000);

  const sourceCounts = {};
  const typeCounts = {};
  for (const r of results) {
    sourceCounts[r._source || "unknown"] = (sourceCounts[r._source || "unknown"] || 0) + 1;
    typeCounts[r._type || "item"] = (typeCounts[r._type || "item"] || 0) + 1;
  }

  return {
    results,
    cacheAgeMin,
    fresh: cacheAgeMin < 30,
    source: "data_cache",
    source_counts: sourceCounts,
    type_counts: typeCounts,
  };
}

/** Generic cache search for non-email types */
async function _searchCacheGeneric(userId, query, source, days, maxResults, excludeType) {
  try {
    let q = supabase
      .from("data_cache")
      .select("*")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false })
      .limit(500);

    if (excludeType) q = q.neq("type", excludeType);
    if (source) q = q.ilike("source", source + "%");

    const { data, error } = await q;
    if (error || !data || data.length === 0) return [];

    let results = data.map(r => ({ ...r.data, _source: r.source, _type: r.type, _external_id: r.external_id, _synced_at: r.synced_at }));

    // Keyword filter if query is specific.
    //
    // Deliberately still an in-memory filter rather than the lexical index the
    // email path uses. Everything reaching here is a non-email cache type, and
    // those fit inside the 500 rows loaded above with room to spare, so the
    // index would buy ranking and no extra coverage while costing a second
    // round trip and a source filter the RPC cannot express. What it did need
    // was the tokeniser: this had its own stop list, a third one, drifting
    // from the two the rest of retrieval agrees on.
    if (query && query !== "*") {
      const { lexicalTokens } = require("./lexical");
      const keywords = lexicalTokens(query, { corpus: "mail" }).map(w => w.toLowerCase());
      if (keywords.length > 0) {
        const filtered = results.filter(item => {
          const text = JSON.stringify(item).toLowerCase();
          return keywords.some(kw => text.includes(kw));
        });
        if (filtered.length > 0) results = filtered;
      }
    }

    return results.slice(0, maxResults);
  } catch (e) {
    console.log(`[data-sync] Generic cache search error: ${e.message}`);
    return [];
  }
}

module.exports = {
  startDataSync,
  stopDataSync,
  syncAllUsers,
  syncUserData,
  queryCacheEmails,
  queryCacheCalendar,
  queryCacheUniversal,
  upsertCacheItems,
  reconcileDeletedEvents,
};
