// lib/services/data-access.js -- Unified data access: cache search, calendar, attachments
// Zero-AI scouring: all fetching is programmatic HTTP, only one cheap Haiku call to format results.

const cheerio = require("cheerio");
const ctx = require("../context");
const { isGoogleConnected, googleApiRequest } = require("./google");
const { isMicrosoftConnected, microsoftApiRequest } = require("./microsoft");
const { isGwsAvailable, gwsCommand } = require("./gws");
const { createLLMClient, MODEL_MAP } = require("../llm");
const { uploadToDrive } = require("./drive");
const { sendDocument } = require("../messaging");
const { MIME_TYPES } = require("../files");
const { bridgeRequest } = require("./bridge-relay");
const { queryCacheEmails, queryCacheCalendar } = require("./data-sync");
const { supabase } = require("../../user-store");

// Check connections via Supabase (reliable, not dependent on in-memory context)
async function hasConnection(userId, service) {
  try {
    const { data } = await supabase.from("connections").select("id").eq("user_id", userId).eq("service", service).single();
    return !!data;
  } catch (_) { return false; }
}

// --- Concurrency limiter (inline, avoids ESM-only p-limit) ---
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

// --- Timeout wrapper ---
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// --- HTML stripping ---
function stripHtml(html) {
  if (!html) return "";
  try {
    const $ = cheerio.load(html);
    // Remove script, style, head
    $("script, style, head").remove();
    let text = $.text();
    // Strip quoted replies (lines starting with >)
    text = text.split("\n").filter(line => !line.trimStart().startsWith(">")).join("\n");
    // Strip common signatures
    const sigIdx = text.indexOf("\n-- \n");
    if (sigIdx > 0) text = text.substring(0, sigIdx);
    // Strip legal disclaimers
    const discIdx = text.search(/CONFIDENTIALITY NOTICE|DISCLAIMER|This email.*is intended/i);
    if (discIdx > 0) text = text.substring(0, discIdx);
    // Collapse whitespace
    text = text.replace(/\s+/g, " ").trim();
    return text;
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

// --- Gmail body extraction (from MIME payload) ---
function extractGmailBody(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractGmailBody(part);
      if (result) return result;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    const html = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    return stripHtml(html);
  }
  return "";
}

// --- Gmail attachment extraction ---
function extractGmailAttachments(payload, results = []) {
  if (payload.filename && payload.body?.attachmentId) {
    results.push({
      attachment_id: payload.body.attachmentId,
      name: payload.filename,
      type: payload.mimeType,
      size: payload.body.size,
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) extractGmailAttachments(part, results);
  }
  return results;
}

// --- Get header from Gmail message ---
function getGmailHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

// ============================================================================
// GMAIL FETCHER
// ============================================================================

// Shared: parse a full Gmail message detail into our standard schema
function parseGmailMessage(detail, sourceTag = "gmail") {
  const headers = detail.payload?.headers || [];
  let body = extractGmailBody(detail.payload);
  if (body.length > 500) body = body.substring(0, 500);

  return {
    id: detail.id,
    threadId: detail.threadId,
    source: sourceTag,
    from: getGmailHeader(headers, "From"),
    to: getGmailHeader(headers, "To"),
    subject: getGmailHeader(headers, "Subject"),
    date: getGmailHeader(headers, "Date"),
    messageId_header: getGmailHeader(headers, "Message-ID"),
    snippet: detail.snippet,
    body,
    labels: detail.labelIds,
    attachments: extractGmailAttachments(detail.payload),
  };
}

async function searchGmail(query, days, options = {}) {
  if (!isGoogleConnected()) return { results: [], skipped: true, reason: "Google not connected" };
  console.log(`[search] searchGmail: query="${query}", days=${days}, options=${JSON.stringify(options)}`);

  // Try gws CLI first (handles pagination + rate limiting internally)
  if (isGwsAvailable()) {
    try {
      const result = await searchGmailGWS(query, days, options);
      console.log(`[search] searchGmail (gws): returned ${result.results.length} results`);
      return result;
    } catch (e) {
      console.error("[search] gws Gmail failed, falling back to HTTP:", e.message);
    }
  }

  const result = await searchGmailHTTP(query, days, options);
  console.log(`[search] searchGmail (HTTP): returned ${result.results.length} results`);
  return result;
}

// --- gws CLI path ---
async function searchGmailGWS(query, days, options = {}) {
  const dateBuffer = Math.max(3, Math.ceil(days * 0.3));
  const effectiveDays = days + dateBuffer;
  let fullQuery = `${query} newer_than:${effectiveDays}d`;
  if (options.unread_only) fullQuery = `is:unread ${fullQuery}`;
  if (options.has_attachment) fullQuery = `has:attachment ${fullQuery}`;

  // gws handles pagination internally
  const escaped = fullQuery.replace(/"/g, '\\"');
  const listResult = await gwsCommand(
    `gmail users messages list --params '{"userId":"me","q":"${escaped}","maxResults":500}' --format json`
  );

  const messageIds = (listResult.messages || []).map(m => m.id);
  if (messageIds.length === 0) return { results: [], skipped: false, reason: null };

  // Batch-fetch bodies via gws (50 concurrent)
  const limit = pLimit(50);
  const messages = await Promise.allSettled(
    messageIds.slice(0, 500).map(id => limit(() =>
      gwsCommand(
        `gmail users messages get --params '{"userId":"me","id":"${id}","format":"full"}' --format json`
      )
    ))
  );

  const results = [];
  for (const result of messages) {
    if (result.status !== "fulfilled") continue;
    results.push(parseGmailMessage(result.value));
  }

  return { results, skipped: false, reason: null };
}

// --- Raw HTTP fallback ---
async function searchGmailHTTP(query, days, options = {}, serviceKey = "google", sourceTag = "gmail") {
  console.log(`[search] searchGmailHTTP: query="${query}", days=${days}`);
  const dateBuffer = Math.max(3, Math.ceil(days * 0.3));
  const effectiveDays = days + dateBuffer;

  const baseTimeFilter = `newer_than:${effectiveDays}d`;
  const queries = [`${query} ${baseTimeFilter}`];

  const words = query.split(/\s+/).filter(w => w.length > 2 && !w.match(/^(the|and|or|from|for|about|with|that|this|has|was|are)$/i));
  if (words.length > 1) {
    queries.push(`${words[0]} ${baseTimeFilter}`);
  }

  if (options.unread_only) {
    queries[0] = `is:unread ${queries[0]}`;
  }
  if (options.has_attachment) {
    queries[0] = `has:attachment ${queries[0]}`;
  }

  const limit = pLimit(50);
  const allMessageIds = new Set();

  for (const q of queries) {
    try {
      let pageToken = null;
      let fetched = 0;
      const maxTotal = 200;

      do {
        const encoded = encodeURIComponent(q);
        let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encoded}&maxResults=100`;
        if (pageToken) url += `&pageToken=${pageToken}`;

        const listData = await withTimeout(
          googleApiRequest("GET", url, null, null, serviceKey), 10000, "Gmail search"
        );

        if (listData.messages) {
          for (const msg of listData.messages) {
            allMessageIds.add(msg.id);
          }
          fetched += listData.messages.length;
        }
        pageToken = listData.nextPageToken;
      } while (pageToken && fetched < maxTotal);
    } catch (e) {
      console.error(`[search] Gmail query "${q}" failed:`, e.message);
    }
  }

  console.log(`[search] searchGmailHTTP: found ${allMessageIds.size} message IDs`);
  if (allMessageIds.size === 0) {
    return { results: [], skipped: false, reason: null };
  }

  const messageIds = [...allMessageIds].slice(0, 500);
  const messages = await Promise.allSettled(
    messageIds.map(id => limit(() =>
      withTimeout(
        googleApiRequest("GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, null, null, serviceKey),
        10000, "Gmail fetch"
      )
    ))
  );

  const results = [];
  for (const result of messages) {
    if (result.status !== "fulfilled") continue;
    results.push(parseGmailMessage(result.value, sourceTag));
  }

  return { results, skipped: false, reason: null };
}

// All Google accounts: primary via searchGmail (gws-accelerated), extras via
// the HTTP path with their own tokens and source tags.
async function searchGmailAllAccounts(query, days, options = {}) {
  const primary = await searchGmail(query, days, options);
  let extras = [];
  try {
    const { listGoogleAccounts } = require("./google");
    extras = listGoogleAccounts(ctx.activeUserStore).filter(a => !a.primary);
  } catch (_) {}
  if (extras.length === 0) return primary;
  const settled = await Promise.allSettled(
    extras.map(a => searchGmailHTTP(query, days, options, a.serviceKey, "gmail_" + a.slug))
  );
  const results = [...(primary.results || [])];
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(...s.value.results);
  }
  return { results, skipped: primary.skipped && results.length === 0, reason: primary.reason };
}

// All Microsoft accounts: primary plus extras with their own tokens and tags.
async function searchOutlookAllAccounts(query, days, options = {}) {
  const primary = await searchOutlook(query, days, options);
  let extras = [];
  try {
    const { listMicrosoftAccounts } = require("./microsoft");
    extras = listMicrosoftAccounts(ctx.activeUserStore).filter(a => !a.primary);
  } catch (_) {}
  if (extras.length === 0) return primary;
  const settled = await Promise.allSettled(
    extras.map(a => searchOutlook(query, days, options, a.serviceKey, "outlook_" + a.slug))
  );
  const results = [...(primary.results || [])];
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(...s.value.results);
  }
  return { results, skipped: primary.skipped && results.length === 0, reason: primary.reason };
}

// ============================================================================
// OUTLOOK FETCHER (Microsoft Graph)
// ============================================================================

async function searchOutlook(query, days, options = {}, serviceKey = "microsoft", sourceTag = "outlook") {
  if (!isMicrosoftConnected(ctx.activeUserStore, serviceKey)) return { results: [], skipped: true, reason: "Microsoft not connected" };

  const dateBuffer = Math.max(3, Math.ceil(days * 0.3));
  const effectiveDays = days + dateBuffer;
  const sinceDate = new Date(Date.now() - effectiveDays * 86400000).toISOString();

  // Build search URL
  const escaped = query.replace(/"/g, '\\"');
  let url = `https://graph.microsoft.com/v1.0/me/messages?$search="${escaped}"&$top=100&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,body,internetMessageId&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${sinceDate}`;

  if (options.unread_only) {
    url += ` and isRead eq false`;
  }
  if (options.has_attachment) {
    url += ` and hasAttachments eq true`;
  }

  const allMessages = [];

  try {
    let nextLink = url;
    let pages = 0;
    const maxPages = 5; // Cap at 500 messages

    while (nextLink && pages < maxPages) {
      const data = await withTimeout(
        microsoftApiRequest("GET", nextLink), 10000, "Outlook search"
      );

      if (data.value) {
        allMessages.push(...data.value);
      }

      nextLink = data["@odata.nextLink"] || null;
      pages++;
    }
  } catch (e) {
    // Graph API may not support $search + $filter together. Fall back to $search only.
    if (e.message.includes("400") || e.message.includes("SearchAndFilterNotSupported")) {
      console.error("[search] Outlook $search+$filter failed, retrying with $search only:", e.message);
      try {
        const fallbackUrl = `https://graph.microsoft.com/v1.0/me/messages?$search="${escaped}"&$top=100&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,body,internetMessageId&$orderby=receivedDateTime desc`;
        const data = await withTimeout(
          microsoftApiRequest("GET", fallbackUrl), 10000, "Outlook search fallback"
        );
        if (data.value) allMessages.push(...data.value);
      } catch (e2) {
        console.error("[search] Outlook search fallback also failed:", e2.message);
        return { results: [], skipped: true, reason: e2.message };
      }
    } else {
      console.error("[search] Outlook search failed:", e.message);
      return { results: [], skipped: true, reason: e.message };
    }
  }

  if (allMessages.length === 0) {
    return { results: [], skipped: false, reason: null };
  }

  // Normalize to common schema
  const results = allMessages.map(msg => {
    let body = msg.body?.content || msg.bodyPreview || "";
    if (msg.body?.contentType === "html") {
      body = stripHtml(body);
    }
    if (body.length > 500) body = body.substring(0, 500);

    // Extract attachments metadata (Graph returns hasAttachments bool, not inline list)
    // Attachment details require a separate call, but we include the flag for now
    const attachments = msg.hasAttachments ? [{ name: "(attachments available)", attachment_id: "pending", type: "unknown", size: 0 }] : [];

    return {
      id: msg.id,
      source: sourceTag,
      from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ""} <${msg.from.emailAddress.address}>` : "",
      to: (msg.toRecipients || []).map(r => r.emailAddress?.address || "").join(", "),
      subject: msg.subject || "",
      date: msg.receivedDateTime || "",
      messageId_header: msg.internetMessageId || "",
      body,
      snippet: (msg.bodyPreview || "").substring(0, 200),
      attachments,
    };
  });

  // If messages have attachments, batch-fetch attachment metadata
  const limit = pLimit(20);
  const msgsWithAttachments = results.filter(r => r.attachments.length > 0 && r.attachments[0].attachment_id === "pending");
  if (msgsWithAttachments.length > 0) {
    const attResults = await Promise.allSettled(
      msgsWithAttachments.map(msg => limit(async () => {
        try {
          const attData = await withTimeout(
            microsoftApiRequest("GET", `https://graph.microsoft.com/v1.0/me/messages/${msg.id}/attachments?$select=id,name,contentType,size`),
            10000, "Outlook attachments"
          );
          return { msgId: msg.id, attachments: attData.value || [] };
        } catch {
          return { msgId: msg.id, attachments: [] };
        }
      }))
    );

    const attMap = new Map();
    for (const r of attResults) {
      if (r.status === "fulfilled") attMap.set(r.value.msgId, r.value.attachments);
    }

    for (const msg of results) {
      const atts = attMap.get(msg.id);
      if (atts) {
        msg.attachments = atts.map(a => ({
          attachment_id: a.id,
          name: a.name || "",
          type: a.contentType || "",
          size: a.size || 0,
        }));
      } else if (msg.attachments[0]?.attachment_id === "pending") {
        msg.attachments = [];
      }
    }
  }

  return { results, skipped: false, reason: null };
}

