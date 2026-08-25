// ============================================================
// user-store.js — Per-user data layer with Supabase backend
// 
// Drop-in replacement for the global store object.
// Load at start of message, use synchronously, save at end.
//
// Usage:
//   const userStore = await UserStore.load(userId);
//   userStore.notes["key"] = "value";        // same as before
//   userStore.conversations.push(message);   // same as before
//   await userStore.save();                   // writes to Supabase
// ============================================================

const { supabase } = require("./lib/db");
const { encryptTokens, decryptTokens } = require("./crypto-tokens");

class UserStore {
  constructor(userId) {
    this.userId = userId;
    this.conversations = [];
    this.facts = {};
    this.schedules = [];
    this.attachments = [];
    this.location = null;
    this.pulse = {
      enabled: false,
      intervalMinutes: 20,
      quietStart: 22,
      quietEnd: 7,
      lastRun: null,
      lastNotified: null,
      recentNotifications: [],
      sentAttachments: [],
    };
    this.connections = {};  // { google: { tokens, config }, shopify: { tokens, config }, ... }
    this.sandbox = null;    // { railway_service_id, hostname, sandbox_token, status, ... }
    this.workspaceFiles = null; // { files: [...], cached_at: "..." } — cached /workspace listing
    this.profile = null;
    this.activeThreadId = null;
    this.threadList = [];
    this.userRules = [];
    this.ragDocumentCount = 0;

    // Track what changed so we only write what's needed
    this._dirty = new Set();
  }

  // Legacy alias: callers read userStore.notes; data lives in this.facts.
  get notes() { return this.facts; }

