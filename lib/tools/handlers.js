// lib/tools/handlers.js — handleInternalTool switch + isInternalTool

const cron = require("node-cron");
const https = require("https");
const fs = require("fs");
const path = require("path");
const ctx = require("../context");
const { httpGet, httpGetBuffer, makeRawRequest } = require("../http");
const { saveStore } = require("../storage");
const { getConversation } = require("../conversation");
const { listAttachments, loadAttachment, loadAttachmentRaw, ATTACHMENTS_DIR } = require("../attachments");
const { isGoogleConnected, getGoogleToken, googleApiRequest } = require("../services/google");
const { isMicrosoftConnected, microsoftApiRequest } = require("../services/microsoft");

// Per-call Google API bound to the account the user asked for (multi-account).
// Throws a friendly error (listing accounts) when the hint doesn't resolve.
function googleReqFor(accountInput) {
  const { resolveGoogleAccount } = require("../services/google");
  const key = resolveGoogleAccount(ctx.activeUserStore, accountInput);
  const call = (method, url, body = null) => googleApiRequest(method, url, body, null, key);
  call.serviceKey = key;
  return call;
}

// Load the raw bytes for each attachment_id so they can be attached to an
// outgoing email. Returns { attachments, missing } so the caller can refuse to
// send silently when a requested file cannot be found.
async function resolveOutgoingAttachments(ids) {
  const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  const attachments = [];
  const missing = [];
  for (const id of list) {
    const raw = await loadAttachmentRaw(id).catch(() => null);
    if (raw && raw.buffer) attachments.push(raw);
    else missing.push(id);
  }
  return { attachments, missing };
}

// Build a base64url raw message for the Gmail send endpoint. Plain text when
// there are no attachments; multipart/mixed (text part + one part per file)
// when there are. headerLines are the address/subject/threading headers.
function buildGmailRaw(headerLines, body, attachments) {
  if (!attachments || attachments.length === 0) {
    const lines = [...headerLines, `Content-Type: text/plain; charset="UTF-8"`, "", body];
    return Buffer.from(lines.join("\r\n")).toString("base64url");
  }
  const boundary = "=_ch_" + Date.now().toString(36);
  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ];
  for (const att of attachments) {
    const safeName = (att.fileName || "attachment").replace(/"/g, "");
    const b64 = att.buffer.toString("base64").replace(/(.{76})/g, "$1\r\n");
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType || "application/octet-stream"}; name="${safeName}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${safeName}"`,
      "",
      b64,
    );
  }
  parts.push(`--${boundary}--`);
  const lines = [
    ...headerLines,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

// Header lines + threadId for a pending send, shared by the send handlers and the
// draft-preview so the draft the user sees is byte-identical to what gets sent.
async function sendHeadersFor(toolName, toolInput, gApi) {
  if (toolName === "gmail_reply" || toolName === "outlook_reply" || toolName === "reply_to_mail") {
    const original = await gApi("GET",
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${toolInput.message_id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID`);
    const headers = original.payload?.headers || [];
    const gh = (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
    const subject = gh("Subject").startsWith("Re:") ? gh("Subject") : `Re: ${gh("Subject")}`;
    const mid = gh("Message-ID");
    return { headerLines: [`To: ${gh("From")}`, `Subject: ${subject}`, `In-Reply-To: ${mid}`, `References: ${mid}`], threadId: toolInput.thread_id };
  }
  return { headerLines: [`To: ${toolInput.to}`, toolInput.cc ? `Cc: ${toolInput.cc}` : null, `Subject: ${toolInput.subject}`].filter(Boolean), threadId: null };
}