// ============================================================================
// GOOGLE CALENDAR FETCHER
// ============================================================================

// Shared: parse a Google Calendar event into our standard schema
function parseGcalEvent(e) {
  return {
    id: e.id,
    source: "gcal",
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || null,
    description: e.description ? e.description.substring(0, 500) : null,
    attendees: (e.attendees || []).map(a => ({ email: a.email, name: a.displayName || "", status: a.responseStatus || "" })),
    status: e.status,
    calendar: "primary",
    uid: e.iCalUID || e.id,
    attachments: (e.attachments || []).map(a => ({
      name: a.title, url: a.fileUrl, attachment_id: a.fileId || "",
      source: "gcal",
    })),
  };
}

async function fetchGoogleCalendar(start, end, query) {
  if (!isGoogleConnected()) return { events: [], skipped: true, reason: "Google not connected" };

  // Try gws CLI first
  if (isGwsAvailable()) {
    try {
      return await fetchGoogleCalendarGWS(start, end, query);
    } catch (e) {
      console.error("[search] gws Calendar failed, falling back to HTTP:", e.message);
    }
  }

  return fetchGoogleCalendarHTTP(start, end, query);
}

async function fetchGoogleCalendarGWS(start, end, query) {
  const params = {
    calendarId: "primary",
    timeMin: new Date(start).toISOString(),
    timeMax: new Date(end).toISOString(),
    maxResults: 250,
    singleEvents: true,
    orderBy: "startTime",
  };
  if (query) params.q = query;

  const escaped = JSON.stringify(params).replace(/'/g, "\\'");
  const data = await gwsCommand(
    `calendar events list --params '${escaped}' --format json`
  );

  const events = (data.items || []).map(parseGcalEvent);
  return { events, skipped: false, reason: null };
}

async function fetchGoogleCalendarHTTP(start, end, query) {
  try {
    const timeMin = encodeURIComponent(new Date(start).toISOString());
    const timeMax = encodeURIComponent(new Date(end).toISOString());
    let url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&maxResults=250&singleEvents=true&orderBy=startTime`;
    if (query) url += `&q=${encodeURIComponent(query)}`;

    const data = await withTimeout(googleApiRequest("GET", url), 10000, "Google Calendar");
    const events = (data.items || []).map(parseGcalEvent);
    return { events, skipped: false, reason: null };
  } catch (e) {
    console.error("[search] Google Calendar failed:", e.message);
    return { events: [], skipped: true, reason: e.message };
  }
}

// ============================================================================
// OUTLOOK CALENDAR FETCHER (Microsoft Graph)
// ============================================================================

async function fetchOutlookCalendar(start, end, query) {
  if (!isMicrosoftConnected()) return { events: [], skipped: true, reason: "Microsoft not connected" };

  try {
    const startISO = new Date(start).toISOString();
    const endISO = new Date(end).toISOString();
    let url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${startISO}&endDateTime=${endISO}&$top=250&$select=id,subject,start,end,location,attendees,bodyPreview,hasAttachments,iCalUId`;

    const allEvents = [];
    let nextLink = url;
    let pages = 0;

    while (nextLink && pages < 3) {
      const data = await withTimeout(
        microsoftApiRequest("GET", nextLink), 10000, "Outlook Calendar"
      );
      if (data.value) allEvents.push(...data.value);
      nextLink = data["@odata.nextLink"] || null;
      pages++;
    }

    const events = allEvents
      .filter(e => !query || (e.subject || "").toLowerCase().includes(query.toLowerCase()) || (e.bodyPreview || "").toLowerCase().includes(query.toLowerCase()))
      .map(e => ({
        id: e.id,
        source: "outlook_cal",
        summary: e.subject || "",
        start: e.start?.dateTime ? e.start.dateTime + (e.start.timeZone === "UTC" ? "Z" : "") : "",
        end: e.end?.dateTime ? e.end.dateTime + (e.end.timeZone === "UTC" ? "Z" : "") : "",
        location: e.location?.displayName || null,
        description: e.bodyPreview ? e.bodyPreview.substring(0, 500) : null,
        attendees: (e.attendees || []).map(a => ({ email: a.emailAddress?.address || "", name: a.emailAddress?.name || "", status: a.status?.response || "" })),
        status: e.responseStatus?.response || "",
        calendar: "Outlook",
        uid: e.iCalUId || e.id,
        attachments: [],
      }));

    return { events, skipped: false, reason: null };
  } catch (e) {
    console.error("[search] Outlook Calendar failed:", e.message);
    return { events: [], skipped: true, reason: e.message };
  }
}

// ============================================================================
// BRIDGE CALENDAR FETCHER
// ============================================================================

async function fetchBridgeCalendar(userId, start, end) {
  if (!ctx.bridgeConnected) {
    return { events: [], skipped: true, reason: "Bridge offline" };
  }

  try {
    // Route through shell.run (proven TCC-compatible path, same as mail)
    // Skip holiday/birthday calendars (they make the query take 2+ minutes)
    // Calculate day offsets from now for the requested range
    const nowMs = Date.now();
    const startDays = Math.floor((new Date(start).getTime() - nowMs) / 86400000);
    const endDays = Math.ceil((new Date(end).getTime() - nowMs) / 86400000);
    const startOffset = Math.min(startDays, 0); // allow negative for past events
    const endOffset = Math.max(endDays, 7); // at least 7 days ahead
    const calCmd = `osascript -e 'tell application "Calendar" to launch' -e 'delay 5' -e 'tell application "Calendar"' -e 'set output to ""' -e 'set skipCals to {"United States holidays", "Holidays in the United Kingdom", "Holidays in United Kingdom", "UK Holidays", "Birthdays", "Siri Suggestions", "Scheduled Reminders"}' -e 'repeat with cal in calendars' -e 'set calName to name of cal' -e 'if calName is not in skipCals then' -e 'set evts to (every event of cal whose start date >= ((current date) + (${startOffset} * days)) and start date <= ((current date) + (${endOffset} * days)))' -e 'repeat with e in evts' -e 'try' -e 'set t to summary of e' -e 'set sd to start date of e as string' -e 'set loc to location of e' -e 'if loc is missing value then set loc to ""' -e 'set att to ""' -e 'try' -e 'repeat with a in attendees of e' -e 'set aName to ""' -e 'try' -e 'set aName to name of a' -e 'end try' -e 'if aName is "" then set aName to address of a' -e 'set att to att & aName & " (" & (participation status of a as string) & "), "' -e 'end repeat' -e 'end try' -e 'set output to output & t & "|||" & sd & "|||" & loc & "|||" & calName & "|||" & att & (ASCII character 10)' -e 'end try' -e 'end repeat' -e 'end if' -e 'end repeat' -e 'return output' -e 'end tell'`;
    const shellResp = await bridgeRequest(userId, "shell.run", { command: calCmd, timeout: 50 }, 55000);

    if (shellResp?.stdout) {
      const lines = shellResp.stdout.trim().split("\n").filter(l => l.includes("|||"));
      const events = lines.map(line => {
        const parts = line.split("|||");
        return {
          source: "mac_calendar",
          summary: parts[0] || "",
          start: parts[1] || "",
          location: parts[2] || "",
          calendar: parts[3] || "Mac Calendar",
          attendees: (parts[4] || "").split(", ").filter(a => a.trim()),
          uid: "",
          attachments: [],
        };
      }).map(e => {
        // Mark canceled events by title so the bot can see them but deprioritises
        const title = (e.summary || "").toLowerCase();
        if (title.startsWith("canceled:") || title.startsWith("cancelled:") || title.includes("canceled -") || title.includes("cancelled -")) {
          e.canceled = true;
        }
        return e;
      });
      console.log(`[search] Bridge calendar (via shell.run): ${events.length} events`);
      for (const ev of events) {
        console.log(`[search]   Event: "${ev.summary}" | ${ev.start} | canceled=${ev.canceled || false} | attendees=${(ev.attendees || []).join("; ")}`);
      }
      return { events, skipped: false, reason: null };
    }
    console.log(`[search] Bridge calendar: no events. resp=${JSON.stringify(shellResp).substring(0, 200)}`);
    return { events: [], skipped: false, reason: null };
  } catch (e) {
    console.error("[search] Bridge calendar failed:", e.message);
    return { events: [], skipped: true, reason: e.message };
  }
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

function deduplicateEmails(results) {
  const seen = new Map();
  let dupeCount = 0;
  for (const email of results) {
    // Use messageId_header for cross-source dedup, but only if non-empty
    const key = (email.messageId_header && email.messageId_header.trim()) ? email.messageId_header : `${email.subject}-${email.from}-${email.date}`;
    if (!seen.has(key)) {
      seen.set(key, email);
    } else {
      dupeCount++;
      // Prefer Gmail over Bridge (richer metadata)
      if (email.source === "gmail" && seen.get(key).source !== "gmail") {
        seen.set(key, email);
      }
    }
  }
  console.log(`[search] deduplicateEmails: ${results.length} in, ${seen.size} out, ${dupeCount} duplicates removed`);
  return [...seen.values()];
}

function deduplicateEvents(events) {
  const seen = new Map();
  for (const event of events) {
    const key = event.uid || `${event.summary}-${event.start}`;
    if (!seen.has(key)) {
      seen.set(key, event);
    } else {
      // Prefer Google Calendar (richer data)
      if (event.source === "gcal" && seen.get(key).source !== "gcal") {
        seen.set(key, event);
      }
    }
  }
  return [...seen.values()];
}

// ============================================================================
// HAIKU REFINERY
// ============================================================================

async function refineResults(rawEmails, query) {
  if (rawEmails.length === 0) return [];

  // Truncate bodies for cost control
  const prepped = rawEmails.map(e => ({
    id: e.id,
    source: e.source,
    from: e.from,
    to: e.to,
    subject: e.subject,
    date: e.date,
    body: (e.body || "").substring(0, 500),
    attachments: e.attachments,
    bridge_account: e.bridge_account,
  }));

  // Batch into groups of 10 (smaller batches = less truncation risk, faster per batch)
  const batches = [];
  for (let i = 0; i < prepped.length; i += 10) {
    batches.push(prepped.slice(i, i + 10));
  }

  const { getInternalClient } = require("../llm");
  const { client, model: fastModel } = getInternalClient(ctx.activeUserId);

  const refinedBatches = await Promise.allSettled(
    batches.map(async (batch) => {
      try {
        const response = await client.messages.create({
          model: fastModel,
          max_tokens: 8192,
          system: "You are a data extraction engine. For each email, return JSON with: { id, source, account_label, from_name, from_email, from_company, subject, date, summary (2 sentences max), action_required (bool), action_description, attachments: [{name, size, type, attachment_id}], priority (high/medium/low) }. Return ONLY a JSON array. No markdown, no commentary.",
          messages: [{
            role: "user",
            content: `Extract structured data from these ${batch.length} emails (user searched for: "${query}"):\n\n${JSON.stringify(batch)}`,
          }],
        });

        const text = response.content[0]?.text?.trim();
        // Log token savings
        const rawChars = batch.reduce((sum, e) => sum + (e.body?.length || 0), 0);
        const rawTokenEstimate = Math.ceil(rawChars / 4);
        console.log(`[search] Refined ${batch.length} emails. Raw: ~${rawTokenEstimate} tokens. Haiku used: ${response.usage?.input_tokens || 0}in/${response.usage?.output_tokens || 0}out`);

        // Parse JSON, handle potential markdown wrapping
        let cleaned = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
        return JSON.parse(cleaned);
      } catch (e) {
        console.error("[search] Haiku refinery failed:", e.message);
        // Fallback: return raw data without AI formatting
        return batch.map(e => ({
          id: e.id,
          source: e.source,
          from_name: e.from,
          from_email: e.from,
          subject: e.subject,
          date: e.date,
          summary: (e.body || "").substring(0, 200),
          action_required: false,
          priority: "medium",
          attachments: e.attachments || [],
        }));
      }
    })
  );

  const results = [];
  for (const batch of refinedBatches) {
    if (batch.status === "fulfilled" && Array.isArray(batch.value)) {
      results.push(...batch.value);
    }
  }
  return results;
}

// ============================================================================
// MAIN EXPORTS
// ============================================================================

async function searchCacheFn(userId, params) {
  const { query, scope, days = 7, max_results = 20, unread_only = false, has_attachment = false } = params;
  console.log(`[search] Search: query="${query}", days=${days}, userId=${userId}`);

  const options = { unread_only, has_attachment };

  // ALWAYS check data cache first (works even without live connections)
  if (!unread_only) {
    try {
      const cached = await queryCacheEmails(userId, query, days);
      if (cached && cached.fresh && cached.results.length > 0) {
        // account/thread_id/draft_id/is_draft ride along because writes need
        // them: the tool descriptions promise "emails carry the account they
        // belong to", and without it a reply or draft edit can only guess the
        // primary mailbox.
        let limited = cached.results.slice(0, 100).map(e => ({
          id: e.id,
          source: e.source || "cached",
          account: e.account,
          thread_id: e.threadId,
          ...(e.is_draft ? { is_draft: true, draft_id: e.draft_id } : {}),
          from: e.from,
          to: e.to,
          subject: e.subject,
          date: e.date,
          body: (e.body || "").substring(0, 1000),
          mailbox: e.mailbox || "",
          attachments: e.attachments || [],
        }));
        // Filter by has_attachment if requested
        if (has_attachment) {
          limited = limited.filter(e => e.attachments && e.attachments.length > 0);
        }
        if (limited.length > 0) {
        console.log(`[search] Cache hit: ${limited.length} emails${has_attachment ? " (with attachments)" : ""}, age=${cached.cacheAgeMin}min`);

        const sourceCounts = {};
        for (const r of limited) {
          const s = r.source || "unknown";
          sourceCounts[s] = (sourceCounts[s] || 0) + 1;
        }
        return {
          results: limited,
          metadata: {
            sources_checked: ["data_cache"],
            sources_skipped: [],
            errors: [],
            total_found: limited.length,
            source_counts: sourceCounts,
            cache_age_min: cached.cacheAgeMin,
            warnings: [],
          },
          summary: `Found ${limited.length} emails from cache (${cached.cacheAgeMin}min old): ${Object.entries(sourceCounts).map(([k,v]) => `${v} from ${k}`).join(", ")}.`,
        };
        } // end if (limited.length > 0)
      }
    } catch (e) {
      console.log(`[search] Cache check failed, falling through to live: ${e.message}`);
    }
  }

  // Check live connections via Supabase (reliable, not dependent on ctx singleton)
  const hasGoogle = await hasConnection(userId, "google");
  const hasMicrosoft = await hasConnection(userId, "microsoft");
  console.log(`[search] Live sources: google=${hasGoogle}, microsoft=${hasMicrosoft}`);

  const hasImapSrc = await hasConnection(userId, "imap");
  if (!hasGoogle && !hasMicrosoft && !hasImapSrc) {
    return {
      error: "No email sources connected and nothing in cache. Connect Gmail, Outlook or an IMAP mailbox from your dashboard.",
      results: [],
      metadata: { sources_checked: ["data_cache"], sources_skipped: ["all_live"] },
    };
  }

  // Query all live sources in parallel
  const [gmailResult, outlookResult] = await Promise.allSettled([
    hasGoogle ? searchGmailAllAccounts(query, days, options) : Promise.resolve({ results: [], skipped: true, reason: "Google not connected" }),
    hasMicrosoft ? searchOutlookAllAccounts(query, days, options) : Promise.resolve({ results: [], skipped: true, reason: "Microsoft not connected" }),
  ]);

  // Collect results and metadata
  const metadata = { sources_checked: [], sources_skipped: [], errors: [] };
  const allResults = [];

  for (const [name, result] of [["Gmail", gmailResult], ["Outlook", outlookResult]]) {
    if (result.status === "fulfilled") {
      const val = result.value;
      if (val.skipped) {
        metadata.sources_skipped.push(`${name}: ${val.reason}`);
      } else {
        metadata.sources_checked.push(name);
        allResults.push(...val.results);
      }
    } else {
      metadata.errors.push(`${name}: ${result.reason?.message || "unknown error"}`);
    }
  }

  if (allResults.length === 0) {
    // Try broader search before giving up
    const broader = query.split(/\s+/).slice(0, 1).join(" ");
    if (broader !== query && broader.length > 0) {
      console.log(`[search] No results for "${query}", trying broader: "${broader}"`);
      const retryParams = { ...params, query: broader, days: days * 2 };
      // Prevent infinite recursion
      retryParams._retried = true;
      if (!params._retried) {
        return searchCacheFn(userId, retryParams);
      }
    }

    return {
      results: [],
      metadata,
      message: `No results found. Searched: ${metadata.sources_checked.join(", ") || "none"}. ${metadata.sources_skipped.length > 0 ? "Skipped: " + metadata.sources_skipped.join(", ") + "." : ""} Try different keywords or check if the relevant account is connected.`,
    };
  }

  // Deduplicate
  const deduped = deduplicateEmails(allResults);
  metadata.total_found = deduped.length;

  // Count per source for metadata
  const perSourceCount = {};
  for (const e of deduped) perSourceCount[e.source || "unknown"] = (perSourceCount[e.source || "unknown"] || 0) + 1;
  console.log(`[search] Deduped: ${deduped.length} emails from ${allResults.length} raw. Sources: ${metadata.sources_checked.join(",")}. Per-source: ${Object.entries(perSourceCount).map(([k,v]) => `${k}=${v}`).join(", ")}. Errors: ${metadata.errors.join(",") || "none"}`);

  // Send all deduped results to the LLM (no artificial cap - ~5K tokens for 100 emails is negligible)
  const limited = deduped.map(e => ({
    id: e.id,
    source: e.source,
    account: e.account,
    thread_id: e.threadId,
    ...(e.is_draft ? { is_draft: true, draft_id: e.draft_id } : {}),
    from: e.from,
    to: e.to,
    subject: e.subject,
    date: e.date,
    body: (e.body || e.snippet || "").substring(0, 1000),
    mailbox: e.mailbox || "",
    attachments: e.attachments || [],
  }));
  console.log(`[search] Returning ${limited.length} results (no refinery)`);

  // Add per-source counts so the LLM clearly sees what came from where
  const sourceCounts = {};
  for (const r of limited) {
    const s = r.source || "unknown";
    sourceCounts[s] = (sourceCounts[s] || 0) + 1;
  }
  metadata.source_counts = sourceCounts;

  // --- Sanity-check warnings (Issue 2) ---
  const warnings = [];

  // Very few results for a broad query
  const isNarrow = query && query.split(/\s+/).length >= 3;
  if (limited.length <= 1 && !isNarrow) {
    warnings.push("Very few results returned, search may be incomplete. Try different keywords or check Gmail/Outlook connectivity.");
  }

  // All results from one source, other connected sources returned nothing
  const activeSources = Object.keys(sourceCounts);
  if (activeSources.length === 1 && metadata.sources_checked.length > 1) {
    const missingSources = metadata.sources_checked.filter(s => {
      const prefix = s === "Gmail" ? "gmail" : "outlook";
      return !activeSources.some(as => as.startsWith(prefix));
    });
    if (missingSources.length > 0) {
      warnings.push(`All results came from one source. No results from: ${missingSources.join(", ")}. Those sources may not have matching emails or may have had errors.`);
    }
  }

  // Empty bodies/snippets on all results
  const allEmptyContent = limited.length > 0 && limited.every(r => !r.snippet || r.snippet.trim().length === 0);
  if (allEmptyContent) {
    warnings.push("Email content not available, only subject lines visible. Body text could not be retrieved from any source.");
  }

  metadata.warnings = warnings;

  return {
    results: limited,
    metadata,
    warnings,
    summary: `Found ${limited.length} emails: ${Object.entries(sourceCounts).map(([k,v]) => `${v} from ${k}`).join(", ")}. Sources checked: ${metadata.sources_checked.join(", ")}.${warnings.length > 0 ? " WARNINGS: " + warnings.join(" | ") : ""}`,
  };
}

async function searchCalendarFn(userId, params) {
  const { start, end, scope, query } = params;

  // Parse natural language dates
  const now = new Date();
  let startDate, endDate;
  const dateWarnings = [];

  // Returns a Date, or null if unparseable. NEVER silently defaults: callers must
  // decide the fallback and tell the model what range was actually used
  // (silent default-to-today made "next 2 weeks" collapse to one day, 2026-07-19).
  function parseDate(str) {
    if (!str) return null;
    const lower = str.toLowerCase().trim();
    if (lower === "now" || lower === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (lower === "tomorrow") { const d = new Date(now); d.setDate(d.getDate() + 1); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    if (lower === "yesterday") { const d = new Date(now); d.setDate(d.getDate() - 1); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    if (lower === "next week") { const d = new Date(now); d.setDate(d.getDate() + 7); return d; }
    if (lower === "this week" || lower === "this weekend") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (lower === "next fortnight" || lower === "fortnight") { const d = new Date(now); d.setDate(d.getDate() + 14); return d; }
    if (lower === "next month") { const d = new Date(now); d.setMonth(d.getMonth() + 1); return d; }
    // Day names: "monday", "friday", "next friday" etc
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const dayMatch = lower.replace("next ", "").trim();
    if (days[dayMatch] !== undefined) {
      const target = days[dayMatch];
      const d = new Date(now);
      const current = d.getDay();
      let diff = target - current;
      if (diff <= 0) diff += 7;
      if (lower.startsWith("next ")) diff += 7;
      d.setDate(d.getDate() + diff);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    }
    // Relative ranges: "next 2 weeks", "in 3 days", "2 months" (day names handled above)
    const rel = lower.match(/^(?:next |in |coming )?(\d+)\s*(day|week|month)s?$/);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const d = new Date(now);
      if (rel[2] === "day") d.setDate(d.getDate() + n);
      else if (rel[2] === "week") d.setDate(d.getDate() + n * 7);
      else d.setMonth(d.getMonth() + n);
      return d;
    }
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  startDate = parseDate(start);
  if (!startDate) {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    dateWarnings.push(`Could not parse start date "${start}"; used today (${startDate.toISOString().slice(0, 10)}). Prefer ISO dates (YYYY-MM-DD).`);
  }
  endDate = parseDate(end);
  if (!endDate) {
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 14);
    dateWarnings.push(`Could not parse end date "${end}"; used start + 14 days (${endDate.toISOString().slice(0, 10)}). Prefer ISO dates (YYYY-MM-DD).`);
  }
  if (dateWarnings.length > 0) console.log(`[search] ${dateWarnings.join(" | ")}`);

  // If end is the same day, extend to end of day
  if (endDate.toDateString() === startDate.toDateString()) {
    endDate = new Date(endDate);
    endDate.setHours(23, 59, 59);
  }

  const hasGoogle = await hasConnection(userId, "google");
  const hasMicrosoft = await hasConnection(userId, "microsoft");
  const hasBridge = !!ctx.bridgeConnected;

  const hasIcsSrc = await hasConnection(userId, "ics_calendar");
  if (!hasGoogle && !hasMicrosoft && !hasBridge && !hasIcsSrc) {
    return {
      error: "No calendar sources connected. Connect Google Calendar, Outlook, a calendar feed (ICS), or set up the Mac Bridge from your dashboard.",
      events: [],
      metadata: { sources_checked: [], sources_skipped: ["all"] },
    };
  }

  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();

  // Check data cache first (fast path) - but only use if all connected sources are represented
  try {
    const cached = await queryCacheCalendar(userId, startISO, endISO);
    console.log(`[search] Calendar cache result: ${cached ? cached.events?.length + ' events, fresh=' + cached.fresh + ', age=' + cached.cacheAgeMin + 'min' : 'null'}`);
    if (cached && cached.fresh && cached.events.length > 0) {
      {
        // Filter out canceled events
        const beforeFilter = cached.events.length;
        cached.events = cached.events.filter(e => !e.canceled);
        console.log(`[search] Calendar cache: ${beforeFilter} total, ${cached.events.length} after filtering canceled`);
        for (const ev of cached.events) {
          console.log(`[search]   Cached event: "${ev.summary}" | ${ev.start} | canceled=${ev.canceled || false}`);
        }
        function parseEventDate(s) {
          let d = new Date(s);
          if (isNaN(d.getTime()) && s) {
            d = new Date(String(s).replace(/^\w+,\s*/, "").replace(" at ", " "));
          }
          return d.getTime() || 0;
        }
        const sorted = cached.events.sort((a, b) => parseEventDate(a.start) - parseEventDate(b.start));
        return {
          events: sorted,
          count: sorted.length,
          range_used: `${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`,
          warnings: dateWarnings.length > 0 ? dateWarnings : undefined,
          canceled_filtered: beforeFilter - sorted.length,
          note: beforeFilter > sorted.length ? `${beforeFilter - sorted.length} cancelled event(s) were removed. Only active events are shown. Do not flag cancelled events as conflicts.` : undefined,
          metadata: {
            sources_checked: ["data_cache"],
            sources_skipped: [],
            errors: [],
            cache_age_min: cached.cacheAgeMin,
          },
        };
      }
      console.log(`[search] Calendar cache has ${cached.events.length} events but Bridge is connected with no Bridge events cached, falling through to live`);
    }
  } catch (e) {
    console.log(`[search] Calendar cache check failed, falling through to live: ${e.message}`);
  }

  // Prefer cloud APIs for live fallback. Bridge only as last resort (slow but sometimes the only source for Exchange calendars).
  const [gcalResult, outlookCalResult, bridgeResult] = await Promise.allSettled([
    hasGoogle ? fetchGoogleCalendar(startISO, endISO, query) : Promise.resolve({ events: [], skipped: true, reason: "Google not connected" }),
    hasMicrosoft ? fetchOutlookCalendar(startISO, endISO, query) : Promise.resolve({ events: [], skipped: true, reason: "Microsoft not connected" }),
    // Only use Bridge if no cloud calendar APIs are available (Exchange calendars that only sync to Apple Calendar)
    (!hasGoogle && !hasMicrosoft && hasBridge) ? fetchBridgeCalendar(userId, startISO, endISO) : Promise.resolve({ events: [], skipped: true, reason: "Using cloud APIs" }),
  ]);

  const metadata = { sources_checked: [], sources_skipped: [], errors: [] };
  const allEvents = [];

  for (const [name, result] of [["Google Calendar", gcalResult], ["Outlook Calendar", outlookCalResult], ["Local Calendar (via Bridge)", bridgeResult]]) {
    if (result.status === "fulfilled") {
      const val = result.value;
      if (val.skipped) {
        metadata.sources_skipped.push(`${name}: ${val.reason}`);
      } else {
        metadata.sources_checked.push(name);
        allEvents.push(...val.events);
      }
    } else {
      metadata.errors.push(`${name}: ${result.reason?.message || "unknown error"}`);
    }
  }

  // Deduplicate and flag potential rescheduled events (same title, different times)
  const deduped = deduplicateEvents(allEvents);
  // Detect same-title events at different times (likely rescheduled, one may be stale)
  const titleCounts = {};
  for (const e of deduped) { titleCounts[e.summary] = (titleCounts[e.summary] || 0) + 1; }
  for (const e of deduped) {
    if (titleCounts[e.summary] > 1) {
      e.possible_duplicate = true;
      e.note = "Multiple events with this title exist at different times. One may be a rescheduled/stale duplicate. Check with the user.";
    }
  }
  function parseCalDate(s) {
    let d = new Date(s);
    if (isNaN(d.getTime()) && s) {
      d = new Date(String(s).replace(/^\w+,\s*/, "").replace(" at ", " "));
    }
    return d.getTime() || 0;
  }
  deduped.sort((a, b) => parseCalDate(a.start) - parseCalDate(b.start));

  return {
    events: deduped,
    count: deduped.length,
    range_used: `${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`,
    warnings: dateWarnings.length > 0 ? dateWarnings : undefined,
    metadata,
  };
}

async function fetchAttachmentFn(userId, params) {
  const { source, message_id, attachment_id, filename, save_to_drive, send_to_user, _chatId } = params;

  let buffer;

  // Sources like gmail_<slug>/outlook_<slug> belong to an extra account
  const { serviceKeyForSourceTag } = require("./google");
  const { msServiceKeyForSourceTag } = require("./microsoft");
  const googleKey = serviceKeyForSourceTag(source);
  const microsoftKey = msServiceKeyForSourceTag(source);
  const baseSource = /^gmail(_|$)/.test(source || "") ? "gmail"
    : /^gcal(_|$)/.test(source || "") ? "gcal"
    : /^outlook(_|$)/.test(source || "") ? "outlook"
    : /^mscal(_|$)/.test(source || "") ? "outlook_cal" : source;

  switch (baseSource) {
    case "imap": {
      // IMAP has no persistent per-part id: refetch the message and take the
      // attachment by its cached position index.
      try {
        const { fetchImapAttachment } = require("./imap-mail");
        const got = await fetchImapAttachment(ctx.activeUserStore, message_id, attachment_id);
        buffer = got.buffer;
        break;
      } catch (e) {
        return { error: `Attachment download failed: ${e.message}` };
      }
    }
    case "gmail": {
      if (!isGoogleConnected()) return { error: "Google not connected" };
      let attData;
      if (googleKey === "google" && isGwsAvailable()) {
        try {
          attData = await gwsCommand(
            `gmail users messages attachments get --params '{"userId":"me","messageId":"${message_id}","id":"${attachment_id}"}' --format json`
          );
        } catch (e) {
          console.error("[search] gws attachment failed, falling back to HTTP:", e.message);
        }
      }
      if (!attData) {
        // A message id only exists on the account that holds the mail, and the
        // caller frequently says "gmail" for mail that lives on an extra
        // account, which turns into a 403 with the primary's credentials. The
        // wrong account fails fast, so rather than bounce that error to the
        // user ("the attachment will not download cleanly"), try each of
        // their Google accounts until one owns the message.
        const { listGoogleAccounts } = require("./google");
        const others = listGoogleAccounts(ctx.activeUserStore)
          .map((a) => a.serviceKey).filter((k) => k !== googleKey);
        let lastErr = null;
        for (const key of [googleKey, ...others]) {
          try {
            attData = await googleApiRequest("GET",
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message_id}/attachments/${attachment_id}`,
              null, null, key
            );
            if (attData?.data) {
              if (key !== googleKey) console.log(`[search] attachment found on ${key} after ${googleKey} failed`);
              break;
            }
          } catch (e) { lastErr = e; attData = null; }
        }
        if (!attData?.data && lastErr) return { error: `Attachment download failed on every Google account: ${String(lastErr.message).substring(0, 120)}` };
      }
      if (!attData || !attData.data) return { error: "No attachment data returned" };
      buffer = Buffer.from(attData.data, "base64url");
      break;
    }

    case "gcal": {
      if (!isGoogleConnected()) return { error: "Google not connected" };
      // Calendar attachments are Google Drive files, fetch via Drive. Same
      // account walk as gmail above: the file only exists on the account that
      // owns the event, the caller's source tag is frequently wrong, and a
      // wrong-account fetch fails fast.
      const { listGoogleAccounts } = require("./google");
      const gcalOthers = listGoogleAccounts(ctx.activeUserStore)
        .map((a) => a.serviceKey).filter((k) => k !== googleKey);
      let fileData = null;
      for (const key of [googleKey, ...gcalOthers]) {
        try {
          const r = await googleApiRequest("GET",
            `https://www.googleapis.com/drive/v3/files/${attachment_id}?alt=media`,
            null, null, key
          );
          if (r?._binary) { fileData = r; break; }
        } catch (e) { /* wrong account: try the next */ }
      }
      if (fileData?._binary) {
        buffer = Buffer.from(fileData.raw, "utf-8");
      } else {
        return { error: "Could not download calendar attachment from any Google account" };
      }
      break;
    }

    case "outlook": {
      if (!isMicrosoftConnected()) return { error: "Microsoft not connected" };
      // Same account walk as gmail: the message only exists on the account
      // that holds it, and a wrong-account fetch fails fast.
      const { listMicrosoftAccounts } = require("./microsoft");
      const msOthers = listMicrosoftAccounts(ctx.activeUserStore)
        .map((a) => a.serviceKey).filter((k) => k !== microsoftKey);
      let attData = null; let msErr = null;
      for (const key of [microsoftKey, ...msOthers]) {
        try {
          const r = await microsoftApiRequest("GET",
            `https://graph.microsoft.com/v1.0/me/messages/${message_id}/attachments/${attachment_id}`,
            null, null, key);
          if (r?.contentBytes) { attData = r; break; }
        } catch (e) { msErr = e; }
      }
      if (!attData?.contentBytes) return { error: msErr ? `Attachment download failed on every Microsoft account: ${String(msErr.message).substring(0, 120)}` : "No attachment data returned" };
      buffer = Buffer.from(attData.contentBytes, "base64");
      break;
    }

    case "outlook_cal": {
      if (!isMicrosoftConnected()) return { error: "Microsoft not connected" };
      const { listMicrosoftAccounts: listMs2 } = require("./microsoft");
      const msCalOthers = listMs2(ctx.activeUserStore)
        .map((a) => a.serviceKey).filter((k) => k !== microsoftKey);
      let calAttData = null;
      for (const key of [microsoftKey, ...msCalOthers]) {
        try {
          const r = await microsoftApiRequest("GET",
            `https://graph.microsoft.com/v1.0/me/events/${message_id}/attachments/${attachment_id}`,
            null, null, key);
          if (r?.contentBytes) { calAttData = r; break; }
        } catch (e) { /* try next account */ }
      }
      if (!calAttData?.contentBytes) return { error: "No attachment data returned" };
      buffer = Buffer.from(calAttData.contentBytes, "base64");
      break;
    }

    case "bridge_cal":
      return { error: "Calendar attachment download via Bridge not yet implemented" };

    default:
      return { error: `Unknown source: ${source}` };
  }

  const ext = (filename || "").split(".").pop().toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  // Save as local attachment
  const { saveAttachment } = require("../attachments");
  const attId = saveAttachment(ctx.activeUserId, {
    buffer, ext, fileName: filename,
    mediaType: mimeType,
    isImage: ["jpg", "jpeg", "png", "gif", "webp"].includes(ext),
    isText: false,
    isPdf: ext === "pdf",
  }, `Sentinel attachment: ${filename}`);

  if (save_to_drive) {
    if (!isGoogleConnected()) return { error: "Google not connected for Drive upload" };
    // The account that holds the message is the one whose Drive this belongs in.
    // googleKey is already resolved from the same source tag above.
    const driveFile = await uploadToDrive(buffer, filename, mimeType, null, googleKey);
    return {
      success: true,
      action: "saved_to_drive",
      filename,
      attachment_id: attId,
      drive_file_id: driveFile.id,
      drive_url: driveFile.webViewLink,
    };
  }

  // Only send to the user when they asked to be shown it. This used to send
  // every attachment straight to chat and hand the model nothing but a
  // filename, so it stayed blind to the thing it had just fetched and could
  // only describe attachments it had never seen.
  if (send_to_user && _chatId) {
    await sendDocument(_chatId, buffer, filename, mimeType, /^gmail|^outlook/.test(source || "") ? "email" : /gcal|mscal/.test(source || "") ? "drive" : undefined);
  }

  const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);

  // Images come back TO THE MODEL so it can actually read them. Guarded on size
  // because an image costs real tokens every turn it stays in context: past a
  // few megabytes the caller gets the metadata and can decide whether it is
  // worth opening at all.
  const MAX_INLINE_BYTES = 4 * 1024 * 1024;
  if (isImage && buffer.length <= MAX_INLINE_BYTES) {
    return {
      _contentType: "image",
      mediaType: mimeType,
      base64: buffer.toString("base64"),
      attachment_id: attId,
      filename,
      // Kept short and factual: when context fills, compressToolResponses
      // replaces the image with this line, so it is all that survives.
      description: `Attachment "${filename}" (${Math.round(buffer.length / 1024)}KB) from ${source} message ${message_id}${send_to_user ? ", also sent to the user" : ""}. Note anything that matters from it in your reply, since the image itself drops out of context later.`,
    };
  }

  // Documents (PDF, Word, Excel, text) get their text extracted right here, so
  // the caller can read the contents directly. Without this, an agent that
  // cannot see inside a PDF resorts to uploading it to the cloud computer and
  // running pdftotext there, which is slow and confuses users ("why is it
  // reading a file on the cloud computer?").
  const extractedText = isImage
    ? null
    : await require("./usi").extractAttachmentText(buffer, filename).catch(() => null);
  if (extractedText) {
    return {
      success: true,
      action: send_to_user ? "sent_to_chat" : "fetched",
      filename,
      size_kb: Math.round(buffer.length / 1024),
      attachment_id: attId,
      text_content: extractedText,
    };
  }

  return {
    success: true,
    action: send_to_user ? "sent_to_chat" : "fetched",
    filename,
    size_kb: Math.round(buffer.length / 1024),
    attachment_id: attId,
    note: isImage
      ? "Too large to view inline. Use view_attachment with the attachment_id if you need to see it."
      : "This file's text could not be extracted. If you need its contents, try view_attachment with the attachment_id.",
  };
}

module.exports = { searchCache: searchCacheFn, searchCalendar: searchCalendarFn, fetchAttachment: fetchAttachmentFn };