  // ============================================================
  // LOAD — Pull all user data from Supabase in parallel
  // ============================================================
  static async load(userId) {
    const store = new UserStore(userId);

    // Fetch everything in parallel for speed
    const [convoRes, notesRes, schedRes, attRes, pulseRes, connRes, profileRes, sandboxRes, bridgeRes, rulesRes, ragDocsRes] =
      await Promise.all([
        supabase
          .from("conversations")
          .select("messages")
          .eq("user_id", userId)
          .single(),
        supabase
          .from("facts")
          .select("key, value")
          .eq("user_id", userId),
        supabase
          .from("schedules")
          .select("*")
          .eq("user_id", userId)
          .eq("enabled", true),
        supabase
          .from("attachments")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false }),
        supabase
          .from("pulse_config")
          .select("*")
          .eq("user_id", userId)
          .single(),
        supabase
          .from("connections")
          .select("service, tokens, config, metadata")
          .eq("user_id", userId),
        supabase
          .from("profiles")
          .select("*")
          .eq("id", userId)
          .single(),
        supabase
          .from("sandboxes")
          .select("*")
          .eq("user_id", userId)
          .eq("status", "active")
          .single(),
        supabase
          .from("user_bridges")
          .select("status")
          .eq("user_id", userId)
          .single(),
        supabase
          .from("user_rules")
          .select("id, rule, source")
          .eq("user_id", userId)
          .eq("active", true),
        supabase
          .from("rag_documents")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("status", "ready"),
      ]);

    // Conversations (legacy table)
    if (convoRes.data) {
      store.conversations = convoRes.data.messages || [];
    }

    // Try loading from conversation_threads (new system)
    try {
      const { data: activeThread } = await supabase
        .from("conversation_threads")
        .select("id, messages")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .single();

      if (activeThread) {
        store.conversations = activeThread.messages || [];
        store.activeThreadId = activeThread.id;
      } else {
        // No active thread. Auto-resume the most recent thread if it's fresh and short.
        const { data: recentThread } = await supabase.from("conversation_threads")
          .select("id, messages, updated_at")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .single();

        const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
        const canResume = recentThread
          && new Date(recentThread.updated_at).getTime() > fourHoursAgo
          && (recentThread.messages || []).length < 30;

        if (canResume) {
          // Resume recent thread
          await supabase.from("conversation_threads")
            .update({ is_active: true, updated_at: new Date().toISOString() })
            .eq("id", recentThread.id);
          store.conversations = recentThread.messages || [];
          store.activeThreadId = recentThread.id;
        } else if (recentThread && (recentThread.messages || []).length > 2) {
          // Old/long thread not resumable. Vectorise it before starting fresh.
          try {
            const { _vectoriseThread } = require("./lib/conversation");
            _vectoriseThread(userId, recentThread.id, recentThread.messages).catch(() => {});
          } catch (_) {}
          // Fall through to create fresh thread
          const { data: newThread } = await supabase.from("conversation_threads")
            .insert({ user_id: userId, is_active: true })
            .select("id").single();
          if (newThread) store.activeThreadId = newThread.id;
        } else if (store.conversations && store.conversations.length > 0) {
          // Legacy migration
          const { data: migratedThread } = await supabase.from("conversation_threads")
            .insert({ user_id: userId, messages: store.conversations, is_active: true })
            .select("id").single();
          if (migratedThread) store.activeThreadId = migratedThread.id;
        } else {
          // Fresh thread
          const { data: newThread } = await supabase.from("conversation_threads")
            .insert({ user_id: userId, is_active: true })
            .select("id").single();
          if (newThread) store.activeThreadId = newThread.id;
        }
      }

      // Load thread list for sidebar
      const { data: threadList } = await supabase.from("conversation_threads")
        .select("id, title, is_active, created_at, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(20);
      store.threadList = threadList || [];
    } catch (e) {
      // conversation_threads table may not exist yet - fall back to legacy
      console.log("[Threads] Falling back to legacy conversations:", e.message);
      store.activeThreadId = null;
      store.threadList = [];
    }

    // Notes — convert rows to object. Values may be plain strings (legacy)
    // or JSON-serialized metadata objects {value, created, lastAccessed, accessCount}.
    if (notesRes.data) {
      for (const row of notesRes.data) {
        let val = row.value;
        // Try to parse JSON metadata format
        if (typeof val === "string" && val.startsWith("{")) {
          try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === "object" && parsed.value !== undefined) {
              val = parsed; // Metadata object
            }
          } catch (e) {} // Not JSON, keep as plain string
        }
        store.facts[row.key] = val;
      }
    }

    // Schedules — map to same format
    if (schedRes.data) {
      store.schedules = schedRes.data.map((s) => ({
        name: s.name,
        cron: s.cron_expression,
        task: s.task,
        id: s.id,
      }));
    }

    // Attachments — map to same format.
    //
    // The row keeps what a person needs (name, description, where the bytes
    // are); everything that decides HOW to open the file has to be derived
    // back, because saveAttachment never wrote it. Without this an attachment
    // read from the database has ext, isImage, isPdf and isText all undefined,
    // so view_attachment falls past every branch to "This file type
    // (undefined) can't be viewed directly" for a plain JPEG, and any agent
    // that loads a store from Supabase is blind to a picture the user sent it
    // seconds earlier. The description survives, which is what made it look
    // like a model failure rather than a missing field.
    if (attRes.data) {
      const { TEXT_EXTENSIONS, IMAGE_EXTENSIONS, OFFICE_EXTENSIONS, MIME_TYPES } = require("./lib/files");
      const { ATTACHMENTS_DIR } = require("./lib/attachments");
      const path = require("path");
      // Name first: it is what saveAttachment used, so it round-trips exactly.
      // Media type is the fallback for a name that carries no extension.
      const extFor = (fileName, mediaType) => {
        const dot = (fileName || "").lastIndexOf(".");
        if (dot > 0) return fileName.slice(dot + 1).toLowerCase();
        const base = (mediaType || "").split(";")[0].trim();
        return Object.keys(MIME_TYPES).find((k) => MIME_TYPES[k] === base) || "";
      };
      store.attachments = attRes.data.map((a) => {
        const ext = extFor(a.file_name, a.media_type);
        return {
          id: a.attachment_id,
          fileName: a.file_name,
          description: a.description,
          mediaType: a.media_type,
          storagePath: a.storage_path,
          sizeBytes: a.size_bytes,
          direction: a.direction,
          date: a.created_at,
          ext,
          isImage: IMAGE_EXTENSIONS.includes(ext),
          isText: TEXT_EXTENSIONS.includes(ext) || OFFICE_EXTENSIONS.includes(ext),
          isPdf: ext === "pdf",
          // Same shape saveAttachment writes. The file is usually absent in
          // this process, and every reader already falls back to storage, but
          // a real path lets the local cache work and keeps fs calls off
          // undefined.
          filePath: path.join(ATTACHMENTS_DIR, `${a.attachment_id}.${ext}`),
        };
      });
    }

    // Pulse config - load from pulse_config table as fallback, profile settings override below
    if (pulseRes.data) {
      store.pulse = {
        enabled: pulseRes.data.enabled,
        intervalMinutes: pulseRes.data.interval_minutes,
        quietStart: pulseRes.data.quiet_hours_start,
        quietEnd: pulseRes.data.quiet_hours_end,
        lastRun: pulseRes.data.last_run,
        lastNotified: pulseRes.data.last_notified,
      };
    }
    // Also sync lastRun/lastNotified into store for later reference
    const pulseLastRun = pulseRes.data?.last_run || null;
    const pulseLastNotified = pulseRes.data?.last_notified || null;

    // Connections — keyed by service name
    if (connRes.data) {
      for (const conn of connRes.data) {
        store.connections[conn.service] = {
          tokens: decryptTokens(conn.tokens),
          config: conn.config,
          metadata: conn.metadata,
        };
      }
    }

    // Profile (includes location in settings)
    if (profileRes.data) {
      store.profile = profileRes.data;
      store.location = profileRes.data.settings?.location || null;

      // Sync pulse state from profile settings (authoritative source, set by dashboard)
      // Profile settings ALWAYS override the pulse_config table
      const ps = profileRes.data.settings?.pulse_settings || {};
      const profileLevel = ps.proactiveLevel;
      if (profileLevel) {
        store.pulse.enabled = profileLevel !== "off";
        store.pulse.proactiveLevel = profileLevel;
      }
      if (ps.quietStart != null) store.pulse.quietStart = ps.quietStart;
      if (ps.quietEnd != null) store.pulse.quietEnd = ps.quietEnd;
      if (ps.deliveryPlatforms) store.pulse.deliveryPlatforms = ps.deliveryPlatforms;
      // Preserve timing fields from pulse_config table
      if (pulseLastRun) store.pulse.lastRun = pulseLastRun;
      if (pulseLastNotified) store.pulse.lastNotified = pulseLastNotified;
    }

    // Sandbox
    if (sandboxRes.data) {
      store.sandbox = sandboxRes.data;
      store.workspaceFiles = sandboxRes.data.metadata?.workspace_files || null;
    }

    // Bridge connection status
    // Accept "connected" or "reconnecting" (WS may be briefly absent)
    // Also treat any existing row as "paired" so bridge tools are available
    const bridgeStatus = bridgeRes.data?.status;
    store.bridgeConnected = !!(bridgeStatus && bridgeStatus !== "not_paired");

    // User rules (persistent preferences)
    if (rulesRes.data) {
      store.userRules = rulesRes.data.filter(r => r.active).map(r => ({ id: r.id, rule: r.rule, source: r.source || 'user' }));
    }

    // RAG document count
    if (ragDocsRes?.count != null) {
      store.ragDocumentCount = ragDocsRes.count;
    }

    return store;
  }

  // ============================================================
  // MARK DIRTY — Track what needs saving
  // ============================================================
  markDirty(field) {
    this._dirty.add(field);
  }

  // ============================================================
  // SAVE — Write only changed data back to Supabase
  // ============================================================
  async save() {
    const promises = [];

    if (this._dirty.has("conversations")) {
      promises.push(
        supabase.from("conversations").upsert(
          {
            user_id: this.userId,
            messages: this.conversations,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
      );

      // Also save to conversation_threads if we have a thread ID
      if (this.activeThreadId) {
        promises.push(
          supabase.from("conversation_threads").update({
            messages: this.conversations,
            updated_at: new Date().toISOString(),
          }).eq("id", this.activeThreadId)
        );
      }
    }

    if (this._dirty.has("facts")) {
      // Upsert all notes (avoids race conditions with concurrent saves)
      // Notes may be plain strings or metadata objects {value, created, lastAccessed, accessCount}.
      // Serialize objects to JSON string for storage; plain strings stay as-is.
      if (Object.keys(this.facts).length > 0) {
        promises.push(
          supabase.from("facts").upsert(
            Object.entries(this.facts).map(([key, noteData]) => ({
              user_id: this.userId,
              key,
              value: typeof noteData === "object" && noteData !== null && noteData.value !== undefined
                ? JSON.stringify(noteData)
                : String(noteData),
              updated_at: new Date().toISOString(),
            })),
            { onConflict: "user_id,key" }
          )
        );
      }
    }

    if (this._dirty.has("pulse")) {
      promises.push(
        supabase.from("pulse_config").upsert(
          {
            user_id: this.userId,
            enabled: this.pulse.enabled,
            interval_minutes: this.pulse.intervalMinutes,
            quiet_hours_start: this.pulse.quietStart,
            quiet_hours_end: this.pulse.quietEnd,
            last_run: this.pulse.lastRun,
            last_notified: this.pulse.lastNotified,
          },
          { onConflict: "user_id" }
        )
      );
    }

    if (this._dirty.has("location")) {
      const currentSettings = this.profile?.settings || {};
      promises.push(
        supabase
          .from("profiles")
          .update({
            settings: { ...currentSettings, location: this.location },
            updated_at: new Date().toISOString(),
          })
          .eq("id", this.userId)
      );
    }

    if (this._dirty.has("attachments")) {
      // For attachments, we upsert individually since they're added one at a time
      // This is handled by saveAttachment() below, so nothing to batch here
    }

    if (promises.length > 0) {
      const results = await Promise.all(promises);
      for (const res of results) {
        if (res?.error) {
          console.error("UserStore save error:", res.error.message);
        }
      }
    }

    this._dirty.clear();
  }

  // ============================================================
  // HELPER METHODS (match existing store usage patterns)
  // ============================================================

  // Save a single note (value may be a plain string or metadata object)
  async saveFact(key, value) {
    this.facts[key] = value;
    const dbValue = typeof value === "object" && value !== null && value.value !== undefined
      ? JSON.stringify(value)
      : String(value);
    await supabase.from("facts").upsert(
      { user_id: this.userId, key, value: dbValue, updated_at: new Date().toISOString() },
      { onConflict: "user_id,key" }
    );
  }

  // Delete a single note
  async deleteFact(key) {
    delete this.facts[key];
    await supabase.from("facts").delete().eq("user_id", this.userId).eq("key", key);
  }

  // Save a schedule
  async saveSchedule(name, cronExpression, task, chatId, runOnce = null, timezone = null) {
    // Remove existing with same name
    await supabase.from("schedules").delete().eq("user_id", this.userId).eq("name", name);
    const { data } = await supabase
      .from("schedules")
      .insert({ user_id: this.userId, name, cron_expression: cronExpression, task, enabled: true, chat_id: chatId, run_once: runOnce, timezone })
      .select()
      .single();

    // Update local copy
    this.schedules = this.schedules.filter((s) => s.name !== name);
    this.schedules.push({ name, cron: cronExpression, task, id: data?.id });
    return data;
  }

  // Delete a schedule
  async deleteSchedule(name) {
    const { data } = await supabase
      .from("schedules")
      .delete()
      .eq("user_id", this.userId)
      .eq("name", name)
      .select();

    this.schedules = this.schedules.filter((s) => s.name !== name);
    return data && data.length > 0;
  }

  // Save an attachment (metadata)
  async saveAttachment(att) {
    await supabase.from("attachments").upsert(
      {
        user_id: this.userId,
        attachment_id: att.id,
        file_name: att.fileName,
        description: att.description,
        media_type: att.mediaType,
        storage_path: att.storagePath || `${this.userId}/${att.id}`,
        size_bytes: att.sizeBytes,
        direction: att.direction || "in",
      },
      { onConflict: "user_id,attachment_id" }
    );
    // Update local copy
    const idx = this.attachments.findIndex((a) => a.id === att.id);
    if (idx >= 0) this.attachments[idx] = att;
    else this.attachments.unshift(att);
  }

  // Save location
  async saveLocation(location) {
    this.location = location;
    this.markDirty("location");
    await this.save();  // Save immediately since location is important
  }

  // Get connection tokens (returns null if not connected)
  getConnection(service) {
    return this.connections[service] || null;
  }

  // Check if a service is connected
  isConnected(service) {
    return !!this.connections[service]?.tokens;
  }

  // Save updated connection tokens (e.g. after OAuth refresh).
  // In-memory copy stays plaintext (bot uses it for API calls); only the
  // persisted copy is encrypted so at-rest exposure via Supabase is neutralised.
  async saveConnectionTokens(service, tokens) {
    if (this.connections[service]) {
      this.connections[service].tokens = tokens;
    }
    await supabase
      .from("connections")
      .update({ tokens: encryptTokens(tokens), updated_at: new Date().toISOString() })
      .eq("user_id", this.userId)
      .eq("service", service);
  }

  // Flag a connection that cannot recover on its own, so sync/API paths stop
  // retrying and logging it every cycle. Two things qualify: a permanently dead
  // refresh token (invalid_grant), and a grant that is missing scopes the reads
  // need, since neither changes without the user acting. A dashboard reconnect
  // writes fresh metadata (without this flag), which clears it.
  async markConnectionReconnectRequired(service, reason = "dead refresh token") {
    const conn = this.connections[service];
    if (!conn || conn.metadata?.reconnect_required) return; // already flagged
    conn.metadata = { ...(conn.metadata || {}), reconnect_required: true, reconnect_reason: reason };
    await supabase
      .from("connections")
      .update({ metadata: conn.metadata })
      .eq("user_id", this.userId)
      .eq("service", service);
    console.log(`[connections] ${service} marked reconnect_required for ${this.userId} (${reason})`);
  }

  // Delete a service connection (e.g. user says "disconnect Shopify")
  async deleteConnection(service) {
    delete this.connections[service];
    await supabase.from("connections").delete()
      .eq("user_id", this.userId).eq("service", service);
  }

  // Get all users with active schedules or pulse enabled (for startup registration)
  static async getActiveUsers() {
    const results = [];

    // Get users with active schedules
    const { data: schedUsers } = await supabase
      .from("schedules")
      .select("user_id, name, cron_expression, task, chat_id, run_once, timezone")
      .eq("enabled", true);

    // Get users with pulse enabled
    const { data: pulseUsers } = await supabase
      .from("pulse_config")
      .select("user_id, enabled, interval_minutes, quiet_hours_start, quiet_hours_end, proactive_level, delivery_platforms")
      .eq("enabled", true);

    // Get chat_links for all relevant users to find their Telegram chat IDs
    const userIds = new Set();
    for (const s of schedUsers || []) userIds.add(s.user_id);
    for (const p of pulseUsers || []) userIds.add(p.user_id);

    if (userIds.size === 0) return [];

    // Every platform, not just Telegram. A schedule stores the chat it was
    // created in, and asking only for Telegram links meant a schedule made on
    // WhatsApp either fired into Telegram or, for anyone without Telegram at
    // all, was never registered and silently never ran.
    const { data: chatLinks } = await supabase
      .from("chat_links")
      .select("user_id, platform, platform_user_id")
      .in("user_id", Array.from(userIds));

    const chatIdMap = {};
    const platformOfChat = {};
    for (const link of chatLinks || []) {
      if (link.platform === "telegram") chatIdMap[link.user_id] = link.platform_user_id;
      platformOfChat[`${link.user_id}:${link.platform_user_id}`] = link.platform;
    }

    // Build per-user result
    for (const userId of userIds) {
      const chatId = chatIdMap[userId];
      const userPulse = (pulseUsers || []).find((p) => p.user_id === userId) || null;

      // Skip users with nothing to deliver to and no pulse enabled
      const ownSchedules = (schedUsers || []).filter((s) => s.user_id === userId);
      if (!chatId && !userPulse && ownSchedules.length === 0) continue;

      results.push({
        userId,
        chatId,
        schedules: ownSchedules
          .map((s) => {
            // Deliver where it was asked for. Fall back to Telegram only when
            // the schedule has no chat of its own.
            const target = s.chat_id || chatId;
            return {
              name: s.name,
              cron: s.cron_expression,
              prompt: s.task,
              enabled: true,
              timezone: s.timezone,
              _userId: userId,
              _chatId: target,
              _platform: platformOfChat[`${userId}:${target}`] || "telegram",
              run_once: s.run_once,
            };
          })
          .filter((s) => s._chatId),
        pulse: userPulse,
      });
    }

    return results;
  }
}

// ============================================================
// USER LOOKUP — Find user from chat platform message
// ============================================================

async function getUserByPlatform(platform, platformUserId) {
  // Single-tenant: every inbound sender is the one admin. Record this sender as
  // the delivery target for the platform (most-recent wins) so proactive/pulse
  // messages know which chat to push to, then return the admin profile.
  const { getAdminUserId } = require("./lib/admin");
  const adminId = getAdminUserId();

  await supabase.from("chat_links").upsert(
    { user_id: adminId, platform, platform_user_id: platformUserId },
    { onConflict: "user_id,platform" }
  );

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", adminId).single();
  return { id: adminId, ...(profile || {}) };
}

// ============================================================
// FILE STORAGE — Upload/download from Supabase Storage
// ============================================================

async function uploadFile(userId, attachmentId, fileBuffer, mimeType) {
  const storagePath = `${userId}/${attachmentId}`;
  const { error } = await supabase.storage
    .from("attachments")
    .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: true });

  if (error) console.error("Upload error:", error.message);
  return storagePath;
}