// Save a pending send as a Gmail draft so the user can preview the real
// formatting and attachment before confirming. Returns { draftId } or { error }.
async function createGmailDraft(toolName, toolInput) {
  try {
    const gApi = googleReqFor(toolInput.account);
    const { attachments, missing } = await resolveOutgoingAttachments(toolInput.attachment_ids);
    if (missing.length) return { error: `attachments missing: ${missing.join(", ")}` };
    const { headerLines, threadId } = await sendHeadersFor(toolName, toolInput, gApi);
    const raw = buildGmailRaw(headerLines, toolInput.body, attachments);
    const draft = await gApi("POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw, ...(threadId ? { threadId } : {}) } });
    return { draftId: draft.id };
  } catch (e) { return { error: e.message }; }
}

// Send the exact draft the user previewed. One send, no re-composition.
async function sendGmailDraft(account, draftId) {
  const gApi = googleReqFor(account);
  const r = await gApi("POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", { id: draftId });
  return { success: true, messageId: r.id };
}

async function deleteGmailDraft(account, draftId) {
  try { await googleReqFor(account)("DELETE", `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}`); } catch (_) { /* best effort */ }
}

// Drive search is a live API call per account, not a vector query, so it does
// not sweep every account for free. When the user names no account, run the
// same Drive query against all connected Google accounts in parallel and tag
// each file with the account it came from, so "find my contract" looks
// everywhere the way mail search does.
async function driveQueryAllAccounts(q, fields, maxResults, orderBy) {
  const { listGoogleAccounts, googleApiRequest } = require("../services/google");
  const accounts = listGoogleAccounts(ctx.activeUserStore);
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${maxResults}&fields=${fields}${orderBy ? "&orderBy=" + orderBy : ""}`;
  const settled = await Promise.allSettled(accounts.map(async (a) => {
    const data = await googleApiRequest("GET", url, null, ctx.activeUserStore, a.serviceKey);
    return (data.files || []).map((f) => ({ ...f, _account: a.email || a.serviceKey }));
  }));
  const files = [];
  for (const r of settled) if (r.status === "fulfilled") files.push(...r.value);
  return files;
}

// Microsoft twin of googleReqFor: bind the request to the account asked for.
function microsoftReqFor(accountInput) {
  const { resolveMicrosoftAccount } = require("../services/microsoft");
  const key = resolveMicrosoftAccount(ctx.activeUserStore, accountInput);
  const call = (method, url, body = null) => microsoftApiRequest(method, url, body, null, key);
  call.serviceKey = key;
  return call;
}
const { shopifyApiRequest } = require("../services/shopify");
const { slackApiRequest } = require("../services/slack-api");
const { metaApiRequest } = require("../services/meta");
const { getInternalClient } = require("../llm");
const { uploadToDrive, deleteFromDrive } = require("../services/drive");
const { CONNECTABLE_SERVICES, generateBotConnectToken } = require("../services-config");
const { sendWhatsAppInteractive, sendDocument, sendLocation } = require("../messaging");
const { MIME_TYPES } = require("../files");
const { INTERNAL_TOOLS } = require("./definitions");
const { isBlockedUrl } = require("../ssrf");
const { searchCache, searchCalendar, fetchAttachment } = require("../services/data-access");
const { isGwsAvailable, gwsCommand } = require("../services/gws");
// Lazy require to avoid circular dep (scheduling.js → handlers.js → scheduling.js)
function _registerSchedule(s) { return require("../scheduling").registerSchedule(s); }

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

async function handleInternalTool(toolName, toolInput) {
  switch (toolName) {
    case "add_schedule": {
      if (!cron.validate(toolInput.cron_expression)) {
        return { error: `Invalid cron expression: ${toolInput.cron_expression}` };
      }
      const scheduleTz = require("../timezone").getUserTimezone(ctx.store);
      // Save to Supabase with chat ID. The timezone goes with it, or a restart
      // re-registers the job in the London fallback and it fires hours off.
      if (ctx.activeUserStore) {
        await ctx.activeUserStore.saveSchedule(toolInput.name, toolInput.cron_expression, toolInput.prompt, ctx.activeChatId, toolInput.run_once === true, scheduleTz);
      }
      // Update local store
      ctx.store.schedules = ctx.store.schedules.filter((s) => s.name !== toolInput.name);
      const newSchedule = {
        name: toolInput.name,
        cron: toolInput.cron_expression,
        prompt: toolInput.prompt,
        enabled: true,
        run_once: toolInput.run_once === true,
        created: new Date().toISOString(),
        timezone: scheduleTz,
        _userId: ctx.activeUserId,
        _chatId: ctx.activeChatId,
      };
      ctx.store.schedules.push(newSchedule);
      _registerSchedule(newSchedule);
      // The user never sees the cron line, so hand back the moment it means.
      let nextRun = null;
      try {
        const next = require("cron-parser").parseExpression(toolInput.cron_expression, { tz: scheduleTz }).next().toDate();
        nextRun = next.toLocaleString("en-GB", { timeZone: scheduleTz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      } catch (_) {}
      return {
        success: true,
        message: `Schedule '${toolInput.name}' created: ${toolInput.cron_expression}`,
        ...(nextRun ? { next_run: `${nextRun} (${scheduleTz})` } : {}),
        note: "Tell the user when this fires (the next_run time, in words). If they never said a time themselves, this is their only chance to hear the one you picked. They can review schedules in their dashboard.",
      };
    }
    case "list_schedules": {
      if (ctx.store.schedules.length === 0) return { schedules: [], message: "No schedules set up yet." };
      return {
        schedules: ctx.store.schedules.map((s) => ({
          name: s.name,
          cron: s.cron,
          prompt: s.prompt,
          enabled: s.enabled,
        })),
      };
    }
    case "remove_schedule": {
      const before = ctx.store.schedules.length;
      ctx.store.schedules = ctx.store.schedules.filter((s) => s.name !== toolInput.name);
      if (ctx.activeUserStore) {
        await ctx.activeUserStore.deleteSchedule(toolInput.name);
      }
      if (cronJobs[toolInput.name]) {
        cronJobs[toolInput.name].stop();
        delete cronJobs[toolInput.name];
      }
      if (ctx.store.schedules.length < before) {
        return { success: true, message: `Schedule '${toolInput.name}' removed.` };
      }
      return { error: `No schedule found with name '${toolInput.name}'` };
    }
    case "pin_fact": {
      _migrateFactsMetadata();
      const now = new Date().toISOString();
      const existing = ctx.store.facts[toolInput.key];
      if (existing && typeof existing === "object" && existing.value !== undefined) {
        // Update existing fact, preserve created date
        ctx.store.facts[toolInput.key] = {
          value: toolInput.value,
          created: existing.created || now,
          lastAccessed: now,
          accessCount: existing.accessCount || 0,
        };
      } else {
        ctx.store.facts[toolInput.key] = {
          value: toolInput.value,
          created: now,
          lastAccessed: now,
          accessCount: 0,
        };
      }
      saveStore();
      // Mirror into data_vectors so Context Brain shows it and passive recall
      // can reach it. Plumbing keys are skipped by the mirror itself.
      try {
        await _factVectors().mirrorFact(ctx.activeUserId, toolInput.key, toolInput.value);
      } catch (e) { /* non-blocking: the fact is saved either way */ }
      // Trigger compaction at 150 facts
      const factCount = Object.keys(ctx.store.facts).length;
      if (factCount >= 150) {
        _compactFacts().catch(e => console.error("[Facts] Compaction error:", e.message));
      }
      return { success: true, message: `Fact '${toolInput.key}' pinned.`, total_facts: factCount };
    }
    case "get_facts": {
      _migrateFactsMetadata();
      const factKeys = Object.keys(ctx.store.facts);
      if (factKeys.length === 0) return { facts: {}, message: "No pinned facts yet." };
      // Bump accessCount and lastAccessed for all recalled facts
      const now = new Date().toISOString();
      const plainFacts = {};
      for (const key of factKeys) {
        const fact = ctx.store.facts[key];
        if (typeof fact === "object" && fact.value !== undefined) {
          fact.accessCount = (fact.accessCount || 0) + 1;
          fact.lastAccessed = now;
          plainFacts[key] = fact.value;
        } else {
          plainFacts[key] = fact;
        }
      }
      saveStore();
      return { facts: plainFacts, count: factKeys.length };
    }
    case "delete_fact": {
      _migrateFactsMetadata();
      if (ctx.store.facts[toolInput.key]) {
        delete ctx.store.facts[toolInput.key];
        // Delete from Supabase directly (saveStore only upserts, doesn't delete)
        if (ctx.activeUserStore) {
          ctx.activeUserStore.deleteFact(toolInput.key).catch(e => console.error("[Facts] Delete error:", e.message));
        }
        // Also delete the fact vector, or the assistant goes on recalling a
        // fact the user just removed.
        _factVectors().removeFactVector(ctx.activeUserId, toolInput.key)
          .catch(e => console.error("[Facts] Vector delete error:", e.message));
        return { success: true, message: `Fact '${toolInput.key}' deleted.` };
      }
      return { error: `No fact found with key '${toolInput.key}'` };
    }
    // --- User Rules (persistent preferences) ---
    case "save_rule": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      if (!userId) return { error: "No active user" };

      let ruleText = toolInput.rule;

      // Load existing rules
      const { data: existing } = await supabase.from("user_rules")
        .select("id, rule").eq("user_id", userId).eq("active", true);

      // Use fast-tier model to distil and check for duplicates
      if (existing && existing.length > 0) {
        try {
          const { client: ruleClient, model: ruleModel } = getInternalClient(userId);
          const existingList = existing.map((r, i) => `${i + 1}. ${r.rule}`).join("\n");
          const response = await ruleClient.messages.create({
            model: ruleModel,
            max_tokens: 200,
            messages: [{ role: "user", content: `A user wants to save this preference: "${ruleText}"

Existing preferences:
${existingList}

Tasks:
1. Distil the new preference into one clear concise sentence (max 15 words)
2. Check if any existing preference covers the same topic. If so, return its number.

Reply in this exact format:
RULE: [distilled rule text]
DUPLICATE: [number or "none"]` }],
          });
          const text = response.content[0]?.text || "";
          const ruleMatch = text.match(/RULE:\s*(.+)/);
          const dupMatch = text.match(/DUPLICATE:\s*(\d+|none)/i);
          if (ruleMatch) ruleText = ruleMatch[1].trim();
          if (dupMatch && dupMatch[1] !== "none") {
            const dupIdx = parseInt(dupMatch[1], 10) - 1;
            if (existing[dupIdx]) {
              // Update existing rule
              await supabase.from("user_rules").update({ rule: ruleText }).eq("id", existing[dupIdx].id);
              return { success: true, message: `Updated existing preference: "${ruleText}"`, updated: true };
            }
          }
        } catch (e) {
          console.error("[Rules] Distil/dedup error:", e.message);
        }
      } else {
        // No existing rules, just distil
        try {
          const { client: distilClient, model: distilModel } = getInternalClient(userId);
          const response = await distilClient.messages.create({
            model: distilModel,
            max_tokens: 100,
            messages: [{ role: "user", content: `Distil this user preference into one clear concise sentence (max 15 words). Return ONLY the distilled rule, nothing else.\n\n"${ruleText}"` }],
          });
          const distilled = response.content[0]?.text?.trim();
          if (distilled && distilled.length < ruleText.length) ruleText = distilled;
        } catch (e) {}
      }

      const { error } = await supabase.from("user_rules").insert({
        // "assistant": saved by ClosedHand from conversation. The dashboard's
        // own add writes "user". The distinction is the first thing needed
        // when a rule looks like something the user never said.
        user_id: userId, rule: ruleText, source: "assistant",
      });
      if (error) return { error: error.message };

      // Refresh cached rules
      const { data: refreshed } = await supabase.from("user_rules")
        .select("id, rule, source").eq("user_id", userId).eq("active", true);
      if (ctx.activeUserStore) ctx.activeUserStore.userRules = (refreshed || []).map(r => ({ id: r.id, rule: r.rule, source: r.source }));
      if (ctx.store) ctx.store.userRules = ctx.activeUserStore?.userRules || [];

      return { success: true, message: `Preference saved: "${ruleText}"` };
    }
    case "get_rules": {
      const rules = ctx.store.userRules || [];
      if (rules.length === 0) return { rules: [], message: "No preferences set yet." };
      return { rules: rules.map(r => r.rule), count: rules.length };
    }
    case "delete_rule": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      if (!userId) return { error: "No active user" };

      const rules = ctx.store.userRules || [];
      const target = toolInput.rule.toLowerCase();
      // Fuzzy match: find the rule that best matches
      const match = rules.find(r => r.rule.toLowerCase().includes(target) || target.includes(r.rule.toLowerCase()));
      if (!match) return { error: "No matching preference found" };

      await supabase.from("user_rules").update({ active: false }).eq("id", match.id);

      // Refresh cached rules
      const { data: refreshed } = await supabase.from("user_rules")
        .select("id, rule, source").eq("user_id", userId).eq("active", true);
      if (ctx.activeUserStore) ctx.activeUserStore.userRules = (refreshed || []).map(r => ({ id: r.id, rule: r.rule, source: r.source }));
      if (ctx.store) ctx.store.userRules = ctx.activeUserStore?.userRules || [];

      return { success: true, message: `Removed preference: "${match.rule}"` };
    }
    case "view_attachment": {
      const data = await loadAttachment(toolInput.attachment_id);
      if (data.error) return data;

      if (data._type === "image") {
        return { _contentType: "image", base64: data.base64, mediaType: data.mediaType, description: data.description };
      } else if (data._type === "pdf") {
        return { _contentType: "pdf", base64: data.base64, mediaType: data.mediaType, description: data.description };
      } else if (data._type === "text") {
        return { _contentType: "text", textContent: data.textContent, fileName: data.fileName, description: data.description };
      } else {
        return data; // unsupported type — returns error message
      }
    }
    case "list_attachments": {
      return { attachments: listAttachments(toolInput._userId || "unknown") };
    }
    case "send_file": {
      const attId = toolInput.attachment_id;
      const chatId = toolInput._chatId;
      if (!chatId) return { error: "No chat ID available to send file." };

      // Find attachment across all users (same structure as loadAttachment)
      let att = null;
      for (const uid of Object.keys(ctx.store.attachments || {})) {
        att = ctx.store.attachments[uid].find((a) => a.id === attId);
        if (att) break;
      }
      if (!att) return { error: `Attachment ${attId} not found.` };

      try {
        // Bytes live on local disk in the process that saved them, but an agent
        // loads attachments from the DB, where there is no local path (only a
        // storagePath). Fall back to storage rather than erroring, the same way
        // loadAttachment does, or send_file fails with "missing from disk".
        let buffer;
        if (att.filePath && fs.existsSync(att.filePath)) {
          buffer = fs.readFileSync(att.filePath);
        } else {
          const { downloadFile } = require("../../user-store");
          buffer = await downloadFile(att.storagePath || `${ctx.activeUserId}/${att.id}`);
        }
        if (!buffer) return { error: `Could not load "${att.fileName || attId}" from disk or storage. Re-fetch it with fetch_attachment (send_to_user: true) instead.` };

        const filename = att.fileName || path.basename(att.filePath || attId);
        const mimeType = att.mediaType || "application/octet-stream";
        await sendDocument(chatId, buffer, filename, mimeType, "email");
        att.lastAccessed = new Date().toISOString();
        saveStore();
        return { success: true, sent: attId, filename };
      } catch (e) {
        return { error: `Failed to send file: ${e.message}` };
      }
    }
    case "web_search": {
      if (!BRAVE_API_KEY) {
        return { error: "Brave Search API key not configured. Add BRAVE_API_KEY to .env file." };
      }
      const query = encodeURIComponent(toolInput.query);
      const count = Math.min(toolInput.count || 5, 10);
      try {
        const { body } = await httpGet(
          `https://api.search.brave.com/res/v1/web/search?q=${query}&count=${count}`,
          { "Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY }
        );
        const data = JSON.parse(body);
        const results = (data.web?.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        }));
        return { results, query: toolInput.query, count: results.length };
      } catch (e) {
        return { error: `Search failed: ${e.message}` };
      }
    }
    case "web_fetch": {
      // SSRF protection — block private/internal addresses
      if (isBlockedUrl(toolInput.url)) {
        return { error: "Blocked: cannot fetch private/internal addresses." };
      }
      try {
        const { body, statusCode } = await httpGet(toolInput.url, {
          "User-Agent": "ClosedHand-Bot/1.0",
          "Accept": "text/html,application/xhtml+xml,text/plain",
        });
        if (statusCode >= 400) {
          return { error: `HTTP ${statusCode} fetching ${toolInput.url}` };
        }
        // Strip HTML tags and clean up whitespace
        let text = body
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, " ")
          .trim();
        // Truncate to avoid huge token costs
        if (text.length > 8000) {
          text = text.substring(0, 8000) + "\n\n[Truncated — page was too long]";
        }
        return { url: toolInput.url, content: text, length: text.length };
      } catch (e) {
        return { error: `Fetch failed: ${e.message}` };
      }
    }
    case "weather_lookup": {
      try {
        let lat = toolInput.latitude;
        let lon = toolInput.longitude;
        let name = toolInput.location_name;
        // Fall back to saved location
        if ((lat === undefined || lon === undefined) && ctx.store.location) {
          lat = ctx.store.location.latitude;
          lon = ctx.store.location.longitude;
          name = name || ctx.store.location.name;
        }
        if (lat === undefined || lon === undefined) {
          return { _needs_location: true, tool: "weather_lookup", message: "I need your location to check the weather." };
        }
        name = name || `${lat},${lon}`;
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&timezone=auto&forecast_days=5`;
        const { body } = await httpGet(url);
        const data = JSON.parse(body);

        // Weather code descriptions
        const wxCodes = {
          0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
          45: "Foggy", 48: "Depositing rime fog",
          51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
          61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
          71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
          77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
          82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
          95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
        };

        const current = data.current;
        const daily = data.daily;
        const result = {
          location: name,
          current: {
            temperature: `${current.temperature_2m}°C`,
            feels_like: `${current.apparent_temperature}°C`,
            humidity: `${current.relative_humidity_2m}%`,
            wind: `${current.wind_speed_10m} km/h`,
            conditions: wxCodes[current.weather_code] || `Code ${current.weather_code}`,
          },
          forecast: [],
        };

        for (let i = 0; i < daily.time.length; i++) {
          result.forecast.push({
            date: daily.time[i],
            high: `${daily.temperature_2m_max[i]}°C`,
            low: `${daily.temperature_2m_min[i]}°C`,
            conditions: wxCodes[daily.weather_code[i]] || `Code ${daily.weather_code[i]}`,
            precipitation: `${daily.precipitation_sum[i]} mm`,
            max_wind: `${daily.wind_speed_10m_max[i]} km/h`,
          });
        }
        return result;
      } catch (e) {
        return { error: `Weather lookup failed: ${e.message}` };
      }
    }
    // --- IMAP mail handlers (zero-project tier) ---
    case "send_mail": {
      const { sendSmtpMail, isImapConnected } = require("../services/imap-mail");
      if (!isImapConnected(ctx.activeUserStore)) return { error: "Email (IMAP) is not connected." };
      try {
        const { attachments, missing } = await resolveOutgoingAttachments(toolInput.attachment_ids);
        if (missing.length) return { error: `Could not find attachment(s) to send: ${missing.join(", ")}. Fetch or upload the file first, then send with its attachment_id.` };
        const r = await sendSmtpMail(ctx.activeUserStore, {
          to: toolInput.to, cc: toolInput.cc, subject: toolInput.subject, body: toolInput.body,
          from_alias: toolInput.from_alias, attachments,
        });
        return { success: true, messageId: r.messageId, from: r.from, to: toolInput.to, attached: attachments.map((a) => a.fileName) };
      } catch (e) {
        return { error: `Send failed: ${e.message}` };
      }
    }
    case "reply_to_mail": {
      const { sendSmtpMail, isImapConnected } = require("../services/imap-mail");
      if (!isImapConnected(ctx.activeUserStore)) return { error: "Email (IMAP) is not connected." };
      try {
        // Threading headers come from the cached original, never guessed.
        const { supabase } = require("../../user-store");
        const { data: rows } = await supabase.from("data_cache").select("data")
          .eq("user_id", ctx.activeUserId).eq("source", "imap").eq("type", "email")
          .eq("external_id", toolInput.message_id).limit(1);
        const orig = rows?.[0]?.data;
        if (!orig) return { error: "No cached message with that id on the IMAP account. Find it with search_cache first (source 'imap')." };
        const subject = (orig.subject || "").startsWith("Re:") ? orig.subject : `Re: ${orig.subject || ""}`;
        const { attachments, missing } = await resolveOutgoingAttachments(toolInput.attachment_ids);
        if (missing.length) return { error: `Could not find attachment(s) to send: ${missing.join(", ")}.` };
        const r = await sendSmtpMail(ctx.activeUserStore, {
          to: orig.from, cc: toolInput.cc, subject, body: toolInput.body,
          from_alias: toolInput.from_alias, attachments,
          inReplyTo: orig.messageId_header || undefined,
          references: orig.messageId_header ? [orig.messageId_header] : undefined,
        });
        return { success: true, messageId: r.messageId, from: r.from, to: orig.from, subject };
      } catch (e) {
        return { error: `Reply failed: ${e.message}` };
      }
    }
    case "create_mail_draft": {
      const { appendImapDraft, isImapConnected } = require("../services/imap-mail");
      if (!isImapConnected(ctx.activeUserStore)) return { error: "Email (IMAP) is not connected." };
      try {
        let to = toolInput.to, subject = toolInput.subject, inReplyTo, references;
        if (toolInput.message_id) {
          const { supabase } = require("../../user-store");
          const { data: rows } = await supabase.from("data_cache").select("data")
            .eq("user_id", ctx.activeUserId).eq("source", "imap").eq("type", "email")
            .eq("external_id", toolInput.message_id).limit(1);
          const orig = rows?.[0]?.data;
          if (!orig) return { error: "No cached message with that id on the IMAP account. Find it with search_cache first." };
          to = to || orig.from;
          subject = subject || ((orig.subject || "").startsWith("Re:") ? orig.subject : `Re: ${orig.subject || ""}`);
          inReplyTo = orig.messageId_header || undefined;
          references = orig.messageId_header ? [orig.messageId_header] : undefined;
        }
        if (!to || !subject) return { error: "A new draft needs to and subject; a reply draft needs message_id." };
        const { attachments, missing } = await resolveOutgoingAttachments(toolInput.attachment_ids);
        if (missing.length) return { error: `Could not find attachment(s): ${missing.join(", ")}.` };
        const r = await appendImapDraft(ctx.activeUserStore, {
          to, cc: toolInput.cc, subject, body: toolInput.body,
          from_alias: toolInput.from_alias, attachments, inReplyTo, references,
        });
        return { success: true, drafts_mailbox: r.drafts_mailbox, from: r.from, note: `Draft saved unsent in the ${r.drafts_mailbox} folder of the connected mailbox. Tell the user where it is.` };
      } catch (e) {
        return { error: `Draft not saved: ${e.message}` };
      }
    }
    // --- Gmail Handlers (send/reply only, search/read handled by Sentinel) ---
    case "gmail_send": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      let gApi; try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
      try {
        const { attachments, missing } = await resolveOutgoingAttachments(toolInput.attachment_ids);
        if (missing.length) return { error: `Could not find attachment(s) to send: ${missing.join(", ")}. Fetch or upload the file first, then send with its attachment_id.` };
        const headerLines = [
          `To: ${toolInput.to}`,
          toolInput.cc ? `Cc: ${toolInput.cc}` : null,
          `Subject: ${toolInput.subject}`,
        ].filter(Boolean);
        const raw = buildGmailRaw(headerLines, toolInput.body, attachments);
        const result = await gApi("POST",
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
          { raw }
        );
        return { success: true, messageId: result.id, to: toolInput.to, attached: attachments.map(a => a.fileName) };
      } catch (e) {
        return { error: `Gmail send failed: ${e.message}` };
      }
    }
    case "gmail_create_draft": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      const isReply = !!toolInput.message_id;
      if (!isReply && (!toolInput.to || !toolInput.subject)) {
        return { error: "A new draft needs to and subject; a reply draft needs message_id and thread_id." };
      }
      // A reply draft belongs in the mailbox that owns the thread, and the
      // cache knows which that is. Trusting the caller's account (or the
      // primary default) is how a nostringspadel reply ended up sitting in a
      // gmail.com drafts folder.
      let draftAccount = toolInput.account || null;
      if (isReply) {
        try {
          const { supabase } = require("../../user-store");
          const { data: cached } = await supabase
            .from("data_cache")
            .select("data")
            .eq("user_id", ctx.activeUserId)
            .eq("type", "email")
            .eq("data->>id", toolInput.message_id)
            .limit(1);
          const owner = cached?.[0]?.data?.account;
          if (owner) {
            if (draftAccount && !owner.toLowerCase().includes(String(draftAccount).toLowerCase())) {
              console.log(`[gmail_create_draft] account "${draftAccount}" does not own this thread; using ${owner}`);
            }
            draftAccount = owner;
          }
        } catch (e) {
          console.log(`[gmail_create_draft] Could not resolve owning account: ${e.message}`);
        }
      }
      const result = await createGmailDraft(isReply ? "gmail_reply" : "gmail_send", { ...toolInput, account: draftAccount });
      if (result.error) return { error: `Draft not saved: ${result.error}` };
      let accountEmail = draftAccount || "primary";
      try {
        const { resolveGoogleAccount, listGoogleAccounts } = require("../services/google");
        const key = resolveGoogleAccount(ctx.activeUserStore, draftAccount);
        accountEmail = (listGoogleAccounts(ctx.activeUserStore).find(a => a.serviceKey === key) || {}).email || accountEmail;
      } catch (_) {}
      return {
        success: true,
        draft_id: result.draftId,
        account: accountEmail,
        note: `Draft saved unsent in the ${accountEmail} account. Tell the user which account it is in.`,
      };
    }
    case "gmail_draft_update": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      // Work out which mailbox the draft is in rather than trusting the caller
      // to say. A draft belongs to exactly one account, the cache knows which,
      // and getting it wrong does not fail: it writes a new draft into a
      // different inbox, which is what happened to a draft on a secondary
      // account that ended up rewritten on the primary.
      let draftAccount = toolInput.account || null;
      try {
        const { supabase } = require("../../user-store");
        const { data: cached } = await supabase
          .from("data_cache")
          .select("data")
          .eq("user_id", ctx.activeUserId)
          .eq("type", "email")
          .eq("data->>draft_id", toolInput.draft_id)
          .limit(1);
        const owner = cached?.[0]?.data?.account;
        if (owner) {
          if (draftAccount && !owner.toLowerCase().includes(String(draftAccount).toLowerCase())) {
            console.log(`[gmail_draft_update] account "${draftAccount}" does not own this draft; using ${owner}`);
          }
          draftAccount = owner;
        }
      } catch (e) {
        console.log(`[gmail_draft_update] Could not resolve owning account: ${e.message}`);
      }

      let dApi; try { dApi = googleReqFor(draftAccount); } catch (e) { return { error: e.message }; }
      try {
        const { replaceTextParts, setHeader, dropOrphanedInlineParts } = require("../gmail-draft");

        // Fetch the draft as it stands and edit that, rather than composing a
        // replacement. Everything the user already has in there, above all the
        // inline images, only survives if the original message is what gets
        // modified.
        const existing = await dApi("GET",
          `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(toolInput.draft_id)}?format=raw`);
        if (!existing?.message?.raw) return { error: "Could not read that draft. Check the draft_id from search_cache." };

        let raw = Buffer.from(existing.message.raw, "base64url").toString("utf-8");
        const keepImages = toolInput.keep_inline_images !== false;
        const { raw: edited, replaced } = replaceTextParts(raw, toolInput.body, toolInput.body_html || null, keepImages);
        if (replaced === 0) return { error: "That draft has no editable text part, so its wording could not be replaced." };
        raw = edited;

        // Asked to drop the pictures: take the parts out too, or they linger as
        // stray attachments, which is not what removing them means.
        let imagesRemoved = 0;
        if (!keepImages) {
          const pruned = dropOrphanedInlineParts(raw);
          raw = pruned.raw;
          imagesRemoved = pruned.removed;
        }

        // Headers only change when explicitly asked, so an edit to the wording
        // cannot quietly redirect who it goes to.
        if (toolInput.to) raw = setHeader(raw, "To", toolInput.to);
        if (toolInput.cc) raw = setHeader(raw, "Cc", toolInput.cc);
        if (toolInput.subject) raw = setHeader(raw, "Subject", toolInput.subject);

        // Carry the thread across. Gmail re-threads an updated draft from what
        // it is given, so omitting threadId moves a reply out of its
        // conversation and onto a new one of its own. The draft still says
        // "Re:" and still looks right in the drafts list, so the damage only
        // shows when it arrives as a fresh email the recipient cannot place.
        const threadId = existing.message.threadId;
        const result = await dApi("PUT",
          `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(toolInput.draft_id)}`,
          { id: toolInput.draft_id, message: { raw: Buffer.from(raw, "utf-8").toString("base64url"), ...(threadId ? { threadId } : {}) } });

        return {
          success: true,
          draft_id: result.id || toolInput.draft_id,
          text_parts_updated: replaced,
          images_removed: imagesRemoved,
          account: draftAccount || "primary",
          note: keepImages
            ? "Draft rewritten and still unsent. Attachments and inline images left in place."
            : `Draft rewritten and still unsent. ${imagesRemoved} inline image(s) removed as asked.`,
        };
      } catch (e) {
        const msg = /403|insufficient|scope/i.test(e.message)
          ? "Editing drafts needs the compose permission, which this Google connection was not granted. Tell the user that reconnecting Google from the dashboard fixes it, and give them the revised wording meanwhile."
          : /404|not found/i.test(e.message)
          // It answered a 404 by creating its own draft and editing that, so the
          // user's draft was never touched while the run reported success.
          ? "No draft with that id. You have probably passed the message id instead of the draft_id: check the draft_id field on the cached draft. Do NOT create a new draft to work around this, the user asked you to edit an existing one."
          : `Gmail draft update failed: ${e.message}`;
        return { error: msg };
      }
    }
    case "outlook_send": {
      if (!isMicrosoftConnected()) return { error: "Microsoft not connected — connect it from your dashboard" };
      try {
        const msApi = microsoftReqFor(toolInput.account);
        const toRecipients = String(toolInput.to).split(",").map(a => ({ emailAddress: { address: a.trim() } }));
        const ccRecipients = toolInput.cc ? String(toolInput.cc).split(",").map(a => ({ emailAddress: { address: a.trim() } })) : undefined;
        await msApi("POST", "https://graph.microsoft.com/v1.0/me/sendMail", {
          message: {
            subject: toolInput.subject,
            body: { contentType: "Text", content: toolInput.body },
            toRecipients,
            ...(ccRecipients ? { ccRecipients } : {}),
          },
          saveToSentItems: true,
        });
        return { success: true, to: toolInput.to, subject: toolInput.subject };
      } catch (e) {
        return { error: `Outlook send failed: ${e.message}` };
      }
    }
    case "outlook_reply": {
      if (!isMicrosoftConnected()) return { error: "Microsoft not connected — connect it from your dashboard" };
      try {
        const msApi = microsoftReqFor(toolInput.account);
        await msApi("POST",
          `https://graph.microsoft.com/v1.0/me/messages/${toolInput.message_id}/reply`,
          { comment: toolInput.body }
        );
        return { success: true, repliedTo: toolInput.message_id };
      } catch (e) {
        return { error: `Outlook reply failed: ${e.message}` };
      }
    }
    case "outlook_cal_create_event": {
      if (!isMicrosoftConnected()) return { error: "Microsoft not connected — connect it from your dashboard" };
      try {
        const result = await microsoftApiRequest("POST", "https://graph.microsoft.com/v1.0/me/events", {
          subject: toolInput.subject,
          start: { dateTime: new Date(toolInput.start).toISOString().replace(/\.\d{3}Z$/, ""), timeZone: "UTC" },
          end: { dateTime: new Date(toolInput.end).toISOString().replace(/\.\d{3}Z$/, ""), timeZone: "UTC" },
          ...(toolInput.location ? { location: { displayName: toolInput.location } } : {}),
          ...(toolInput.body ? { body: { contentType: "Text", content: toolInput.body } } : {}),
        });
        return { success: true, eventId: result.id, subject: toolInput.subject, start: toolInput.start, end: toolInput.end };
      } catch (e) {
        return { error: `Outlook event create failed: ${e.message}` };
      }
    }
    case "outlook_cal_update_event": {
      if (!isMicrosoftConnected()) return { error: "Microsoft not connected — connect it from your dashboard" };
      try {
        const patch = {};
        if (toolInput.subject) patch.subject = toolInput.subject;
        if (toolInput.start) patch.start = { dateTime: new Date(toolInput.start).toISOString().replace(/\.\d{3}Z$/, ""), timeZone: "UTC" };
        if (toolInput.end) patch.end = { dateTime: new Date(toolInput.end).toISOString().replace(/\.\d{3}Z$/, ""), timeZone: "UTC" };
        if (toolInput.location) patch.location = { displayName: toolInput.location };
        if (toolInput.body) patch.body = { contentType: "Text", content: toolInput.body };
        await microsoftApiRequest("PATCH", `https://graph.microsoft.com/v1.0/me/events/${toolInput.event_id}`, patch);
        return { success: true, updated: Object.keys(patch) };
      } catch (e) {
        return { error: `Outlook event update failed: ${e.message}` };
      }
    }
    case "outlook_cal_delete_event": {
      if (!isMicrosoftConnected()) return { error: "Microsoft not connected — connect it from your dashboard" };
      try {
        await microsoftApiRequest("DELETE", `https://graph.microsoft.com/v1.0/me/events/${toolInput.event_id}`);
        return { success: true };
      } catch (e) {
        return { error: `Outlook event delete failed: ${e.message}` };
      }
    }
    case "gmail_reply": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      let gApi; try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
      try {
        // Get original message headers for reply
        const original = await gApi("GET",
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${toolInput.message_id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID`
        );
        const headers = original.payload?.headers || [];
        const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
        const subject = getHeader("Subject").startsWith("Re:") ? getHeader("Subject") : `Re: ${getHeader("Subject")}`;
        const replyTo = getHeader("From");
        const messageId = getHeader("Message-ID");

        const { attachments, missing } = await resolveOutgoingAttachments(toolInput.attachment_ids);
        if (missing.length) return { error: `Could not find attachment(s) to send: ${missing.join(", ")}. Fetch or upload the file first, then reply with its attachment_id.` };
        const headerLines = [
          `To: ${replyTo}`,
          `Subject: ${subject}`,
          `In-Reply-To: ${messageId}`,
          `References: ${messageId}`,
        ];
        const raw = buildGmailRaw(headerLines, toolInput.body, attachments);
        const result = await gApi("POST",
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
          { raw, threadId: toolInput.thread_id }
        );
        return { success: true, messageId: result.id, repliedTo: replyTo, attached: attachments.map(a => a.fileName) };
      } catch (e) {
        return { error: `Gmail reply failed: ${e.message}` };
      }
    }
    // --- Google Calendar Handlers (create/delete only, list/search handled by Sentinel) ---
    case "gcal_create_event": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      let gApi; try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
      try {
        const event = {
          summary: toolInput.summary,
          start: { dateTime: toolInput.start },
          end: { dateTime: toolInput.end },
        };
        if (toolInput.description) event.description = toolInput.description;
        if (toolInput.location) event.location = toolInput.location;
        if (toolInput.attendees) {
          event.attendees = toolInput.attendees.split(",").map((e) => ({ email: e.trim() }));
        }
        // Attach Drive file if provided
        if (toolInput.drive_file_id) {
          try {
            const fileInfo = await gApi("GET",
              `https://www.googleapis.com/drive/v3/files/${toolInput.drive_file_id}?fields=id,name,mimeType,webViewLink,iconLink`
            );
            event.attachments = [{
              fileId: fileInfo.id,
              fileUrl: fileInfo.webViewLink,
              title: fileInfo.name,
              mimeType: fileInfo.mimeType,
              iconLink: fileInfo.iconLink || "",
            }];
          } catch (e) {
            console.error("Could not attach Drive file:", e.message);
          }
        }
        const calUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
          (event.attachments ? `?supportsAttachments=true` : ``);
        const result = await gApi("POST", calUrl, event);
        return {
          success: true,
          id: result.id,
          summary: result.summary,
          start: result.start?.dateTime || result.start?.date,
          link: result.htmlLink,
          hasAttachment: !!toolInput.drive_file_id,
        };
      } catch (e) {
        return { error: `Google Calendar create failed: ${e.message}` };
      }
    }
    // --- Google Drive Handlers ---
    case "drive_search": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      let gApi; try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
      try {
        const maxResults = Math.min(toolInput.max_results || 10, 20);
        let q;
        let useRelevanceOrder = false;

        if (toolInput.folder_id) {
          q = `'${toolInput.folder_id}' in parents and trashed=false`;
        } else if (toolInput.query) {
          const escaped = toolInput.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          q = `fullText contains '${escaped}' and trashed=false`;
          useRelevanceOrder = true;
        } else {
          return { error: "Provide either a query or folder_id" };
        }

        const fields = "files(id,name,mimeType,modifiedTime,size,webViewLink,owners)";
        let raw;
        // A folder id belongs to one account, so a folder listing stays single
        // account. A free-text query with no account named sweeps them all.
        if (!toolInput.account && !toolInput.folder_id) {
          raw = await driveQueryAllAccounts(q, fields, maxResults, useRelevanceOrder ? "" : "name");
        } else {
          let data;
          if (!toolInput.account && isGwsAvailable()) {
            try {
              const params = { q, pageSize: maxResults, fields };
              if (!useRelevanceOrder) params.orderBy = "name";
              const escaped = JSON.stringify(params).replace(/'/g, "\\'");
              data = await gwsCommand(`drive files list --params '${escaped}' --format json`);
            } catch (e) { console.error("[drive] gws failed, falling back to HTTP:", e.message); data = null; }
          }
          if (!data) {
            const orderBy = useRelevanceOrder ? "" : "&orderBy=name";
            data = await gApi("GET",
              `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${maxResults}&fields=${fields}${orderBy}`
            );
          }
          raw = data.files || [];
        }

        const files = raw.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.mimeType,
          isFolder: f.mimeType === "application/vnd.google-apps.folder",
          modified: f.modifiedTime,
          size: f.size ? `${(parseInt(f.size) / 1024).toFixed(0)}KB` : null,
          link: f.webViewLink,
          owner: f.owners?.[0]?.emailAddress || null,
          account: f._account || undefined,
        }));
        return { files, count: files.length, query: toolInput.query || `folder:${toolInput.folder_id}` };
      } catch (e) {
        return { error: `Drive search failed: ${e.message}` };
      }
    }
    case "drive_list_recent": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      let gApi; try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
      try {
        const maxResults = Math.min(toolInput.max_results || 10, 20);
        const fields = "files(id,name,mimeType,modifiedTime,size,webViewLink)";
        let raw;
        if (!toolInput.account) {
          // Recent across every account, then a single sort so the newest
          // wins regardless of which account it lives on.
          raw = await driveQueryAllAccounts("trashed=false", fields, maxResults, "modifiedTime desc");
          raw.sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || ""))).splice(maxResults);
        } else {
          const data = await gApi("GET",
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("trashed=false")}&pageSize=${maxResults}&fields=${fields}&orderBy=modifiedTime+desc`
          );
          raw = data.files || [];
        }
        const files = raw.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.mimeType,
          modified: f.modifiedTime,
          size: f.size ? `${(parseInt(f.size) / 1024).toFixed(0)}KB` : null,
          link: f.webViewLink,
          account: f._account || undefined,
        }));
        return { files, count: files.length };
      } catch (e) {
        return { error: `Drive list failed: ${e.message}` };
      }
    }
    case "drive_read": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      let gApi; try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
      try {
        // First get file metadata to determine type
        const meta = await gApi("GET",
          `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}?fields=id,name,mimeType,size`
        );
        const mime = meta.mimeType;
        let content = "";

        if (mime === "application/vnd.google-apps.document") {
          // Google Doc → export as plain text
          const { body } = await httpGet(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}/export?mimeType=text/plain`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          content = body;
        } else if (mime === "application/vnd.google-apps.spreadsheet") {
          // Google Sheet → export as CSV
          const { body } = await httpGet(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}/export?mimeType=text/csv`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          content = body;
        } else if (mime === "application/vnd.google-apps.presentation") {
          // Google Slides → export as plain text
          const { body } = await httpGet(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}/export?mimeType=text/plain`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          content = body;
        } else if (mime === "text/plain" || mime === "text/csv" || mime === "text/html" || mime === "application/json") {
          // Plain text files → download directly
          const { body } = await httpGet(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}?alt=media`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          content = body;
        } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
          // Uploaded .docx → download binary, extract with mammoth
          const { buffer } = await httpGetBuffer(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}?alt=media`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          try {
            const result = await mammoth.extractRawText({ buffer });
            content = result.value;
          } catch (e) { content = "[Could not extract text from docx]"; }
        } else if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
          // Uploaded .xlsx → download binary, extract with xlsx
          const { buffer } = await httpGetBuffer(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}?alt=media`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          try {
            const workbook = XLSX.read(buffer, { type: "buffer" });
            const sheets = [];
            for (const name of workbook.SheetNames) {
              const sheet = workbook.Sheets[name];
              const csv = XLSX.utils.sheet_to_csv(sheet);
              sheets.push(`--- Sheet: ${name} ---\n${csv}`);
            }
            content = sheets.join("\n\n");
          } catch (e) { content = "[Could not extract text from xlsx]"; }
        } else if (mime === "application/pdf") {
          content = `[PDF file: ${meta.name} — use drive_send_file to send it to the user. Size: ${meta.size ? (parseInt(meta.size) / 1024).toFixed(0) + "KB" : "unknown"}]`;
        } else {
          content = `[Binary file: ${meta.name} (${mime}) — use drive_send_file to send it to the user. Size: ${meta.size ? (parseInt(meta.size) / 1024).toFixed(0) + "KB" : "unknown"}]`;
        }

        // Truncate if huge
        if (content.length > 8000) {
          content = content.substring(0, 8000) + "\n\n[Truncated — file was too long]";
        }

        return { name: meta.name, type: mime, content };
      } catch (e) {
        return { error: `Drive read failed: ${e.message}` };
      }
    }
    case "drive_send_file": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      const chatId = toolInput._chatId;
      if (!chatId) return { error: "No chat ID available to send file." };
      try {
        // Get file metadata
        const meta = await googleApiRequest("GET",
          `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}?fields=id,name,mimeType,size`
        );
        const mime = meta.mimeType;

        // Google-native files need to be exported first
        let buffer, fileName;
        if (mime === "application/vnd.google-apps.document") {
          const { buffer: buf } = await httpGetBuffer(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}/export?mimeType=application/pdf`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          buffer = buf;
          fileName = meta.name.replace(/\.[^.]*$/, "") + ".pdf";
        } else if (mime === "application/vnd.google-apps.spreadsheet") {
          const { buffer: buf } = await httpGetBuffer(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          buffer = buf;
          fileName = meta.name.replace(/\.[^.]*$/, "") + ".xlsx";
        } else if (mime === "application/vnd.google-apps.presentation") {
          const { buffer: buf } = await httpGetBuffer(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}/export?mimeType=application/pdf`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          buffer = buf;
          fileName = meta.name.replace(/\.[^.]*$/, "") + ".pdf";
        } else if (mime === "application/vnd.google-apps.folder") {
          return { error: `"${meta.name}" is a folder, not a file. Use drive_search with folder_id to list its contents.` };
        } else {
          // Regular file — download directly
          const { buffer: buf } = await httpGetBuffer(
            `https://www.googleapis.com/drive/v3/files/${toolInput.file_id}?alt=media`,
            { Authorization: `Bearer ${await getGoogleToken()}` }
          );
          buffer = buf;
          fileName = meta.name;
        }

        // Send via cross-platform sendDocument
        const ext = fileName.split(".").pop().toLowerCase();
        const sendMime = MIME_TYPES[ext] || mime;
        await sendDocument(chatId, buffer, fileName, sendMime, "drive");
        return { success: true, sent: fileName, type: mime, size: `${(buffer.length / 1024).toFixed(0)}KB` };
      } catch (e) {
        return { error: `Drive send failed: ${e.message}` };
      }
    }
    // --- Air Quality Handler ---
    case "air_quality": {
      if (!GOOGLE_MAPS_API_KEY) return { error: "Google Maps API key not configured." };
      try {
        let lat = toolInput.latitude;
        let lng = toolInput.longitude;
        // Fall back to saved location
        if ((lat === undefined || lng === undefined) && ctx.store.location) {
          lat = ctx.store.location.latitude;
          lng = ctx.store.location.longitude;
        }
        if (lat === undefined || lng === undefined) {
          return { _needs_location: true, tool: "air_quality", message: "I need your location to check air quality." };
        }
        const postData = JSON.stringify({
          location: { latitude: lat, longitude: lng },
        });
        const result = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: "airquality.googleapis.com",
            path: `/v1/currentConditions:lookup?key=${GOOGLE_MAPS_API_KEY}`,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
          }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const data = JSON.parse(Buffer.concat(chunks).toString());
              resolve(data);
            });
          });
          req.on("error", reject);
          req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
          req.write(postData);
          req.end();
        });
        if (result.error) { console.error(`Air quality error: ${result.error.message}`); return { error: `Air quality API error: ${result.error.message}` }; }
        const idx = (result.indexes || [])[0];
        const location = ctx.store.location?.name || `${lat},${lng}`;
        return {
          location,
          aqi: idx?.aqi || null,
          category: idx?.category || null,
          dominantPollutant: idx?.dominantPollutant || null,
          color: idx?.color || null,
          healthRecommendations: result.healthRecommendations || null,
        };
      } catch (e) {
        console.error(`Air quality error: ${e.message}`);
        return { error: `Air quality lookup failed: ${e.message}` };
      }
    }
    // --- Location Handler ---
    case "send_location": {
      try {
        await sendLocation(toolInput._chatId, toolInput.latitude, toolInput.longitude, toolInput.name, toolInput.address);
        return { success: true, sent_to: ctx.activePlatform };
      } catch (e) {
        console.error(`send_location error: ${e.message}`);
        return { error: `Failed to send location: ${e.message}` };
      }
    }
    case "save_location": {
      ctx.store.location = {
        name: toolInput.name,
        latitude: toolInput.latitude,
        longitude: toolInput.longitude,
        updated: new Date().toISOString(),
      };
      // Resolve the IANA timezone for the new location: quiet hours, reminders,
      // and all user-facing times follow it
      const { fetchTimezoneFor } = require("../timezone");
      const tz = await fetchTimezoneFor(toolInput.latitude, toolInput.longitude);
      if (tz) ctx.store.location.timezone = tz;
      saveStore();
      return { success: true, message: `Location saved: ${toolInput.name} (${toolInput.latitude}, ${toolInput.longitude})${tz ? `, timezone ${tz}` : ""}` };
    }
    // --- Google Maps Handlers ---
    case "maps_search_places": {
      if (!GOOGLE_MAPS_API_KEY) return { error: "Google Maps API key not configured. Add GOOGLE_MAPS_API_KEY to .env file." };
      try {
        const query = encodeURIComponent(toolInput.query);
        let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${GOOGLE_MAPS_API_KEY}`;
        // Use provided location, or fall back to saved location
        const loc = toolInput.location || (ctx.store.location ? `${ctx.store.location.latitude},${ctx.store.location.longitude}` : null);
        if (loc) url += `&location=${loc}&radius=${toolInput.radius || 5000}`;
        const { body } = await httpGet(url);
        const data = JSON.parse(body);
        if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
          console.error(`Maps API error: ${data.status} — ${data.error_message || ""}`);
          return { error: `Maps API error: ${data.status} — ${data.error_message || ""}` };
        }
        const places = (data.results || []).slice(0, 10).map((p) => {
          const lat = p.geometry?.location?.lat;
          const lng = p.geometry?.location?.lng;
          return {
            name: p.name,
            address: p.formatted_address,
            latitude: lat,
            longitude: lng,
            rating: p.rating ? `${p.rating}/5 (${p.user_ratings_total} reviews)` : null,
            open_now: p.opening_hours?.open_now ?? null,
            type: (p.types || []).slice(0, 3).join(", "),
            google_maps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=${p.place_id}`,
            apple_maps: lat && lng ? `https://maps.apple.com/?q=${encodeURIComponent(p.name)}&ll=${lat},${lng}` : null,
          };
        });
        return { places, count: places.length, query: toolInput.query, _hint: "Call send_location for your top 1-2 picks so the user gets a tappable map pin." };
      } catch (e) {
        console.error(`Places search error: ${e.message}`);
        return { error: `Places search failed: ${e.message}` };
      }
    }
    case "maps_directions": {
      if (!GOOGLE_MAPS_API_KEY) return { error: "Google Maps API key not configured. Add GOOGLE_MAPS_API_KEY to .env file." };
      try {
        const origin = encodeURIComponent(toolInput.origin);
        const dest = encodeURIComponent(toolInput.destination);
        const mode = toolInput.mode || "transit";
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${dest}&mode=${mode}&key=${GOOGLE_MAPS_API_KEY}`;
        const { body } = await httpGet(url);
        const data = JSON.parse(body);
        if (data.status !== "OK") {
          console.error(`Directions error: ${data.status} — ${data.error_message || ""}`);
          return { error: `Directions error: ${data.status} — ${data.error_message || "No route found"}` };
        }
        const route = data.routes[0];
        const leg = route.legs[0];
        const steps = leg.steps.map((s) => {
          const instruction = s.html_instructions ? s.html_instructions.replace(/<[^>]+>/g, "") : "";
          const transit = s.transit_details ? {
            line: s.transit_details.line?.short_name || s.transit_details.line?.name,
            vehicle: s.transit_details.line?.vehicle?.type,
            departure_stop: s.transit_details.departure_stop?.name,
            arrival_stop: s.transit_details.arrival_stop?.name,
            num_stops: s.transit_details.num_stops,
          } : null;
          return {
            instruction,
            distance: s.distance?.text,
            duration: s.duration?.text,
            mode: s.travel_mode?.toLowerCase(),
            transit,
          };
        });
        const googleMapsLink = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=${mode}`;
        const appleMapsLink = `https://maps.apple.com/?saddr=${origin}&daddr=${dest}&dirflg=${mode === "driving" ? "d" : mode === "walking" ? "w" : mode === "transit" ? "r" : "d"}`;
        return {
          summary: route.summary,
          distance: leg.distance?.text,
          duration: leg.duration?.text,
          departure_time: leg.departure_time?.text || null,
          arrival_time: leg.arrival_time?.text || null,
          steps,
          google_maps: googleMapsLink,
          apple_maps: appleMapsLink,
        };
      } catch (e) {
        console.error(`Directions error: ${e.message}`);
        return { error: `Directions failed: ${e.message}` };
      }
    }
    case "maps_geocode": {
      if (!GOOGLE_MAPS_API_KEY) return { error: "Google Maps API key not configured. Add GOOGLE_MAPS_API_KEY to .env file." };
      try {
        const addr = encodeURIComponent(toolInput.address);
        // Check if it looks like coordinates (for reverse geocoding)
        const coordMatch = toolInput.address.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
        let url;
        if (coordMatch) {
          url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${coordMatch[1]},${coordMatch[2]}&key=${GOOGLE_MAPS_API_KEY}`;
        } else {
          url = `https://maps.googleapis.com/maps/api/geocode/json?address=${addr}&key=${GOOGLE_MAPS_API_KEY}`;
        }
        const { body } = await httpGet(url);
        const data = JSON.parse(body);
        if (data.status !== "OK") {
          console.error(`Geocode error: ${data.status}`);
          return { error: `Geocode error: ${data.status}` };
        }
        const result = data.results[0];
        const loc = result.geometry.location;
        return {
          formatted_address: result.formatted_address,
          latitude: loc.lat,
          longitude: loc.lng,
          google_maps: `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`,
          apple_maps: `https://maps.apple.com/?ll=${loc.lat},${loc.lng}&q=${encodeURIComponent(result.formatted_address)}`,
        };
      } catch (e) {
        console.error(`Geocode error: ${e.message}`);
        return { error: `Geocode failed: ${e.message}` };
      }
    }
    // --- TfL Handlers ---
    case "tfl_line_status": {
      try {
        let url;
        if (toolInput.line) {
          url = `https://api.tfl.gov.uk/Line/${encodeURIComponent(toolInput.line)}/Status`;
        } else {
          url = `https://api.tfl.gov.uk/Line/Mode/tube,overground,elizabeth-line,dlr,tram/Status`;
        }
        const { body } = await httpGet(url);
        const data = JSON.parse(body);
        const lines = (Array.isArray(data) ? data : [data]).map((line) => {
          const statuses = (line.lineStatuses || []).map((s) => ({
            status: s.statusSeverityDescription,
            reason: s.reason || null,
          }));
          return {
            name: line.name,
            id: line.id,
            statuses,
          };
        });
        return { lines, count: lines.length };
      } catch (e) {
        console.error(`TfL status error: ${e.message}`);
        return { error: `TfL status failed: ${e.message}` };
      }
    }
    case "tfl_journey": {
      try {
        const from = encodeURIComponent(toolInput.from);
        const to = encodeURIComponent(toolInput.to);
        let url = `https://api.tfl.gov.uk/Journey/JourneyResults/${from}/to/${to}?mode=tube,bus,overground,dlr,elizabeth-line,national-rail,walking`;
        if (toolInput.time) url += `&time=${toolInput.time}`;
        if (toolInput.date) url += `&date=${toolInput.date}`;
        const { body } = await httpGet(url);
        const data = JSON.parse(body);
        if (!data.journeys || data.journeys.length === 0) {
          return { error: "No journeys found for that route." };
        }
        const journeys = data.journeys.slice(0, 3).map((j) => {
          const legs = j.legs.map((leg) => ({
            mode: leg.mode?.name,
            line: leg.routeOptions?.[0]?.name || null,
            from: leg.departurePoint?.commonName,
            to: leg.arrivalPoint?.commonName,
            departure: leg.departureTime,
            arrival: leg.arrivalTime,
            duration: leg.duration,
            direction: leg.routeOptions?.[0]?.direction || null,
            stops: leg.path?.stopPoints?.length || null,
            instruction: leg.instruction?.summary || null,
          }));
          return {
            duration: j.duration,
            departure: j.startDateTime,
            arrival: j.arrivalDateTime,
            legs,
          };
        });
        return { journeys, count: journeys.length };
      } catch (e) {
        console.error(`TfL journey error: ${e.message}`);
        return { error: `TfL journey failed: ${e.message}` };
      }
    }
    case "tfl_departures": {
      try {
        const stationQuery = encodeURIComponent(toolInput.station);
        // Step 1: Find the station's NaPTAN ID — search tube first, then broader
        const { body: searchBody } = await httpGet(
          `https://api.tfl.gov.uk/StopPoint/Search/${stationQuery}?modes=tube,overground,dlr,elizabeth-line&maxResults=5`
        );
        const searchData = JSON.parse(searchBody);
        const matches = searchData.matches || [];
        if (matches.length === 0) {
          console.error(`TfL: No station found for "${toolInput.station}"`);
          return { error: `No station found matching "${toolInput.station}". Try the full station name.` };
        }

        console.log(`TfL departures: Found ${matches.length} stations for "${toolInput.station}": ${matches.map(m => `${m.name} (${m.id})`).join(", ")}`);

        // Step 2: Try each match until we get arrivals (some station IDs return empty)
        for (const station of matches) {
          const naptanId = station.id;
          const stationName = station.name;

          const { body: arrivalsBody } = await httpGet(
            `https://api.tfl.gov.uk/StopPoint/${naptanId}/Arrivals`
          );
          let arrivals = JSON.parse(arrivalsBody);

          console.log(`TfL departures: ${stationName} (${naptanId}) returned ${Array.isArray(arrivals) ? arrivals.length : 0} arrivals`);

          if (!Array.isArray(arrivals) || arrivals.length === 0) continue;

          // Filter by line if specified
          if (toolInput.line) {
            const lineLower = toolInput.line.toLowerCase();
            arrivals = arrivals.filter((a) =>
              (a.lineName || "").toLowerCase().includes(lineLower) ||
              (a.lineId || "").toLowerCase().includes(lineLower)
            );
          }

          // Filter by direction if specified
          if (toolInput.direction) {
            arrivals = arrivals.filter((a) =>
              (a.direction || "").toLowerCase() === toolInput.direction.toLowerCase()
            );
          }

          if (arrivals.length === 0) continue;

          // Sort by time to station and take next 10
          arrivals.sort((a, b) => a.timeToStation - b.timeToStation);
          const nextArrivals = arrivals.slice(0, 10).map((a) => ({
            line: a.lineName,
            destination: a.destinationName,
            platform: a.platformName,
            minutes: Math.round(a.timeToStation / 60),
            expected: a.expectedArrival,
            direction: a.direction,
          }));

          return { station: stationName, departures: nextArrivals, count: nextArrivals.length };
        }

        // None of the matches had arrivals
        const stationName = matches[0].name;
        console.error(`TfL: No arrivals data for any match of "${toolInput.station}"`);
        return { station: stationName, departures: [], message: "No live departures found — service may have ended or TfL isn't providing real-time data for this station right now." };
      } catch (e) {
        console.error(`TfL departures error: ${e.message}`);
        return { error: `TfL departures failed: ${e.message}` };
      }
    }
    case "gcal_update_event": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      let gApi; try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
      if (!toolInput.event_id) return { error: "event_id is required. Use search_calendar to find it." };
      try {
        // PATCH so unspecified fields keep their current values
        const patch = {};
        if (toolInput.summary) patch.summary = toolInput.summary;
        if (toolInput.description) patch.description = toolInput.description;
        if (toolInput.location) patch.location = toolInput.location;
        if (toolInput.start) patch.start = { dateTime: toolInput.start };
        if (toolInput.end) patch.end = { dateTime: toolInput.end };
        if (Object.keys(patch).length === 0) return { error: "Nothing to update — pass at least one field to change." };
        const result = await gApi("PATCH",
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(toolInput.event_id)}`,
          patch
        );
        return {
          success: true,
          id: result.id,
          summary: result.summary,
          start: result.start?.dateTime || result.start?.date,
          end: result.end?.dateTime || result.end?.date,
          link: result.htmlLink,
        };
      } catch (e) {
        return { error: `Google Calendar update failed: ${e.message}` };
      }
    }

    case "gcal_delete_event": {
      if (!isGoogleConnected()) return { error: "Google not connected — connect it from your dashboard" };
      let gApi; try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
      try {
        // Fetch event first to check for attachments
        let driveFilesDeleted = 0;
        try {
          const event = await gApi("GET",
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${toolInput.event_id}`
          );
          if (event.attachments && event.attachments.length > 0) {
            // Get our folder ID to verify attachments belong to us
            const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
            const folderSearch = await gApi("GET",
              `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`
            );
            const folderId = folderSearch.files?.[0]?.id;

            if (folderId) {
              for (const att of event.attachments) {
                try {
                  // Check if this file is in our folder
                  const fileInfo = await gApi("GET",
                    `https://www.googleapis.com/drive/v3/files/${att.fileId}?fields=id,parents`
                  );
                  if (fileInfo.parents && fileInfo.parents.includes(folderId)) {
                    await deleteFromDrive(att.fileId);
                    driveFilesDeleted++;
                  }
                } catch (e) {
                  console.error(`Could not clean up Drive file ${att.fileId}:`, e.message);
                }
              }
            }
          }
        } catch (e) {
          // Event fetch failed — still try to delete
          console.error("Could not fetch event for attachment cleanup:", e.message);
        }

        await gApi("DELETE",
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${toolInput.event_id}`
        );
        return { success: true, deleted: toolInput.event_id, driveFilesDeleted };
      } catch (e) {
        return { error: `Google Calendar delete failed: ${e.message}` };
      }
    }
    case "calendar_delete_event": {
      const title = toolInput.event_title;
      const date = toolInput.event_date || "";
      const source = toolInput.source || "";
      const userId = ctx.activeUserId || toolInput._userId;
      if (!title) return { error: "Event title required" };

      // Try Apple Calendar via Bridge (most common for Exchange events)
      if (!source || source === "mac_calendar" || source === "bridge") {
        try {
          const { bridgeRequest } = require("../services/bridge-relay");
          // AppleScript to find and delete the event by title and approximate date
          const escapedTitle = title.replace(/"/g, '\\"');
          const cmd = `osascript -e 'tell application "Calendar"' -e 'set found to false' -e 'repeat with cal in calendars' -e 'set evts to (every event of cal whose summary is "${escapedTitle}")' -e 'repeat with e in evts' -e 'delete e' -e 'set found to true' -e 'end repeat' -e 'end repeat' -e 'return found' -e 'end tell'`;
          const result = await bridgeRequest(userId, "shell.run", { command: cmd, timeout: 20 }, 25000);
          const output = (result?.stdout || result?.result?.stdout || "").trim();
          if (output === "true") {
            // Also remove from data_cache
            const { supabase } = require("../../user-store");
            await supabase.from("data_cache").delete()
              .eq("user_id", userId)
              .eq("source", "mac_calendar")
              .eq("type", "event")
              .ilike("data->>summary", `%${title.substring(0, 50)}%`).catch(() => {});
            return { success: true, deleted: title, source: "Apple Calendar" };
          }
        } catch (e) {
          if (source === "mac_calendar" || source === "bridge") {
            return { error: `Failed to delete from Apple Calendar: ${e.message}` };
          }
          // Fall through to try Google
        }
      }

      // Try Google Calendar
      if (!source || source === "gcal") {
        try {
          if (isGoogleConnected()) {
            // Search for the event by title
            const q = encodeURIComponent(title);
            const searchUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${q}&maxResults=5&singleEvents=true`;
            const data = await googleApiRequest("GET", searchUrl);
            const match = (data.items || []).find(e => e.summary && e.summary.includes(title.substring(0, 30)));
            if (match) {
              await googleApiRequest("DELETE", `https://www.googleapis.com/calendar/v3/calendars/primary/events/${match.id}`);
              return { success: true, deleted: title, source: "Google Calendar", event_id: match.id };
            }
          }
        } catch (e) {
          return { error: `Failed to delete from Google Calendar: ${e.message}` };
        }
      }

      return { error: `Could not find event "${title}" in any connected calendar` };
    }

    // --- CalDAV calendar (env-configured; iCloud and friends, bridge-free) ---
    case "caldav_list_events": {
      try {
        const events = await require("../services/caldav").listEvents(toolInput.from, toolInput.to);
        return { count: events.length, events: events.slice(0, 50) };
      } catch (e) { return { error: `CalDAV list failed: ${e.message}` }; }
    }

    case "caldav_create_event": {
      try {
        const r = await require("../services/caldav").createEvent(toolInput);
        return { success: true, summary: toolInput.summary, start: toolInput.start, end: toolInput.end, calendar: r.calendar };
      } catch (e) { return { error: `CalDAV create failed: ${e.message}` }; }
    }

    case "caldav_update_event": {
      try {
        await require("../services/caldav").updateEvent(toolInput);
        return { success: true, updated: Object.keys(toolInput).filter((k) => k !== "event_url" && !k.startsWith("_")) };
      } catch (e) { return { error: `CalDAV update failed: ${e.message}` }; }
    }

    case "caldav_delete_event": {
      try {
        await require("../services/caldav").deleteEvent(toolInput);
        return { success: true, deleted: toolInput.event_name || toolInput.event_url };
      } catch (e) { return { error: `CalDAV delete failed: ${e.message}` }; }
    }

    // --- Dashboard settings ---
    case "get_settings": {
      const userId = toolInput._userId;
      if (!userId) return { error: "Missing user context" };
      const supabase = require("../../user-store").supabase;
      const { data: profile } = await supabase.from("profiles").select("settings, display_name").eq("id", userId).single();
      const s = profile?.settings || {};
      const ps = s.pulse_settings || {};
      const { data: conns } = await supabase.from("connections").select("service, status").eq("user_id", userId);
      const { data: platforms } = await supabase.from("chat_platforms").select("platform, chat_id").eq("user_id", userId);
      return {
        pulse: { level: ps.proactiveLevel || "off", delivery_platforms: ps.deliveryPlatforms || [], quiet_start: ps.quietStart ?? 22, quiet_end: ps.quietEnd ?? 7 },
        connected_services: (conns || []).map(c => c.service),
        chat_platforms: (platforms || []).map(p => p.platform),
        location: s.location || null,
        preferred_name: s.preferred_name || profile?.display_name || null,
        bot_name: s.bot_name || "ClosedHand",
        cloud_computer: true,
        google_accounts: (() => { try { return require("../services/google").listGoogleAccounts(ctx.activeUserStore).map(a => a.email + (a.primary ? " (primary)" : "")); } catch (_) { return []; } })(),
        microsoft_accounts: (() => { try { return require("../services/microsoft").listMicrosoftAccounts(ctx.activeUserStore).map(a => a.email + (a.primary ? " (primary)" : "")); } catch (_) { return []; } })(),
        bridge_connected: ctx.bridgeConnected || false,
        llm_provider: s.llm_provider || "default",
      };
    }
    case "update_settings": {
      const userId = toolInput._userId;
      if (!userId) return { error: "Missing user context" };
      const supabase = require("../../user-store").supabase;
      const { data: profile } = await supabase.from("profiles").select("settings").eq("id", userId).single();
      const s = profile?.settings || {};
      const ps = s.pulse_settings || {};
      let changed = [];

      if (toolInput.pulse_level) {
        ps.proactiveLevel = toolInput.pulse_level;
        changed.push("pulse level: " + toolInput.pulse_level);
      }
      if (toolInput.pulse_platforms) {
        ps.deliveryPlatforms = toolInput.pulse_platforms;
        changed.push("pulse platforms: " + toolInput.pulse_platforms.join(", "));
      }
      if (toolInput.quiet_start != null) { ps.quietStart = toolInput.quiet_start; changed.push("quiet start: " + toolInput.quiet_start); }
      if (toolInput.quiet_end != null) { ps.quietEnd = toolInput.quiet_end; changed.push("quiet end: " + toolInput.quiet_end); }
      if (toolInput.preferred_name) { s.preferred_name = toolInput.preferred_name; changed.push("name: " + toolInput.preferred_name); }
      if (toolInput.bot_name) { s.bot_name = toolInput.bot_name; changed.push("bot name: " + toolInput.bot_name); }
      if (toolInput.llm_provider) { s.llm_provider = toolInput.llm_provider; changed.push("llm provider: " + toolInput.llm_provider); }

      s.pulse_settings = ps;
      await supabase.from("profiles").update({ settings: s, updated_at: new Date().toISOString() }).eq("id", userId);

      // Also sync pulse to pulse_config table and apply the change in-process
      if (toolInput.pulse_level) {
        const levels = { off: { enabled: false, interval: 30 }, low: { enabled: true, interval: 60 }, medium: { enabled: true, interval: 30 }, high: { enabled: true, interval: 15 } };
        const lv = levels[toolInput.pulse_level] || levels.medium;
        await supabase.from("pulse_config").upsert({ user_id: userId, enabled: lv.enabled, interval_minutes: lv.interval }, { onConflict: "user_id" }).catch(() => {});
        try { require("../pulse").applyPulseLevel(userId, toolInput.pulse_level); } catch (_) {}
      }

      // Sync to in-memory profile so changes take effect immediately
      if (ctx.activeUserStore?.profile) {
        ctx.activeUserStore.profile.settings = s;
      }

      return { success: true, changed };
    }
    // --- Pulse Handler ---
    case "pulse_toggle": {
      const userId = toolInput._userId;
      if (!userId) return { error: "Missing user context" };
      const supabase = require("../../user-store").supabase;
      const { data: profile } = await supabase
        .from("profiles").select("settings").eq("id", userId).single();
      const currentSettings = profile?.settings || {};
      const ps = currentSettings.pulse_settings || {};
      const currentLevel = ps.proactiveLevel || "off";

      if (toolInput.enabled === false || toolInput.action === "off") {
        ps.proactiveLevel = "off";
      } else if (toolInput.level) {
        ps.proactiveLevel = toolInput.level;
      } else {
        ps.proactiveLevel = currentLevel === "off" ? "medium" : "off";
      }
      currentSettings.pulse_settings = ps;
      await supabase.from("profiles")
        .update({ settings: currentSettings, updated_at: new Date().toISOString() }).eq("id", userId);

      // Sync to in-memory store so /status and /pulse commands reflect the change
      if (ctx.store && ctx.store.pulse) {
        ctx.store.pulse.enabled = ps.proactiveLevel !== "off";
        ctx.store.pulse.proactiveLevel = ps.proactiveLevel;
      }

      // Apply immediately in-process (the reconciler would catch it within 10min anyway)
      try { require("../pulse").applyPulseLevel(userId, ps.proactiveLevel); } catch (_) {}

      return { success: true, level: ps.proactiveLevel, message: ps.proactiveLevel === "off" ? "Pulse is off." : "Pulse set to " + ps.proactiveLevel + "." };
    }
    case "pulse_check": {
      return { success: true, message: "Check calendar, email, weather, and anything else relevant right now. Report anything worth knowing. If nothing noteworthy, say so briefly." };
    }

    case "semantic_search": {
      const userId = ctx.activeUserId || toolInput._userId;
      if (!userId) return { error: "No user context" };
      const { search } = require("../services/usi");
      const { rerank } = require("../services/reranker");
      const topK = toolInput.max_results || 10;
      // Fetch 40 candidates. Passive recall already surfaced the top ~7 in the system prompt,
      // so we skip results that overlap and return the NEXT best results to add new information.
      const results = await search(userId, toolInput.query, {
        service: toolInput.service || null,
        maxResults: 40,
      });
      if (results.error) return { error: results.error };
      // Deduplicate: skip results whose content was already auto-surfaced by passive recall.
      // Passive recall takes the top ~7 from the same vector search, so skip those by offset.
      // Fetch top 40, rerank all, then take positions 8-17 (skipping the ~7 already surfaced).
      // Unconditional: between 8 and 7+topK results this used to slice without
      // reranking, handing back raw vector order. rerank() decides for itself
      // whether there is anything to reorder.
      const reranked = await rerank(toolInput.query, results.results, 7 + topK);
      results.results = reranked.slice(7); // Skip the top 7 passive recall already showed
      return results;
    }

    // --- Service connection management ---
    case "list_connections": {
      const connected = [];
      const available = [];
      for (const [key, svc] of Object.entries(CONNECTABLE_SERVICES)) {
        if (ctx.activeUserStore && ctx.activeUserStore.isConnected(key)) {
          const meta = ctx.activeUserStore.getConnection(key)?.metadata;
          connected.push({ service: key, name: svc.name, provides: svc.provides, account: meta?.email || meta?.name || meta?.shopDomain || null });
        } else {
          if (!svc.isSignup) available.push({ service: key, name: svc.name, provides: svc.provides });
        }
      }
      return { connected, available };
    }

    case "connect_service": {
      const svcKey = toolInput.service;
      const svc = CONNECTABLE_SERVICES[svcKey];
      if (!svc) return { error: `Unknown service "${svcKey}". Available: ${Object.keys(CONNECTABLE_SERVICES).join(", ")}` };
      if (svc.isSignup) return { error: `${svc.name} is a signup service and is already connected (it's how you log in).` };
      if (ctx.activeUserStore && ctx.activeUserStore.isConnected(svcKey)) return { error: `${svc.name} is already connected.` };
      if (svc.needsStoreDomain && !toolInput.store_domain) return { error: `Shopify requires a store domain. Ask the user for their myshopify.com domain and pass it as store_domain.` };
      const WEBAPP_URL = process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000";
      const token = generateBotConnectToken(toolInput._userId, svcKey, toolInput.store_domain);
      const url = `${WEBAPP_URL}/bot-connect?token=${token}`;
      return { url, service: svc.name, message: `Send this link to the user so they can authorize ${svc.name}. The link expires in 15 minutes.` };
    }

    case "disconnect_service": {
      const svcKey = toolInput.service;
      const svc = CONNECTABLE_SERVICES[svcKey];
      if (!svc) return { error: `Unknown service "${svcKey}".` };
      if (svc.isSignup) return { error: `Cannot disconnect ${svc.name} — it's your signup/login provider.` };
      if (!ctx.activeUserStore || !ctx.activeUserStore.isConnected(svcKey)) return { error: `${svc.name} is not connected.` };
      await ctx.activeUserStore.deleteConnection(svcKey);
      return { success: true, message: `${svc.name} has been disconnected.` };
    }

    case "api_request": {
      const method = (toolInput.method || "GET").toUpperCase();
      const url = toolInput.url;
      const service = toolInput.service || "none";
      const body = toolInput.body || null;
      const extraHeaders = toolInput.headers || {};

      // SSRF protection — block private/internal addresses
      if (isBlockedUrl(url)) {
        return { error: "Blocked: cannot make requests to private/internal addresses." };
      }

      console.log(`[api_request] ${method} ${url} (${service}${toolInput.account ? `:${toolInput.account}` : ""})`);

      try {
        // Explicit store threading: chat calls have ctx set (no extra load);
        // background callers (connector sync) pass _userId with ctx unset.
        let reqStore = ctx.activeUserStore;
        if (!reqStore && toolInput._userId) {
          try { reqStore = await require("../../user-store").UserStore.load(toolInput._userId); } catch (_) {}
        }
        let result;
        switch (service) {
          case "google": {
            let gKey;
            try { gKey = require("../services/google").resolveGoogleAccount(reqStore, toolInput.account); }
            catch (e) { return { error: e.message }; }
            result = await googleApiRequest(method, url, body, reqStore, gKey);
            break;
          }
          case "shopify": {
            // Extract endpoint path from full URL for shopifyApiRequest
            const shopifyPath = new URL(url).pathname.replace(/^\/admin\/api\/[^/]+/, "") || url;
            result = await shopifyApiRequest(method, shopifyPath, body, reqStore);
            break;
          }
          case "meta": {
            // Extract path from full URL for metaApiRequest
            const metaUrl = new URL(url);
            const metaPath = metaUrl.pathname.replace(/^\/v[\d.]+/, "") + metaUrl.search;
            result = await metaApiRequest(method, metaPath, body, reqStore);
            break;
          }
          case "whatsapp":
            result = await makeRawRequest(method, url, body, {
              ...extraHeaders,
              Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            });
            break;
          case "slack":
            result = await slackApiRequest(method, url, body, reqStore);
            break;
          default: {
            // For any other connected service (github, etc.), look up OAuth token
            if (service !== "none" && toolInput._userId) {
              const { supabase: sb } = require("../db");
              const { data: conn } = await sb.from("connections").select("tokens").eq("user_id", toolInput._userId).eq("service", service).single();
              const decrypted = require("../../crypto-tokens").decryptTokens(conn?.tokens);
              if (decrypted?.access_token) {
                console.log(`[api_request] Using OAuth token for ${service}`);
                result = await makeRawRequest(method, url, body, {
                  ...extraHeaders,
                  Authorization: `Bearer ${decrypted.access_token}`,
                });
                break;
              }
            }
            result = await makeRawRequest(method, url, body, extraHeaders);
          }
        }

        // Truncate large responses
        const resultStr = JSON.stringify(result);
        if (resultStr.length > 8000) {
          return { result_preview: resultStr.substring(0, 8000), _truncated: true, _originalLength: resultStr.length };
        }
        return result;
      } catch (e) {
        const msg = e.message || "";
        // Detect auth failures and suggest reconnection
        if (msg.includes("401") || msg.includes("Bad credentials") || msg.includes("invalid_grant")) {
          const reconnectUrl = `${process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000"}/auth/${service}`;
          return { error: `${service} connection expired or was revoked. The user needs to reconnect at ${reconnectUrl}. In the meantime, try using Bridge shell access as an alternative if the data is available locally.` };
        }
        return { error: msg };
      }
    }

    case "list_flights": {
      const { getFlightStatus, buildFlightBriefing } = require("../flights");
      const now = Date.now();
      const flights = [];

      for (const [key, value] of Object.entries(ctx.store.facts)) {
        if (!key.startsWith("flight-")) continue;
        try {
          const rawVal = typeof value === "object" && value !== null && value.value !== undefined ? value.value : value;
          const flight = JSON.parse(rawVal);
          const depTime = new Date(flight.departure?.dateTime).getTime();
          // Include future flights and flights from last 24h
          if (depTime < now - 24 * 3600000) continue;

          let liveStatus = null;
          // Fetch live status for flights within 48h
          if (depTime < now + 48 * 3600000 && !flight.landed) {
            liveStatus = await getFlightStatus(flight.flightNumber, flight.departure.dateTime);
            if (!liveStatus.error) {
              flight.liveStatus = liveStatus;
              // Preserve metadata wrapper when updating
              const now2 = new Date().toISOString();
              if (typeof value === "object" && value.value !== undefined) {
                value.value = JSON.stringify(flight);
                value.lastAccessed = now2;
              } else {
                ctx.store.facts[key] = { value: JSON.stringify(flight), created: now2, lastAccessed: now2, accessCount: 0 };
              }
            }
          }

          flights.push({
            key,
            flightNumber: flight.flightNumber,
            departure: flight.departure,
            arrival: flight.arrival,
            confirmationCode: flight.confirmationCode,
            landed: flight.landed,
            briefing: buildFlightBriefing(flight),
            liveStatus: liveStatus?.error ? null : liveStatus,
          });
        } catch { /* skip malformed */ }
      }

      if (flights.length === 0) return { message: "No tracked flights found.", flights: [] };
      return { flights, count: flights.length };
    }

    case "flight_scan": {
      const { scanEmailsForFlights } = require("../flights");
      const { sendTyping } = require("../messaging");
      const userId = ctx.activeUserId;
      const chatId = toolInput._chatId;
      if (!userId) return { error: "No active user context" };

      // Send typing indicator - this scan can take a while
      if (chatId) sendTyping(chatId).catch(() => {});

      const newFlights = await scanEmailsForFlights(userId);
      if (newFlights.length === 0) {
        return { message: "Scanned emails thoroughly - no flight bookings found." };
      }
      return {
        message: `Found ${newFlights.length} new flight(s). Flight tracking is now active - the system will automatically monitor for gate changes, delays, cancellations, and departure/landing updates. The user can also view their tracked flights in their dashboard.`,
        flights: newFlights.map(f => ({
          flightNumber: f.flightNumber,
          airline: f.airline,
          departure: f.departure,
          arrival: f.arrival,
          confirmationCode: f.confirmationCode,
        })),
      };
    }

    // --- Sandbox (Cloud Workspace) ---

    case "sandbox_exec": {
      const { ensureSandbox, sandboxExec } = require("../sandbox");
      try {
        await ensureSandbox(ctx.activeUserId);
        const result = await sandboxExec(ctx.activeUserId, toolInput.language, toolInput.code, 30000);
        const { refreshAfterMutation } = require("../workspace-cache");
        refreshAfterMutation(ctx.activeUserId, ctx.activeUserStore);
        return result;
      } catch (e) {
        console.error(`Sandbox exec error:`, e.message, e.stack?.split("\n")[1]);
        return { error: `Sandbox exec failed: ${e.message}` };
      }
    }

    case "sandbox_file_read": {
      const { ensureSandbox, sandboxFileRead } = require("../sandbox");
      try {
        await ensureSandbox(ctx.activeUserId);
        return await sandboxFileRead(ctx.activeUserId, toolInput.path);
      } catch (e) {
        return { error: `Sandbox file read failed: ${e.message}` };
      }
    }

    case "sandbox_file_write": {
      const { ensureSandbox, sandboxFileWrite } = require("../sandbox");
      try {
        await ensureSandbox(ctx.activeUserId);
        const result = await sandboxFileWrite(ctx.activeUserId, toolInput.path, toolInput.content);
        const { refreshAfterMutation } = require("../workspace-cache");
        refreshAfterMutation(ctx.activeUserId, ctx.activeUserStore);
        return result;
      } catch (e) {
        return { error: `Sandbox file write failed: ${e.message}` };
      }
    }

    case "sandbox_file_list": {
      const { ensureSandbox, sandboxFileList } = require("../sandbox");
      try {
        await ensureSandbox(ctx.activeUserId);
        return await sandboxFileList(ctx.activeUserId, toolInput.path);
      } catch (e) {
        return { error: `Sandbox file list failed: ${e.message}` };
      }
    }

    case "sandbox_file_download": {
      const { ensureSandbox, sandboxFileDownload } = require("../sandbox");
      const supabase = require("../../user-store").supabase;
      try {
        await ensureSandbox(ctx.activeUserId);
        const file = await sandboxFileDownload(ctx.activeUserId, toolInput.path);
        if (file.error) {
          console.error(`[Sandbox] File download failed for ${toolInput.path}:`, file.error);
          return file;
        }

        // Check if this is canvas-worthy content
        const canvasTypes = ["text/html", "image/png", "image/jpeg", "image/svg+xml", "image/gif"];
        const isCanvas = canvasTypes.includes(file.mime_type);
        let canvasUrl = null;

        if (isCanvas) {
          // Store in canvases table for sharing
          const { data: canvasRow } = await supabase.from("canvases").insert({
            user_id: ctx.activeUserId,
            filename: file.filename,
            mime_type: file.mime_type,
            content: file.content,
          }).select("id").single();

          if (canvasRow) {
            const baseUrl = process.env.BASE_URL || "http://localhost:3000";
            canvasUrl = `${baseUrl}/canvas/${canvasRow.id}`;

            // Send canvas to web chat if connected
            const { hasWebChatConnection, sendToUser } = require("../web-chat-ws");
            if (hasWebChatConnection(ctx.activeUserId)) {
              sendToUser(ctx.activeUserId, {
                type: "canvas",
                id: canvasRow.id,
                filename: file.filename,
                mime_type: file.mime_type,
                content: file.content,
              });
            }

            // Persist canvas reference in web_messages so it appears in history
            if (ctx.activePlatform === "web") {
              supabase.from("web_messages").insert({
                user_id: ctx.activeUserId,
                direction: "outbound",
                content: `[canvas:${canvasRow.id}:${file.filename}]`,
                status: "complete",
              }).then(() => {}).catch(() => {});
            }
          }
        }

        // Send to chat platform
        if (ctx.activePlatform !== "web") {
          const buffer = Buffer.from(file.content, "base64");
          if (isCanvas && canvasUrl) {
            // Use mini app / inline button where supported (Telegram, LINE)
            const { sendCanvasToChat } = require("../messaging");
            await sendCanvasToChat(ctx.activePlatform, ctx.activeChatId, canvasUrl, file.filename, buffer, file.mime_type);
          } else {
            await sendDocument(ctx.activeChatId, buffer, file.filename, file.mime_type, "workspace");
          }
        }

        const result = { success: true, message: `Sent ${file.filename} (${(file.size / 1024).toFixed(1)}KB) to the user` };
        if (isCanvas) result.message += ". The content is now displayed in their canvas panel.";
        return result;
      } catch (e) {
        console.error(`[Sandbox] File download exception:`, e.message);
        return { error: `Sandbox file download failed: ${e.message}` };
      }
    }

    case "sandbox_upload": {
      const { ensureSandbox, sandboxFileWrite } = require("../sandbox");
      try {
        // Find the attachment
        const userId = ctx.activeUserId;
        const attachments = ctx.store.attachments?.[userId] || [];
        const att = attachments.find(a => a.id === toolInput.attachment_id);
        if (!att) return { error: `Attachment not found: ${toolInput.attachment_id}` };

        // Read the file
        const buffer = fs.readFileSync(att.filePath);
        const base64 = buffer.toString("base64");
        const dest = toolInput.destination || att.fileName || path.basename(att.filePath);

        await ensureSandbox(userId);
        const result = await sandboxFileWrite(userId, dest, base64, "base64");
        const { refreshAfterMutation } = require("../workspace-cache");
        refreshAfterMutation(userId, ctx.activeUserStore);
        return { success: true, message: `Uploaded ${att.fileName} to workspace as ${dest}`, size: result.size };
      } catch (e) {
        return { error: `Sandbox upload failed: ${e.message}` };
      }
    }

    case "sandbox_packages": {
      const { ensureSandbox, sandboxPackageInstall } = require("../sandbox");
      try {
        await ensureSandbox(ctx.activeUserId);
        return await sandboxPackageInstall(ctx.activeUserId, toolInput.manager, toolInput.packages);
      } catch (e) {
        return { error: `Sandbox package install failed: ${e.message}` };
      }
    }

    case "sandbox_status": {
      const { getSandboxStatus } = require("../sandbox");
      try {
        return await getSandboxStatus(ctx.activeUserId);
      } catch (e) {
        return { error: `Sandbox status check failed: ${e.message}` };
      }
    }

    case "sandbox_gateway": {
      const { ensureSandbox, sandboxExec } = require("../sandbox");
      const userId = ctx.activeUserId;
      const { service, method, url: apiUrl, body: apiBody } = toolInput;

      // SSRF protection
      try {
        const parsed = new URL(apiUrl);
        const hostname = parsed.hostname.toLowerCase();
        if (
          hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" ||
          hostname === "[::1]" || hostname.endsWith(".local") || hostname.startsWith("10.") ||
          hostname.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
          hostname === "169.254.169.254" || hostname.endsWith(".internal")
        ) {
          return { error: "Blocked: cannot make requests to private/internal addresses." };
        }
      } catch {
        return { error: `Invalid URL: ${apiUrl}` };
      }

      console.log(`[sandbox_gateway] ${method} ${apiUrl} (${service})`);

      try {
        let result;
        switch (service) {
          case "google": {
            let gApi;
            try { gApi = googleReqFor(toolInput.account); } catch (e) { return { error: e.message }; }
            result = await gApi(method, apiUrl, apiBody || null);
            break;
          }
          case "microsoft":
            result = await microsoftApiRequest(method, apiUrl, apiBody || null);
            break;
          case "shopify": {
            const shopifyPath = new URL(apiUrl).pathname.replace(/^\/admin\/api\/[^/]+/, "") || apiUrl;
            result = await shopifyApiRequest(method, shopifyPath, apiBody || null);
            break;
          }
          case "meta": {
            const metaUrl = new URL(apiUrl);
            const metaPath = metaUrl.pathname.replace(/^\/v[\d.]+/, "") + metaUrl.search;
            result = await metaApiRequest(method, metaPath, apiBody || null);
            break;
          }
          case "whatsapp":
            result = await makeRawRequest(method, apiUrl, apiBody || null, {
              Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            });
            break;
          case "slack":
            result = await slackApiRequest(method, apiUrl, apiBody || null);
            break;
          default:
            result = await makeRawRequest(method, apiUrl, apiBody || null, {});
        }
        const resultStr = JSON.stringify(result);
        if (resultStr.length > 8000) {
          return { result_preview: resultStr.substring(0, 8000), _truncated: true, _originalLength: resultStr.length };
        }
        return result;
      } catch (e) {
        return { error: e.message };
      }
    }

    case "sandbox_browse": {
      const { ensureSandbox, sandboxExec, sandboxFileDownload } = require("../sandbox");
      const userId = ctx.activeUserId;
      const { url: browseUrl, action, selector, selectors, full_page } = toolInput;
      // url is optional now: a follow-up call acts on the tab the previous one
      // left behind, which is what makes a multi-step task possible at all.
      const pyUrl = browseUrl ? JSON.stringify(browseUrl) : "None";
      const pyStr = (v) => (v === undefined || v === null ? "None" : JSON.stringify(String(v)));
      // The bot and the sandbox image deploy separately, so a container started
      // before the interaction functions existed will still be running. Say that
      // plainly instead of surfacing a raw ImportError.
      const pyImport = (fn) => `
import json
try:
    from browser_helper import ${fn}
except ImportError:
    print(json.dumps({"error": "This cloud computer is running an older browser image without ${fn}. Restart the cloud computer from the Computers tab to pick up the current one, then try again."}))
    raise SystemExit
`;

      try {
        await ensureSandbox(userId);

        let code;
        switch (action) {
          case "screenshot":
            code = `
from browser_helper import screenshot
import json
res = screenshot(${pyUrl}, full_page=${full_page ? "True" : "False"})
# Newer sandbox images return {image,title,url}; older ones return the base64
# string. The bot and the sandbox image deploy separately, so accept both.
if isinstance(res, dict):
    img_b64 = res.get("image") or ""
    page_title = res.get("title") or ""
    final_url = res.get("url") or ""
else:
    img_b64 = res
    page_title = ""
    final_url = ""
# Write to file so we can download it
import base64
with open("/workspace/_screenshot.png", "wb") as f:
    f.write(base64.b64decode(img_b64))
print(json.dumps({"success": True, "file": "_screenshot.png", "size": len(img_b64), "title": page_title, "url": final_url}))
`;
            break;
          case "scrape_text":
            code = `
from browser_helper import scrape_text
import json
text = scrape_text(${pyUrl}, selector=${pyStr(selector)})
print(json.dumps({"text": text[:8000]}))
`;
            break;
          case "extract_data":
            code = `
from browser_helper import extract_data
import json
data = extract_data(${pyUrl}, ${JSON.stringify(selectors || {})})
print(json.dumps({"data": data}))
`;
            break;
          case "click":
            if (!selector) return { error: "click needs a selector. Screenshot or scrape_text the page first and pick one from what is actually there." };
            code = pyImport("click") + `
print(json.dumps(click(${pyStr(selector)}, url=${pyUrl}, index=${Number.isFinite(toolInput.index) ? Math.max(0, Math.trunc(toolInput.index)) : 0})))
`;
            break;
          case "fill":
            if (!selector) return { error: "fill needs a selector for the field to type into." };
            if (toolInput.text === undefined || toolInput.text === null) return { error: "fill needs text to type." };
            code = pyImport("fill") + `
print(json.dumps(fill(${pyStr(selector)}, ${pyStr(toolInput.text)}, url=${pyUrl}, submit=${toolInput.submit ? "True" : "False"})))
`;
            break;
          case "press":
            if (!toolInput.key) return { error: "press needs a key, e.g. Enter." };
            code = pyImport("press") + `
print(json.dumps(press(${pyStr(toolInput.key)}, selector=${pyStr(selector)}, url=${pyUrl})))
`;
            break;
          case "wait_for":
            if (!selector) return { error: "wait_for needs a selector to wait for." };
            code = pyImport("wait_for") + `
print(json.dumps(wait_for(${pyStr(selector)}, url=${pyUrl})))
`;
            break;
          case "batch": {
            const steps = Array.isArray(toolInput.steps) ? toolInput.steps : null;
            if (!steps || steps.length === 0) return { error: "batch needs a steps array." };
            if (steps.length > 20) return { error: "batch takes at most 20 steps. Split the work." };
            code = pyImport("batch") + `
print(json.dumps(batch(${JSON.stringify(steps)}, url=${pyUrl})))
`;
            break;
          }
          case "eval_js":
            if (!toolInput.script) return { error: "eval_js needs a script." };
            code = pyImport("eval_js") + `
print(json.dumps(eval_js(${pyStr(toolInput.script)}, url=${pyUrl})))
`;
            break;
          default:
            return { error: `Unknown action: ${action}. Use screenshot, scrape_text, extract_data, click, fill, press, wait_for, eval_js, or batch.` };
        }

        const result = await sandboxExec(userId, "python", code, 60000);

        // Screenshots go to the MODEL so it can see the page, not to the user.
        // Previously this sent the image straight to chat and handed the model
        // only "screenshot taken and sent": the model stayed blind, so it kept
        // retrying, and meanwhile the user's logged-in pages were pushed into
        // their chat (and through that platform's servers) unasked. Delivery to
        // the user now requires send_to_user, for when they actually asked to
        // see it.
        if (action === "screenshot" && result.stdout && !result.error) {
          try {
            const parsed = JSON.parse(result.stdout);
            if (parsed.success) {
              const file = await sandboxFileDownload(userId, "_screenshot.png");
              if (file && !file.error) {
                const buffer = Buffer.from(file.content, "base64");
                if (toolInput.send_to_user) {
                  await sendDocument(ctx.activeChatId, buffer, `screenshot_${Date.now()}.png`, "image/png", "workspace");
                }
                return {
                  _contentType: "image",
                  mediaType: "image/png",
                  base64: file.content,
                  // This description is not just a label: when context fills up,
                  // compressToolResponses replaces the image with
                  // "[Compressed] Previously viewed: <this text>", so it is all
                  // that remains of the screenshot later in the conversation.
                  description: `Screenshot of ${parsed.title ? `"${parsed.title}" ` : ""}${parsed.url || browseUrl || "the current page"}${full_page ? " (full page)" : " (visible area)"}, captured ${new Date().toISOString().substring(0, 16).replace("T", " ")}Z${toolInput.send_to_user ? ", also sent to the user" : ""}. Record anything important from it in your reply, since the image itself is dropped from context once it ages out.`,
                };
              }
            }
          } catch { /* fall through to return raw result */ }
        }

        // Parse stdout as JSON if possible
        if (result.stdout) {
          try {
            return JSON.parse(result.stdout);
          } catch { /* return raw */ }
        }
        return result;
      } catch (e) {
        console.error(`Sandbox browse error:`, e.message);
        return { error: `Browser action failed: ${e.message}` };
      }
    }

    // --- Background Agents ---
    case "agent_start": {
      const { startAgent } = require("../agents");
      const { getActiveTasks } = require("../agents-store");
      const userId = toolInput._userId;
      const chatId = toolInput._chatId;
      if (!userId || !chatId) return { error: "Missing user/chat context" };

      // Check concurrency limits
      const active = await getActiveTasks(userId);
      const running = active.filter((t) => t.status === "running");
      if (running.length >= 8) {
        return { error: `You have ${running.length} agents running. Max is 8 — wait for one to finish or cancel one.` };
      }
      let warning = null;
      if (running.length >= 5) {
        warning = `You have ${running.length} agents running already. This one will start, but consider waiting.`;
      }

      // Threaded in alongside _userId/_chatId by whichever runner called this.
      // Reading ctx.activePlatform here was the last unconverted reader after
      // 8c36f0a: the caller's context bubble can already have been cleared by
      // the time the tool runs, and the agent then recorded "web" and delivered
      // its finished work to a session that was never there.
      const platform = toolInput._platform || ctx.activePlatform;
      const result = await startAgent(userId, platform, chatId, toolInput.goal, toolInput.success_criteria);
      return {
        success: true,
        task_id: result.taskId,
        model: result.model,
        message: `Agent started (using ${result.model}). It'll work in the background and send you the result when done.`,
        ...(warning ? { warning } : {}),
      };
    }
    case "agent_status": {
      const { getActiveTasks } = require("../agents-store");
      const userId = toolInput._userId;
      if (!userId) return { error: "Missing user context" };

      const tasks = await getActiveTasks(userId);
      if (tasks.length === 0) return { agents: [], message: "No agents running or recent." };

      return {
        agents: tasks.map((t) => ({
          id: t.id,
          goal: t.goal,
          status: t.status,
          model: t.model,
          tools_used: t.tools_used?.length || 0,
          started: t.created_at,
          finished: t.completed_at || null,
          error: t.error || null,
        })),
      };
    }
    case "agent_cancel": {
      const { cancelAgent } = require("../agents");
      const result = await cancelAgent(toolInput.task_id);
      return { success: true, message: `Agent ${toolInput.task_id} cancelled.` };
    }

    case "agent_note": {
      const { getActiveTasks } = require("../agents-store");
      const noteUserId = toolInput._userId || ctx.activeUserId;
      if (!noteUserId) return { error: "No user context." };
      if (!toolInput.note || !String(toolInput.note).trim()) return { error: "The note is empty." };

      const active = await getActiveTasks(noteUserId);
      let running = active.filter((t) => t.status === "running" || t.status === "pending");
      if (toolInput.task_id) running = running.filter((t) => t.id === toolInput.task_id);
      if (!running.length) {
        return { error: toolInput.task_id ? "That agent is not running any more; it finished or was stopped. Handle the request yourself or start a new agent." : "No agent is running right now. Handle the request yourself or start a new agent." };
      }
      if (running.length > 1) {
        return { error: `More than one agent is running. Pass task_id. Running: ${running.map((t) => `${t.id.substring(0, 8)} (${(t.title || t.goal || "").substring(0, 50)})`).join("; ")}` };
      }

      const target = running[0];
      const { supabase } = require("../../user-store");
      // Read-modify-write is fine at this scale: one user, one chat turn.
      const { data: fresh } = await supabase.from("agent_tasks")
        .select("pending_notes, status").eq("id", target.id).eq("user_id", noteUserId).single();
      if (!fresh || !["running", "pending"].includes(fresh.status)) {
        return { error: "That agent just finished. Its report is on the dashboard; handle the new request yourself." };
      }
      const notes = Array.isArray(fresh.pending_notes) ? fresh.pending_notes : [];
      notes.push({ note: String(toolInput.note), at: new Date().toISOString() });
      const { error: noteErr } = await supabase.from("agent_tasks")
        .update({ pending_notes: notes }).eq("id", target.id).eq("user_id", noteUserId);
      if (noteErr) return { error: noteErr.message };
      return {
        success: true,
        task_id: target.id,
        message: `Passed to "${(target.title || target.goal || "the running agent").substring(0, 60)}". It folds the note in at its next step; tell the user it has been picked up mid-run.`,
      };
    }

    case "agent_report_read":
    case "agent_report_update": {
      const { supabase } = require("../../user-store");
      const reportUserId = toolInput._userId || ctx.activeUserId;
      if (!reportUserId) return { error: "No user context." };

      let q = supabase.from("agent_tasks")
        .select("id, title, goal, result, completed_at, result_edited_at")
        .eq("user_id", reportUserId)
        .eq("status", "completed")
        .not("result", "is", null);
      if (toolInput.task_id) q = q.eq("id", toolInput.task_id);
      const { data: runs, error: runErr } = await q.order("completed_at", { ascending: false }).limit(1);
      if (runErr) return { error: runErr.message };
      const run = runs?.[0];
      if (!run) return { error: toolInput.task_id ? "No completed run with that ID." : "No completed run with output to work on." };

      if (toolName === "agent_report_read") {
        return { task_id: run.id, title: run.title || (run.goal || "").substring(0, 120), edited: run.result_edited_at || null, result: run.result };
      }

      if (!toolInput.new_content || !String(toolInput.new_content).trim()) {
        return { error: "new_content is empty. Pass the complete revised document." };
      }
      const { error: updErr } = await supabase.from("agent_tasks")
        .update({ result: toolInput.new_content, result_edited_at: new Date().toISOString() })
        .eq("id", run.id).eq("user_id", reportUserId);
      if (updErr) return { error: updErr.message };
      return {
        success: true,
        task_id: run.id,
        message: "Document revised in place. The dashboard card and its PDF download now show the new version, marked edited.",
      };
    }

    // --- Automations ---
    case "automation_run": {
      const autoStore = require("../automations-store");
      const userId = toolInput._userId;
      if (toolInput.name) {
        // Run a saved automation
        const auto = await autoStore.getAutomationByName(userId, toolInput.name);
        if (!auto) return { error: "No automation found called '" + toolInput.name + "'. Use automation_list to see available automations." };
        // Create a pending run (the bot polling will pick it up)
        const run = await autoStore.createRun(auto.id, userId, {
          status: "pending", triggered_by: "chat",
          platform: ctx.activePlatform || "web",
          chat_id: toolInput._chatId || "unknown",
        });
        return { success: true, message: "Running '" + auto.name + "'. I'll send you the results when it's done.", run_id: run.id };
      } else if (toolInput.prompt) {
        // Quick one-off run
        const run = await autoStore.createRun(null, userId, {
          status: "pending", triggered_by: "chat",
          input_context: toolInput.prompt,
          platform: ctx.activePlatform || "web",
          chat_id: toolInput._chatId || "unknown",
        });
        return { success: true, message: "Task started. I'll send you the results when it's done.", run_id: run.id };
      }
      return { error: "Please provide either a name of a saved automation or a prompt for a one-off task." };
    }

    case "automation_create": {
      const autoStore = require("../automations-store");
      const userId = toolInput._userId;
      const modelMap = { haiku: "haiku", sonnet: "sonnet", opus: "opus" };
      const config = {
        name: (toolInput.name || "").trim().toLowerCase().replace(/\s+/g, "-"),
        description: toolInput.description || "",
        trigger_type: toolInput.trigger_type || "manual",
        trigger_cron: toolInput.cron_expression || null,
        trigger_timezone: require("../timezone").getUserTimezone(ctx.store),
        trigger_human_schedule: toolInput.human_schedule || null,
        trigger_event_source: toolInput.event_source || null,
        trigger_event_condition: toolInput.event_condition || null,
        task_prompt: toolInput.prompt,
        task_model: modelMap[toolInput.model] || "sonnet",
        task_tools: [],
        task_use_cloud: toolInput.use_cloud || false,
        output_destinations: ["chat_platforms", "dashboard"],
        output_urgent: toolInput.urgent || false,
        platform: ctx.activePlatform || "dashboard",
        chat_id: toolInput._chatId || null,
        status: toolInput.trigger_type === "manual" ? "idle" : "active",
      };
      try {
        const auto = await autoStore.createAutomation(userId, config);
        let msg = "Automation '" + auto.name + "' created and saved.";
        if (auto.trigger_type === "scheduled") {
          msg += " It will run " + (auto.trigger_human_schedule || auto.trigger_cron) + ".";
          try {
            const next = require("cron-parser").parseExpression(auto.trigger_cron, { tz: config.trigger_timezone }).next().toDate();
            msg += " First run " + next.toLocaleString("en-GB", { timeZone: config.trigger_timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " (" + config.trigger_timezone + "). Tell the user this time.";
          } catch (_) {}
        }
        if (auto.trigger_type === "manual") msg += " Run it anytime with /" + auto.name + ".";
        return { success: true, message: msg, automation_id: auto.id };
      } catch (e) {
        if (e.message?.includes("duplicate")) return { error: "An automation called '" + config.name + "' already exists." };
        return { error: "Failed to create automation: " + e.message };
      }
    }

    case "automation_list": {
      const autoStore = require("../automations-store");
      const userId = toolInput._userId;
      const autos = await autoStore.listAutomations(userId);
      if (!autos.length) return { automations: [], message: "No saved automations yet." };
      return {
        automations: autos.map(a => ({
          name: a.name, description: a.description, status: a.status,
          trigger: a.trigger_human_schedule || a.trigger_type,
          last_updated: a.updated_at,
        }))
      };
    }

    case "automation_pause": {
      const autoStore = require("../automations-store");
      const userId = toolInput._userId;
      const auto = await autoStore.getAutomationByName(userId, toolInput.name);
      if (!auto) return { error: "No automation found called '" + toolInput.name + "'." };
      await autoStore.updateAutomation(auto.id, userId, { status: "paused" });
      return { success: true, message: "'" + auto.name + "' paused. It won't run until you resume it." };
    }

    case "automation_resume": {
      const autoStore = require("../automations-store");
      const userId = toolInput._userId;
      const auto = await autoStore.getAutomationByName(userId, toolInput.name);
      if (!auto) return { error: "No automation found called '" + toolInput.name + "'." };
      await autoStore.updateAutomation(auto.id, userId, { status: "active" });
      return { success: true, message: "'" + auto.name + "' resumed." };
    }

    // --- Deferred MCP tool loading ---
    case "get_tool_details": {
      const { getUserMcpToolDefs } = require("../user-mcp");
      const { INTERNAL_TOOLS } = require("./definitions");
      const userId = toolInput._userId;

      // Check internal tools first (covers on-demand internal tools)
      const internalTool = INTERNAL_TOOLS.find(t => t.name === toolInput.tool_name);
      if (internalTool) {
        return {
          name: internalTool.name,
          description: internalTool.description,
          parameters: internalTool.input_schema,
          _isInternal: true,
          note: "You can now call this tool with the parameters above.",
        };
      }

      // Then check MCP tools
      const allDefs = getUserMcpToolDefs(userId);
      const tool = allDefs.find(t => t.name === toolInput.tool_name);
      if (!tool) {
        // "Check the name and try again" invited another guess, and a guessed
        // name costs a whole round trip. Answer with names that exist, closest
        // first, so the next call is a choice.
        const asked = String(toolInput.tool_name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const names = [...INTERNAL_TOOLS.map(t => t.name), ...allDefs.map(t => t.name)];
        const score = (name) => {
          const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (!asked || !flat) return 0;
          if (flat === asked) return 3;
          if (flat.includes(asked) || asked.includes(flat)) return 2;
          // Otherwise any shared run of 4+ characters, e.g. "meta" or "search"
          for (let len = Math.min(asked.length, flat.length); len >= 4; len--) {
            for (let i = 0; i + len <= asked.length; i++) {
              if (flat.includes(asked.slice(i, i + len))) return 1;
            }
          }
          return 0;
        };
        const near = names
          .map(n => ({ n, s: score(n) }))
          .filter(x => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 8)
          .map(x => x.n);
        return {
          error: "There is no tool called '" + toolInput.tool_name + "'.",
          hint: near.length
            ? "Do not guess another name. Use one of these, or work with the tools you already have."
            : "Do not guess another name. Work with the tools you already have.",
          closest_matches: near,
          available_count: names.length,
        };
      }
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        note: "You can now call this tool with the parameters above.",
      };
    }

    // --- Bridge (Mac app) tools (create + file/shell/browser/input) ---
    case "bridge_calendar_create":
    case "bridge_files_list":
    case "bridge_files_read":
    case "bridge_files_write":
    case "bridge_files_move":
    case "bridge_files_delete":
    case "bridge_files_search":
    case "bridge_shell_run":
    case "bridge_browser_active_tab":
    case "bridge_browser_open_url":
    case "bridge_browser_page_content":
    case "bridge_browser_execute_js":
    case "bridge_browser_click":
    case "bridge_browser_type":
    case "bridge_browser_switch_tab":
    case "bridge_browser_close_tab":
    case "bridge_browser_navigate":
    case "bridge_browser_list_tabs":
    case "bridge_system_info":
    case "bridge_screenshot":
    case "bridge_launch_app":
    case "bridge_clipboard_read":
    case "bridge_clipboard_write":
    case "bridge_files_edit":
    case "bridge_files_grep":
    case "bridge_files_glob":
    case "bridge_ax_list_windows":
    case "bridge_ax_focus_window":
    case "bridge_ax_read_ui":
    case "bridge_ax_click":
    case "bridge_ax_set_value":
    case "bridge_session_start":
    case "bridge_session_send":
    case "bridge_session_read":
    case "bridge_session_end":
    case "bridge_session_list":
    case "bridge_session_type_to":
    case "bridge_input_mouse_move":
    case "bridge_input_mouse_click":
    case "bridge_input_mouse_drag":
    case "bridge_input_key_type":
    case "bridge_input_key_press":
    case "bridge_input_key_combo":
    case "bridge_input_scroll":
    case "bridge_keep_awake": {
      // Relay through webapp's WebSocket via HTTP API
      const bridgeActions = {
        bridge_calendar_create: { action: "calendar.create", params: { title: toolInput.title, start: toolInput.start, end: toolInput.end, location: toolInput.location, notes: toolInput.notes } },
        bridge_files_list: { action: "files.list", params: { path: toolInput.path } },
        bridge_files_read: { action: "files.read", params: { path: toolInput.path, offset: toolInput.offset, limit: toolInput.limit } },
        bridge_files_write: { action: "files.write", params: { path: toolInput.path, content: toolInput.content } },
        bridge_files_move: { action: "files.move", params: { from: toolInput.from, to: toolInput.to } },
        bridge_files_delete: { action: "files.delete", params: { path: toolInput.path } },
        bridge_files_search: { action: "files.search", params: { query: toolInput.query, path: toolInput.path } },
        bridge_files_edit: { action: "files.edit", params: { path: toolInput.path, old_string: toolInput.old_string, new_string: toolInput.new_string, replace_all: toolInput.replace_all } },
        bridge_files_grep: { action: "files.grep", params: { pattern: toolInput.pattern, path: toolInput.path, glob: toolInput.glob, context: toolInput.context } },
        bridge_files_glob: { action: "files.glob", params: { pattern: toolInput.pattern, path: toolInput.path } },
        bridge_shell_run: { action: "shell.run", params: { command: toolInput.command, timeout: toolInput.timeout } },
        bridge_browser_active_tab: { action: "browser.active_tab", params: { browser: toolInput.browser } },
        bridge_browser_open_url: { action: "browser.open_url", params: { url: toolInput.url, browser: toolInput.browser } },
        bridge_browser_page_content: { action: "browser.page_content", params: { browser: toolInput.browser } },
        bridge_browser_list_tabs: { action: "browser.list_tabs", params: { browser: toolInput.browser } },
        bridge_browser_execute_js: { action: "browser.execute_js", params: { javascript: toolInput.javascript, browser: toolInput.browser } },
        bridge_browser_click: { action: "browser.click", params: { selector: toolInput.selector, browser: toolInput.browser } },
        bridge_browser_type: { action: "browser.type", params: { text: toolInput.text, selector: toolInput.selector, browser: toolInput.browser } },
        bridge_browser_switch_tab: { action: "browser.switch_tab", params: { index: toolInput.index, browser: toolInput.browser } },
        bridge_browser_close_tab: { action: "browser.close_tab", params: { browser: toolInput.browser } },
        bridge_browser_navigate: { action: "browser.navigate", params: { url: toolInput.url, browser: toolInput.browser } },
        bridge_system_info: { action: "system.info", params: {} },
        bridge_screenshot: { action: "system.screenshot", params: {} },
        bridge_launch_app: { action: "system.launch_app", params: { app: toolInput.app } },
        bridge_clipboard_read: { action: "system.clipboard_read", params: {} },
        bridge_clipboard_write: { action: "system.clipboard_write", params: { text: toolInput.text } },
        bridge_keep_awake: { action: "system.keep_awake", params: { enable: toolInput.enable } },
        bridge_ax_list_windows: { action: "ax.list_windows", params: { app: toolInput.app } },
        bridge_ax_focus_window: { action: "ax.focus_window", params: { app: toolInput.app, index: toolInput.index } },
        bridge_ax_read_ui: { action: "ax.read_ui", params: { app: toolInput.app, depth: toolInput.depth } },
        bridge_ax_click: { action: "ax.click", params: { app: toolInput.app, title: toolInput.title, role: toolInput.role, description: toolInput.description } },
        bridge_ax_set_value: { action: "ax.set_value", params: { app: toolInput.app, value: toolInput.value, title: toolInput.title, role: toolInput.role } },
        bridge_session_type_to: { action: "shell.session_type_to", params: { app: toolInput.app, text: toolInput.text, press_enter: toolInput.press_enter } },
        bridge_session_start: { action: "shell.session_start", params: { name: toolInput.name, command: toolInput.command, args: toolInput.args } },
        bridge_session_send: { action: "shell.session_send", params: { name: toolInput.name, input: toolInput.input, wait_ms: toolInput.wait_ms } },
        bridge_session_read: { action: "shell.session_read", params: { name: toolInput.name, wait_ms: toolInput.wait_ms } },
        bridge_session_end: { action: "shell.session_end", params: { name: toolInput.name } },
        bridge_session_list: { action: "shell.session_list", params: {} },
        bridge_input_mouse_move: { action: "input.mouse_move", params: { x: toolInput.x, y: toolInput.y } },
        bridge_input_mouse_click: { action: "input.mouse_click", params: { x: toolInput.x, y: toolInput.y, button: toolInput.button, clicks: toolInput.clicks } },
        bridge_input_mouse_drag: { action: "input.mouse_drag", params: { from_x: toolInput.from_x, from_y: toolInput.from_y, to_x: toolInput.to_x, to_y: toolInput.to_y } },
        bridge_input_key_type: { action: "input.key_type", params: { text: toolInput.text } },
        bridge_input_key_press: { action: "input.key_press", params: { key: toolInput.key, modifiers: toolInput.modifiers } },
        bridge_input_key_combo: { action: "input.key_combo", params: { combo: toolInput.combo } },
        bridge_input_scroll: { action: "input.scroll", params: { dy: toolInput.dy, dx: toolInput.dx } },
      };
      const ba = bridgeActions[toolName];
      try {
        const baseUrl = process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000";
        const resp = await fetch(baseUrl + "/api/bridge/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: toolInput._userId,
            action: ba.action,
            params: ba.params,
            secret: process.env.BRIDGE_RELAY_SECRET || process.env.COOKIE_SECRET || "",
          }),
        });
        const data = await resp.json();
        if (!resp.ok) return { error: data.error || "Bridge not connected. Make sure the Bridge app is running on your Mac." };
        // Screenshots return base64 image data — convert to image content block
        if (data.data?.base64 && data.data?.format) {
          const mediaType = data.data.format === "jpeg" ? "image/jpeg" : "image/png";
          return { _contentType: "image", base64: data.data.base64, mediaType, description: "Live screenshot of user's Mac screen" };
        }
        return data.data;
      } catch (e) { return { error: "Could not reach Bridge. Is the app running on your Mac?" }; }
    }

    case "search_cache": {
      try {
        // If type is specified and not email, use universal cache search
        if (toolInput.type && toolInput.type !== "email") {
          const { queryCacheUniversal } = require("../services/data-sync");
          const result = await queryCacheUniversal(toolInput._userId, {
            query: toolInput.query,
            type: toolInput.type,
            source: toolInput.source,
            days: toolInput.days || 30,
            max_results: toolInput.max_results || 20,
          });
          if (result && result.results && result.results.length > 0) {
            return result;
          }
          // Cache empty: try live API fallback for the connected service
          const serviceName = toolInput.source || toolInput.type;
          if (serviceName) {
            try {
              const { supabase } = require("../../user-store");
              const { data: conn } = await supabase.from("connections")
                .select("sync_list_method").eq("user_id", toolInput._userId).eq("service", serviceName).single();
              const listUrl = conn?.sync_list_method;
              if (listUrl && listUrl !== "/") {
                console.log(`[search] Cache empty for ${serviceName}, trying live API: ${listUrl}`);
                const liveResult = await handleInternalTool("api_request", {
                  service: serviceName, method: "GET", url: listUrl, _userId: toolInput._userId, _chatId: toolInput._chatId,
                });
                if (liveResult && !liveResult.error) {
                  // Extract items from API response
                  const items = Array.isArray(liveResult) ? liveResult
                    : liveResult.items || liveResult.results || liveResult.data || liveResult.value || [];
                  if (items.length > 0) {
                    // Filter by query keywords
                    const keywords = (toolInput.query || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
                    const filtered = keywords.length > 0
                      ? items.filter(item => keywords.some(kw => JSON.stringify(item).toLowerCase().includes(kw)))
                      : items;
                    return { results: filtered.slice(0, toolInput.max_results || 20), source: "live_api", service: serviceName };
                  }
                }
              }
            } catch (e) {
              console.log(`[search] Live API fallback failed for ${serviceName}: ${e.message}`);
            }
          }
          return { results: [], message: `No ${toolInput.type || "data"} found matching "${toolInput.query}".` };
        }
        // Email search (or untyped): cache-first + live fallback
        return await searchCache(toolInput._userId, {
          query: toolInput.query,
          scope: toolInput.scope || "all",
          days: toolInput.days || 7,
          max_results: toolInput.max_results || 20,
          unread_only: toolInput.unread_only || false,
          has_attachment: toolInput.has_attachment || false,
        });
      } catch (e) {
        return { error: `Search failed: ${e.message}` };
      }
    }
    case "search_calendar": {
      try {
        return await searchCalendar(toolInput._userId, {
          start: toolInput.start,
          end: toolInput.end,
          scope: toolInput.scope || "all",
          query: toolInput.query,
        });
      } catch (e) {
        return { error: `Calendar search failed: ${e.message}` };
      }
    }
    case "fetch_attachment": {
      try {
        return await fetchAttachment(toolInput._userId, {
          source: toolInput.source,
          message_id: toolInput.message_id,
          attachment_id: toolInput.attachment_id,
          filename: toolInput.filename,
          save_to_drive: toolInput.save_to_drive || false,
          send_to_user: toolInput.send_to_user || false,
          _chatId: toolInput._chatId,
        });
      } catch (e) {
        return { error: `Attachment download failed: ${e.message}` };
      }
    }

    // === DATASETS ===
    case "dataset_create": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      const cols = (toolInput.columns || []).map(c => ({ name: c.name, type: c.type || "text" }));
      const { data, error } = await supabase.from("datasets").insert({
        user_id: userId, name: toolInput.name, columns: cols, description: toolInput.description || null,
      }).select().single();
      if (error) return { error: error.message.includes("unique") ? `Dataset "${toolInput.name}" already exists` : error.message };
      return { success: true, id: data.id, name: data.name, columns: cols };
    }

    case "dataset_add_rows": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      const { data: ds } = await supabase.from("datasets").select("id").eq("user_id", userId).eq("name", toolInput.dataset).single();
      if (!ds) return { error: `Dataset "${toolInput.dataset}" not found` };
      const rows = (toolInput.rows || []).map((row, i) => ({
        dataset_id: ds.id, user_id: userId, data: row, row_index: i,
      }));
      const { error } = await supabase.from("dataset_rows").insert(rows);
      if (error) return { error: error.message };
      await supabase.from("datasets").update({ row_count: rows.length, updated_at: new Date().toISOString() }).eq("id", ds.id);
      // Fix row count to be accurate
      const { count } = await supabase.from("dataset_rows").select("id", { count: "exact", head: true }).eq("dataset_id", ds.id);
      await supabase.from("datasets").update({ row_count: count || 0 }).eq("id", ds.id);
      return { success: true, added: rows.length, total: count || rows.length };
    }

    case "dataset_query": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      const { data: ds } = await supabase.from("datasets").select("id, columns").eq("user_id", userId).eq("name", toolInput.dataset).single();
      if (!ds) return { error: `Dataset "${toolInput.dataset}" not found` };
      let query = supabase.from("dataset_rows").select("id, data, row_index, created_at").eq("dataset_id", ds.id);
      // Apply filters on JSONB data
      const filter = toolInput.filter || {};
      for (const [key, val] of Object.entries(filter)) {
        query = query.eq(`data->>${key}`, String(val));
      }
      if (toolInput.order_by) {
        query = query.order(`data->>${toolInput.order_by}`, { ascending: toolInput.order_dir !== "desc" });
      } else {
        query = query.order("row_index", { ascending: true });
      }
      query = query.limit(toolInput.limit || 50);
      const { data: rows, error } = await query;
      if (error) return { error: error.message };
      return { dataset: toolInput.dataset, columns: ds.columns, rows: (rows || []).map(r => ({ id: r.id, ...r.data })), total: rows?.length || 0 };
    }

    case "dataset_update_rows": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      const { data: ds } = await supabase.from("datasets").select("id").eq("user_id", userId).eq("name", toolInput.dataset).single();
      if (!ds) return { error: `Dataset "${toolInput.dataset}" not found` };
      // Find matching rows
      let query = supabase.from("dataset_rows").select("id, data").eq("dataset_id", ds.id);
      for (const [key, val] of Object.entries(toolInput.filter || {})) {
        query = query.eq(`data->>${key}`, String(val));
      }
      const { data: rows } = await query;
      if (!rows || rows.length === 0) return { error: "No rows matched the filter" };
      // Update each row's JSONB data
      let updated = 0;
      for (const row of rows) {
        const newData = { ...row.data, ...toolInput.set };
        await supabase.from("dataset_rows").update({ data: newData, updated_at: new Date().toISOString() }).eq("id", row.id);
        updated++;
      }
      return { success: true, updated };
    }

    case "dataset_delete_rows": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      const { data: ds } = await supabase.from("datasets").select("id").eq("user_id", userId).eq("name", toolInput.dataset).single();
      if (!ds) return { error: `Dataset "${toolInput.dataset}" not found` };
      let query = supabase.from("dataset_rows").select("id").eq("dataset_id", ds.id);
      for (const [key, val] of Object.entries(toolInput.filter || {})) {
        query = query.eq(`data->>${key}`, String(val));
      }
      const { data: rows } = await query;
      if (!rows || rows.length === 0) return { error: "No rows matched the filter" };
      const ids = rows.map(r => r.id);
      await supabase.from("dataset_rows").delete().in("id", ids);
      const { count } = await supabase.from("dataset_rows").select("id", { count: "exact", head: true }).eq("dataset_id", ds.id);
      await supabase.from("datasets").update({ row_count: count || 0, updated_at: new Date().toISOString() }).eq("id", ds.id);
      return { success: true, deleted: ids.length, remaining: count || 0 };
    }

    case "dataset_list": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      const { data, error } = await supabase.from("datasets").select("id, name, columns, description, row_count, created_at, updated_at").eq("user_id", userId).order("created_at", { ascending: false });
      if (error) return { error: error.message };
      return { datasets: data || [] };
    }

    case "dataset_delete": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      const { data: ds } = await supabase.from("datasets").select("id").eq("user_id", userId).eq("name", toolInput.dataset).single();
      if (!ds) return { error: `Dataset "${toolInput.dataset}" not found` };
      await supabase.from("datasets").delete().eq("id", ds.id);
      return { success: true, deleted: toolInput.dataset };
    }

    case "rag_retrieve": {
      const { supabase } = require("../../user-store");
      const userId = ctx.activeUserId;
      try {
        let filePath, origin, fileName;
        if (toolInput.file_path && toolInput.origin) {
          filePath = toolInput.file_path;
          origin = toolInput.origin;
          fileName = filePath.split("/").pop();
        } else if (toolInput.query) {
          // A file is nearly always asked for by its name, and the name is in
          // neither the chunk text nor the embedded text, so the vector arm
          // can only ever match it by accident. Try the lexical arm first,
          // which reads the filename, then fall back to meaning for "the
          // invoice from the Shenzhen factory".
          let matches = null;
          try {
            const { lexicalTokens } = require("../services/lexical");
            const { data: lex } = await supabase.rpc("search_rag_chunks_lexical", {
              match_user_id: userId,
              query_tokens: lexicalTokens(toolInput.query, { corpus: "files" }),
              match_count: 1,
            });
            if (lex?.length) matches = lex;
          } catch (e) { /* no lexical index: fall through to the vector arm */ }
          if (!matches) {
            const { data: vec } = await supabase.rpc("match_rag_chunks", {
              query_embedding: JSON.stringify(await require("../../webapp/rag-processor").embedSingle(toolInput.query)),
              match_user_id: userId, match_threshold: 0.3, match_count: 1,
            });
            matches = vec;
          }
          if (!matches?.length) return { error: "No matching document found in library" };
          const { data: doc } = await supabase.from("rag_documents").select("file_path, origin, name").eq("id", matches[0].document_id).single();
          if (!doc?.file_path) return { error: "Document source path unavailable" };
          filePath = doc.file_path; origin = doc.origin; fileName = doc.name;
        } else {
          return { error: "Provide query or file_path + origin" };
        }

        if (origin === "cloud") {
          const { ensureSandbox, sandboxFileDownload } = require("../sandbox");
          await ensureSandbox(userId);
          const file = await sandboxFileDownload(userId, filePath);
          if (file.error) return file;
          const { sendDocumentToPlatform } = require("../messaging");
          await sendDocumentToPlatform(ctx.activePlatform, ctx.activeChatId, Buffer.from(file.content, "base64"), fileName, file.mime_type);
          return { success: true, message: "Sent " + fileName };
        } else if (origin === "bridge") {
          const { bridgeRequest } = require("../services/bridge-relay");
          const result = await bridgeRequest(userId, "files.read", { path: filePath, encoding: "base64" }, 30000);
          if (!result?.content) return { error: "Bridge couldn't read the file. Is it connected?" };
          const { sendDocumentToPlatform } = require("../messaging");
          const mimeMap = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv" };
          const ext = require("path").extname(fileName).toLowerCase();
          await sendDocumentToPlatform(ctx.activePlatform, ctx.activeChatId, Buffer.from(result.content, "base64"), fileName, mimeMap[ext] || "application/octet-stream");
          return { success: true, message: "Sent " + fileName };
        } else if (origin === "gdrive" || origin === "onedrive" || origin === "dropbox") {
          // Fetch file from cloud storage via rag-processor helpers
          const ragProcessor = require("../../webapp/rag-processor");
          const buffer = await ragProcessor.fetchFileContent(userId, origin, filePath);
          const { sendDocumentToPlatform } = require("../messaging");
          const mimeMap = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv" };
          const ext = require("path").extname(fileName).toLowerCase();
          await sendDocumentToPlatform(ctx.activePlatform, ctx.activeChatId, buffer, fileName, mimeMap[ext] || "application/octet-stream");
          return { success: true, message: "Sent " + fileName };
        }
        return { error: "Unknown origin: " + origin };
      } catch (e) { return { error: "File retrieval failed: " + e.message }; }
    }

    default:
      return { error: `Unknown internal tool: ${toolName}` };
  }
}

