// lib/status-feed.js -- Activity feed for tool execution status
// Accumulates StatusEvents and delegates rendering to platform-specific renderers.

const { INTERNAL_TOOLS } = require("./tools/definitions");

// ============================================================================
// ACTIVITY DESCRIPTIONS
// ============================================================================

// Fallback map for tools without activityDescription (legacy compat)
const FALLBACK_MAP = [
  [/^search_cache/, "Searching your email"],
  [/^search_calendar/, "Checking your calendar"],
  [/^fetch_attachment/, "Downloading an attachment"],
  [/^gmail_send/, "Drafting an email"],
  [/^gmail_reply/, "Drafting a reply"],
  [/^gcal_create/, "Creating calendar event"],
  [/^gcal_delete/, "Removing calendar event"],
  [/^gcal_/, "Checking calendar"],
  [/^web_search/, "Searching the web"],
  [/^web_fetch/, "Reading a webpage"],
  [/^weather_lookup/, "Checking weather"],
  [/^air_quality/, "Checking air quality"],
  [/^maps_/, "Looking up location"],
  [/^tfl_/, "Checking transport"],
  [/^drive_/, "Searching your Drive"],
  [/^pin_fact/, "Pinning a fact"],
  [/^get_facts/, "Checking pinned facts"],
  [/^bridge_calendar/, "Checking Mac Calendar"],
  [/^bridge_files/, "Accessing local files"],
  [/^bridge_shell/, "Running a command"],
  [/^bridge_browser/, "Checking browser"],
  [/^bridge_screenshot/, "Taking a screenshot"],
  [/^bridge_ax_/, "Reading app UI"],
  [/^bridge_input_/, "Interacting with screen"],
  [/^bridge_session_/, "Using terminal"],
  [/^sandbox_/, "Using cloud computer"],
  [/^flight_/, "Checking flights"],
  [/^api_request/, "Querying a service"],
  [/^pulse_/, "Running pulse check"],
  [/^list_connections/, "Checking connections"],
  [/^connect_service/, "Connecting a service"],
  [/^agent_start/, "Starting background agent"],
];

/**
 * Get a human-readable activity description for a tool call.
 * Checks the tool's activityDescription function first, falls back to regex map.
 */
function getActivityDescription(toolName, input) {
  // Check tool definition for activityDescription function
  const toolDef = INTERNAL_TOOLS.find(t => t.name === toolName);
  if (toolDef && typeof toolDef.activityDescription === "function") {
    try {
      const desc = toolDef.activityDescription(input || {});
      if (desc) return desc;
    } catch (e) {}
  }

  // Fallback to regex map
  for (const [pattern, text] of FALLBACK_MAP) {
    if (pattern.test(toolName)) return text;
  }

  return null; // No description available
}

// ============================================================================
// STATUS EVENT
// ============================================================================

/**
 * @typedef {Object} StatusEvent
 * @property {"thinking"|"tool_start"|"tool_end"|"done"} type
 * @property {string|null} toolName
 * @property {string} description - human-readable activity description
 * @property {boolean|null} success - null for start/thinking, true/false for end
 * @property {number} iteration - which tool loop iteration (1-based)
 * @property {number|null} elapsed - ms since tool_start (only on tool_end)
 * @property {number} timestamp - Date.now()
 */

// ============================================================================
// STATUS FEED
// ============================================================================

class StatusFeed {
  /**
   * @param {Object} renderer - Platform-specific renderer
   * @param {Function} renderer.update - Called with (events[], latestEvent)
   * @param {Function} renderer.clear - Called on done/cleanup
   */
  constructor(renderer) {
    this.renderer = renderer;
    this.events = [];
    this._toolStartTimes = {};
    this._iteration = 0;
  }

  emit(event) {
    // Auto-fill timestamp
    if (!event.timestamp) event.timestamp = Date.now();

    // Track iterations
    if (event.type === "thinking") {
      this._iteration++;
      event.iteration = this._iteration;
      event.description = event.description || "Thinking";
    }

    // Generate description for tool events
    if (event.type === "tool_start") {
      event.iteration = this._iteration;
      if (!event.description) {
        event.description = getActivityDescription(event.toolName, event.input) || `Running ${event.toolName}`;
      }
      this._toolStartTimes[event.toolName + "_" + event.timestamp] = event.timestamp;
      // Store the key so tool_end can find it
      event._startKey = event.toolName + "_" + event.timestamp;
    }

    if (event.type === "tool_end") {
      event.iteration = this._iteration;
      // Calculate elapsed from matching start
      const starts = Object.entries(this._toolStartTimes)
        .filter(([k]) => k.startsWith(event.toolName + "_"))
        .sort(([, a], [, b]) => b - a); // most recent first
      if (starts.length > 0) {
        event.elapsed = event.timestamp - starts[0][1];
        delete this._toolStartTimes[starts[0][0]];
      }
      // Carry forward description from matching start event
      if (!event.description) {
        const matchingStart = [...this.events].reverse().find(
          e => e.type === "tool_start" && e.toolName === event.toolName
        );
        event.description = matchingStart?.description || event.toolName;
      }
    }

    if (event.type === "done") {
      event.description = event.description || "Done";
    }

    this.events.push(event);

    // Delegate to renderer
    try {
      if (this.renderer && this.renderer.update) {
        this.renderer.update(this.events, event);
      }
    } catch (e) {
      console.error("[status-feed] Renderer error:", e.message);
    }

    // Auto-clear on done
    if (event.type === "done") {
      this.clear();
    }
  }