async function downloadFile(storagePath) {
  const { data, error } = await supabase.storage
    .from("attachments")
    .download(storagePath);

  if (error) {
    console.error("Download error:", error.message);
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}

// ============================================================
// AUTO-ENABLE NOTIFICATION PLATFORM
// ============================================================

async function autoEnableNotificationPlatform(userId, platform) {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    if (error || !profile) return;

    const settings = profile.settings || {};
    const pulseSettings = settings.pulse_settings || {
      enabled: false,
      intervalMinutes: 20,
      proactiveLevel: "medium",
      quietStart: 22,
      quietEnd: 7,
      deliveryPlatforms: [],
      lastRun: null,
      lastNotified: null,
    };

    const platforms = pulseSettings.deliveryPlatforms || [];
    // First-link default only: once the user has any selection (auto or
    // manual), newly linked apps are NOT force-added — proactive messages go
    // only to apps the user chose in settings.
    if (platforms.length > 0) return;

    platforms.push(platform);
    pulseSettings.deliveryPlatforms = platforms;
    // Pulse defaults ON (medium) the moment it first becomes deliverable:
    // web-only signups have nowhere to receive it, so it stays off until the
    // first chat app is linked. The 10-min reconciler picks this up. Quiet
    // hours default 22:00-07:00. User can change or disable in settings.
    if (!pulseSettings.proactiveLevel) pulseSettings.proactiveLevel = "medium";
    settings.pulse_settings = pulseSettings;

    await supabase
      .from("profiles")
      .update({ settings })
      .eq("id", userId);
  } catch (e) {
    console.error(`[autoEnableNotificationPlatform] Error for user ${userId}, platform ${platform}:`, e.message);
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  supabase,
  UserStore,
  getUserByPlatform,
  autoEnableNotificationPlatform,
  uploadFile,
  downloadFile,
};