function isInternalTool(toolName) {
  return INTERNAL_TOOLS.some((t) => t.name === toolName);
}

// ============================================================================
// NOTES: Metadata migration + compaction
// ============================================================================

/**
 * Migrate plain string facts to metadata format on first access.
 * Idempotent: only wraps facts that are still plain strings.
 * Backward compat: if ctx.store.facts is empty, fall back to ctx.store.facts.
 */
function _migrateFactsMetadata() {
  if (!ctx.store.facts) { ctx.store.facts = {}; return; }
  const now = new Date().toISOString();
  let migrated = 0;
  for (const key of Object.keys(ctx.store.facts)) {
    const val = ctx.store.facts[key];
    if (typeof val === "string") {
      ctx.store.facts[key] = { value: val, created: now, lastAccessed: now, accessCount: 0 };
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`[Facts] Migrated ${migrated} plain string facts to metadata format`);
    saveStore();
  }
}

// Internal state lives in the same table as the user's pinned facts, so the
// prompt has to filter or it ships all of it: at its worst this block was
// carrying ~6,500 tokens of dead pulse logs, WhatsApp message ids and flight
// JSON into every single message. Same predicate the dashboard and the fact
// mirror use, which is why it is shared rather than written out again here.
const { isInternalFactKey } = require("../services/fact-vectors");