  clear() {
    try {
      if (this.renderer && this.renderer.clear) {
        this.renderer.clear();
      }
    } catch (e) {}
  }

  getEvents() {
    return this.events;
  }
}

// ============================================================================
// PLATFORM RENDERERS
// ============================================================================

/**
 * Web chat renderer -- sends activity events via WebSocket
 */
function createWebRenderer(userId, sendToUser) {
  return {
    update(events, latest) {
      // Send the full event list so the client can render the complete timeline
      sendToUser(userId, {
        type: "activity",
        events: events.map(e => ({
          type: e.type,
          toolName: e.toolName || null,
          description: e.description,
          success: e.success ?? null,
          elapsed: e.elapsed ?? null,
          iteration: e.iteration,
          timestamp: e.timestamp,
        })),
      });
    },
    clear() {
      // Client handles cleanup when it receives type "done" in events
    },
  };
}

/**
 * Edit-in-place renderer for Telegram, Discord, Slack.
 * Sends one status message and edits it as tools progress.
 * Debounces edits to avoid rate limits.
 */
function createEditInPlaceRenderer(chatId, platform, { sendFn, editFn, deleteFn }) {
  let messageInfo = null;
  let debounceTimer = null;
  let pendingText = null;
  let deleted = false;

  function formatEvents(events) {
    const lines = [];
    const toolEvents = events.filter(e => e.type === "tool_start" || e.type === "tool_end");

    // Group by tool execution (pair starts with ends)
    const completed = [];
    const running = [];

    for (const ev of toolEvents) {
      if (ev.type === "tool_end") {
        completed.push(ev);
      } else if (ev.type === "tool_start") {
        // Check if there's a matching end
        const hasEnd = toolEvents.find(
          e => e.type === "tool_end" && e.toolName === ev.toolName && e.timestamp > ev.timestamp
        );
        if (!hasEnd) running.push(ev);
      }
    }

    for (const ev of completed) {
      const elapsed = ev.elapsed ? ` (${(ev.elapsed / 1000).toFixed(1)}s)` : "";
      if (ev.success === false) {
        lines.push(`${platform === "telegram" ? "\u274c" : "x"} ${ev.description}${elapsed}`);
      } else {
        lines.push(`${platform === "telegram" ? "\u2705" : "ok"} ${ev.description}${elapsed}`);
      }
    }

    for (const ev of running) {
      lines.push(`${platform === "telegram" ? "\ud83d\udd35" : "..."} ${ev.description}...`);
    }

    return lines.join("\n") || "Working on it...";
  }

  function flush() {
    if (deleted || !pendingText) return;
    const text = pendingText;
    pendingText = null;

    if (!messageInfo) {
      // First message: send new
      sendFn(chatId, text).then(info => { messageInfo = info; }).catch(() => {});
    } else {
      // Edit existing
      editFn(messageInfo, text).catch(() => {});
    }
  }

  return {
    update(events, latest) {
      if (deleted) return;
      // Skip pure thinking events (no visible change needed)
      if (latest.type === "thinking" && events.filter(e => e.type !== "thinking").length === 0) return;

      pendingText = formatEvents(events);

      // Debounce: 250ms to batch rapid events (fast enough to feel responsive)
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, 250);
    },
    clear() {
      deleted = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (messageInfo) {
        deleteFn(messageInfo).catch(() => {});
        messageInfo = null;
      }
    },
  };
}

/**
 * Minimal renderer for WhatsApp/LINE -- only sends status for long operations
 */
function createMinimalRenderer(chatId, sendFn) {
  let sent = false;
  let timer = null;
  let latestDescription = "";

  return {
    update(events, latest) {
      if (sent) return;
      if (latest.type === "tool_start") latestDescription = latest.description;

      // Only send if operation takes >5 seconds
      if (!timer && latest.type === "tool_start") {
        timer = setTimeout(() => {
          if (!sent && latestDescription) {
            sent = true;
            sendFn(chatId, latestDescription + "...").catch(() => {});
          }
        }, 5000);
      }
    },
    clear() {
      if (timer) clearTimeout(timer);
    },
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  StatusFeed,
  getActivityDescription,
  createWebRenderer,
  createEditInPlaceRenderer,
  createMinimalRenderer,
};