// Built lazily: user-store and the embedder both pull in the database client,
// and this module is required at load time by the engine.
let _fv = null;
function _factVectors() {
  if (!_fv) {
    const { factVectors } = require("../services/fact-vectors");
    _fv = factVectors({
      supabase: require("../../user-store").supabase,
      embed: (text) => require("../services/usi").embedDocument(text),
    });
  }
  return _fv;
}

/**
 * Extract just the value strings from pinned facts (for system prompt injection).
 * Returns a plain {key: value} object without metadata.
 * Backward compat: falls back to ctx.store.facts if facts is empty.
 */
function getFactsValues() {
  const source = ctx.store.facts || {};
  const result = {};
  for (const [key, note] of Object.entries(source)) {
    if (isInternalFactKey(key)) continue;
    result[key] = typeof note === "object" && note.value !== undefined ? note.value : note;
  }
  return result;
}

/**
 * Compact pinned facts when count reaches 150. Uses Haiku to decide what to keep/compress/drop.
 * Reduces back to ~80-100 facts.
 */
async function _compactFacts() {
  const factKeys = Object.keys(ctx.store.facts);
  if (factKeys.length < 150) return;

  console.log(`[Facts] Compaction triggered: ${factKeys.length} facts`);

  // Build the full fact list with metadata for Haiku
  const factList = factKeys.map(key => {
    const fact = ctx.store.facts[key];
    if (typeof fact === "object" && fact.value !== undefined) {
      return { key, value: fact.value, created: fact.created, lastAccessed: fact.lastAccessed, accessCount: fact.accessCount || 0 };
    }
    return { key, value: fact, created: "unknown", lastAccessed: "unknown", accessCount: 0 };
  });

  try {
    const { client: compactClient, model: compactModel } = getInternalClient();
    const response = await compactClient.messages.create({
      model: compactModel,
      max_tokens: 8000,
      messages: [{
        role: "user",
        content: `Here are ${factList.length} pinned facts for a user, with metadata showing when each was created, last accessed, and how many times it was used. Reduce this to approximately 80-100 facts by categorising each as:
- KEEP: Core identity facts (name, age, family, home, work), active preferences, important relationships, frequently used. Preserve exactly as-is regardless of access patterns.
- COMPRESS: Useful but verbose. Shorten to key facts only.
- DROP: Completed projects, one-off facts, low access count AND low inherent importance.

Return ONLY a valid JSON object with the surviving facts as key-value pairs (string values only). Do not drop anything that a reasonable person would consider a core personal fact.

Facts:
${JSON.stringify(factList, null, 1)}`,
      }],
    });

    const text = response.content[0]?.text || "";
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[Facts] Compaction: no valid JSON in Haiku response");
      return;
    }

    let compacted;
    try {
      compacted = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("[Facts] Compaction: failed to parse JSON:", e.message);
      return;
    }

    const compactedKeys = Object.keys(compacted);
    if (compactedKeys.length < 20) {
      console.error(`[Facts] Compaction: Haiku returned only ${compactedKeys.length} facts, too aggressive. Aborting.`);
      return;
    }

    // Build new facts with metadata preserved where possible
    const now = new Date().toISOString();
    const newFacts = {};
    let kept = 0, compressed = 0, dropped = 0;

    for (const key of compactedKeys) {
      const oldFact = ctx.store.facts[key];
      const newValue = String(compacted[key]);
      if (oldFact && typeof oldFact === "object" && oldFact.value !== undefined) {
        const wasCompressed = newValue !== oldFact.value;
        newFacts[key] = {
          value: newValue,
          created: oldFact.created,
          lastAccessed: oldFact.lastAccessed,
          accessCount: oldFact.accessCount || 0,
        };
        if (wasCompressed) compressed++;
        else kept++;
      } else {
        newFacts[key] = { value: newValue, created: now, lastAccessed: now, accessCount: 0 };
        kept++;
      }
    }

    dropped = factKeys.length - compactedKeys.length;

    // Delete dropped facts from Supabase
    const droppedKeys = factKeys.filter(k => !compactedKeys.includes(k));
    if (droppedKeys.length > 0 && ctx.activeUserStore) {
      const supabase = require("../../user-store").supabase;
      const userId = ctx.activeUserStore.userId;
      for (const key of droppedKeys) {
        supabase.from("facts").delete().eq("user_id", userId).eq("key", key).then(() => {}).catch(() => {});
      }
    }

    ctx.store.facts = newFacts;
    saveStore();

    console.log(`[Facts] Compacted ${factKeys.length} -> ${compactedKeys.length} facts (dropped ${dropped}, compressed ${compressed}, kept ${kept})`);
  } catch (e) {
    console.error("[Facts] Compaction failed:", e.message);
  }
}

module.exports = { handleInternalTool, isInternalTool, getFactsValues, createGmailDraft, sendGmailDraft, deleteGmailDraft };
