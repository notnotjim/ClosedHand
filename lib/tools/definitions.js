// lib/tools/definitions.js — INTERNAL_TOOLS array (pure data, no dependencies)

const INTERNAL_TOOLS = [
  {
    name: "add_schedule",
    groups: ["scheduling"],
    description:
      "Set a reminder for one specific moment, like 'remind me at 3pm on Friday' or 'check on this after my flight lands'. Runs the prompt then and replies in the chat it was set up in. Uses cron syntax, and set run_once so a single date does not repeat every year. The user never sees the cron line, so your reply must state when it will fire, using the next_run time the tool returns. For anything that recurs, use automation_create instead, so it lands with the user's other agents where they can see it, pause it, and give it skills.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short name for this schedule, e.g. 'weekly-briefing'",
        },
        cron_expression: {
          type: "string",
          description:
            "Cron expression for when to run, in the user's local timezone. Examples: '0 20 * * 0' = every Sunday 8pm, '0 8 * * 1-5' = weekday 8am, '*/30 * * * *' = every 30 minutes. Format: minute hour day-of-month month day-of-week. When the user gives a day but no time ('remind me tomorrow'), pick a sensible hour and tell them what you picked; they said nothing about a time, so they do not know it yet.",
        },
        prompt: {
          type: "string",
          description:
            "The prompt to send to the LLM when this schedule fires. E.g. 'Check my calendar for the week ahead and give me a summary'",
        },
        run_once: {
          type: "boolean",
          description:
            "True when this is for one occasion and should not repeat, e.g. a specific date this year. Cron has no year, so '10 3 28 7 *' otherwise fires every 28 July for ever. Leave false for anything genuinely recurring, including annual ones like a birthday.",
        },
      },
      required: ["name", "cron_expression", "prompt"],
    },
    activityDescription(input) { return `Adding schedule: ${(input.name || "").substring(0, 30)}`; },
  },
  {
    name: "list_schedules",
    groups: ["scheduling"],
    description: "List all active scheduled tasks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remove_schedule",
    groups: ["scheduling"],
    description: "Remove a scheduled task by its name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the schedule to remove" },
      },
      required: ["name"],
    },
  },
  {
    name: "pin_fact",
    core: true,
    groups: ["notes"],
    description:
      "Pin a fact about the user's life to persistent memory: who they are, who matters to them, what they do, durable preferences and dates. Never investigation findings, research results or task output, those belong in your reply and the agent report, and never operational state: a shipment in transit, a customer's delivery address for a parcel, an open invoice are the work of the week, and conversation memory already covers them. The test: will this still be true and worth knowing in six months? Write the value as one or two self-contained sentences a stranger could read cold: full names for people and companies, no conversational fragments, no 'he' or 'that invoice', no trailing clauses lifted from chat, because it will be read months from now with none of today's context. ONE NOTE PER SUBJECT. Call get_facts first and look in by_category for the category and subject you are about to use. If that subject already has a note, reuse its key so this rewrites it, folding the old and new information into one value; a second note about the same person or company is the thing this is meant to prevent. Delete the old key only when you are replacing it with a differently keyed one. If the new information contradicts what is there (they moved city, changed job), the rewrite replaces it rather than sitting alongside it.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "A short label, e.g. 'boss-email', 'preference-tone'" },
        value: { type: "string", description: "The information to remember" },
        category: {
          type: "string",
          enum: ["person", "business", "profile", "preference", "topic"],
          description: "Which group this belongs in. person: someone in the user's life, family, colleagues, customers. business: a company, product or project they run or work on. profile: who the user is, where they live, key dates. preference: how they want ClosedHand to behave. topic: durable and none of the above.",
        },
        subject: {
          type: "string",
          description: "Who or what the note is about, written the same way every time: a person's full name, a company's name. This is how you find the existing note on the next call, so 'No Strings Ltd' always, never 'No Strings' one day and 'NS Ltd' the next.",
        },
      },
      required: ["key", "value", "category", "subject"],
    },
    activityDescription(input) { return `Pinning fact: ${(input.key || "").substring(0, 30)}`; },
  },
  {
    name: "get_facts",
    core: true,
    groups: ["notes"],
    description: "Retrieve all pinned facts from persistent memory.",
    input_schema: { type: "object", properties: {} },
    activityDescription() { return "Checking pinned facts"; },
  },
  {
    name: "delete_fact",
    core: true,
    groups: ["notes"],
    description: "Delete a pinned fact from persistent memory.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key of the fact to delete" },
      },
      required: ["key"],
    },
    activityDescription(input) { return `Deleting note: ${(input.key || "").substring(0, 30)}`; },
  },
  {
    name: "save_rule",
    core: true,
    groups: ["notes"],
    description: "Save a lasting preference the user has expressed about how you should behave, like 'no emojis' or 'always check before sending'. Two tests, both required: the user actually asked for it, and it stays true when their circumstances change. Never record a task's outcome here. Updating their location or timezone is save_location's whole job, and a copy written as a rule still says the old thing after their life moves on.",
    input_schema: {
      type: "object",
      properties: {
        rule: { type: "string", description: "The preference or rule in clear, concise English. E.g. 'Always ask before sending emails', 'I am vegetarian', 'Don't use emojis'" },
      },
      required: ["rule"],
    },
    activityDescription(input) { return "Saving a preference"; },
  },
  {
    name: "get_rules",
    core: true,
    groups: ["notes"],
    description: "List all active user preferences and rules.",
    input_schema: { type: "object", properties: {} },
    activityDescription() { return "Checking your preferences"; },
  },
  {
    name: "delete_rule",
    core: true,
    groups: ["notes"],
    description: "Remove a user preference/rule. Fuzzy matches against existing rules by content.",
    input_schema: {
      type: "object",
      properties: {
        rule: { type: "string", description: "The rule text to match and delete (fuzzy match)" },
      },
      required: ["rule"],
    },
    activityDescription() { return "Removing a preference"; },
  },
  {
    name: "view_attachment",
    groups: ["attachments"],
    description:
      "View a saved attachment by its ID. Works with images, PDFs, text files, and Office documents (docx, xlsx, pptx). Returns the actual file content. Use this when the user asks about a previously uploaded file.",
    input_schema: {
      type: "object",
      properties: {
        attachment_id: {
          type: "string",
          description: "The attachment ID, e.g. 'att_1708612345678'",
        },
      },
      required: ["attachment_id"],
    },
    activityDescription() { return "Viewing attachment"; },
  },
  {
    name: "list_attachments",
    groups: ["attachments"],
    description:
      "List all saved attachments (images, documents) with their IDs and descriptions. Use this to find a specific attachment the user is referring to.",
    input_schema: { type: "object", properties: {} },
    activityDescription() { return "Listing attachments"; },
  },
  {
    name: "send_file",
    groups: ["attachments"],
    description:
      "Send a saved attachment (image, PDF, or document) directly to the user in chat. Use when the user asks to see, show, or resend a previously uploaded file. The file is sent from disk — not through the API.",
    input_schema: {
      type: "object",
      properties: {
        attachment_id: {
          type: "string",
          description: "The attachment ID, e.g. 'att_1708612345678'",
        },
      },
      required: ["attachment_id"],
    },
    activityDescription() { return "Sending file"; },
  },
  {
    name: "web_search",
    core: true,
    groups: ["web"],
    description:
      "Search the web for real-time information using Brave Search. Use for current news, prices, facts, weather context, reviews, or anything that needs up-to-date information. Returns titles, snippets, and URLs.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query, e.g. 'oil price today' or 'best restaurants in Shibuya'",
        },
        count: {
          type: "number",
          description: "Number of results to return (default 5, max 10)",
        },
      },
      required: ["query"],
    },
    activityDescription(input) { return `Searching the web for "${(input.query || "").substring(0, 50)}"`; },
  },
  {
    name: "web_fetch",
    core: true,
    groups: ["web"],
    description:
      "Fetch and read the text content of a specific URL. Use when the user shares a link or when you need to read a full article/page from a search result. Returns plain text extracted from HTML.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL to fetch, e.g. 'https://example.com/article'",
        },
      },
      required: ["url"],
    },
    activityDescription(input) {
      try { return `Reading ${new URL(input.url).hostname}`; } catch { return "Reading a webpage"; }
    },
  },
  {
    name: "weather_lookup",
    core: true,
    groups: ["weather"],
    description:
      "Get current weather and forecast. Uses the user's saved location automatically if no coordinates given. Pass latitude/longitude only if checking weather for a different location.",
    input_schema: {
      type: "object",
      properties: {
        latitude: {
          type: "number",
          description: "Latitude — omit to use saved location",
        },
        longitude: {
          type: "number",
          description: "Longitude — omit to use saved location",
        },
        location_name: {
          type: "string",
          description: "Human-readable name for context, e.g. 'London, UK'",
        },
      },
    },
    activityDescription(input) {
      if (input.location_name) return `Checking weather for ${input.location_name}`;
      return "Checking weather";
    },
  },
  // --- Sentinel: Unified Email/Calendar/Attachment Engine ---
  {
    name: "search_cache",
    core: true,
    groups: ["data"],
    description: "Search the synced data cache: emails and calendar events from ALL connected mail accounts (Gmail including extra accounts, Outlook), plus Slack messages and Notion pages when connected. Returns full raw data from the cache (complete email bodies, attendees, metadata). Use for precise lookups: 'emails from john@acme.com', 'Slack messages about launch'. For other services (Shopify, Stripe, etc.) query their APIs live instead. Filter by type and/or source for targeted searches. Emails carry the account they belong to, plus draft_id on drafts, and an attachments list (filenames only, not contents): open the images with fetch_attachment before describing a message that has them. Emails also carry is_draft, and an unsent draft is an outstanding action the user owes someone, so check drafts first when asked what needs a reply or who is chasing.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms." },
        type: { type: "string", description: "Filter by data type: 'email', 'event', 'message', 'page', 'ticket', 'task', 'item'. Omit for all types." },
        source: { type: "string", description: "Filter by source: 'gmail', 'outlook', 'gcal', 'slack', 'notion', 'jira', etc. Omit for all sources." },
        days: { type: "number", description: "How many days back to search. Default 7. Max 365." },
        max_results: { type: "number", description: "Max results. Default 20. Max 100." },
        unread_only: { type: "boolean", description: "Only return unread emails (requires live API check). Default false." },
        has_attachment: { type: "boolean", description: "Only return items with attachments. Default false." },
      },
      required: ["query"],
    },
    activityDescription(input) {
      const t = input.type ? ` ${input.type}s` : " data";
      if (input.query && input.query !== "*") return `Searching${t} for "${input.query.substring(0, 50)}"`;
      return `Searching your${t}`;
    },
  },
  {
    name: "search_calendar",
    core: true,
    groups: ["data"],
    description: "Fetch calendar events across all connected calendars (Google, Outlook, Mac Calendar). Returns merged, deduplicated events sorted by time. Cache-first with live API fallback.",
    input_schema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Start of range. Prefer ISO dates (YYYY-MM-DD). Also accepts \"today\", \"tomorrow\", weekday names, \"next N days/weeks\"." },
        end: { type: "string", description: "End of range, same format. For open-ended questions like \"what's coming up\", use a wide range (14+ days)." },
        query: { type: "string", description: "Filter events by text in title/description." },
      },
      required: ["start", "end"],
    },
    activityDescription(input) {
      const parts = [];
      if (input.start) parts.push(input.start);
      if (input.end && input.end !== input.start) parts.push(input.end);
      const range = parts.length ? `: ${parts.join(" to ")}` : "";
      if (input.query) return `Searching calendar for "${input.query}"${range}`;
      return `Checking your calendar${range}`;
    },
  },
  {
    name: "fetch_attachment",
    core: true,
    groups: ["data"],
    description: "Open an attachment from an email or calendar event. Images come back to YOU to read. Open them by default whenever you are reading, summarising or quoting a message that has them: a filename tells you nothing about what a picture contains, and they drop out of context automatically after a few turns. Say what an image shows, never just its filename. send_to_user also sends it to the user; save_to_drive puts it in their Drive.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Provider: \"gmail\", \"outlook\", \"gcal\", \"outlook_cal\", \"bridge_cal\"." },
        message_id: { type: "string", description: "Message or event ID from search results." },
        attachment_id: { type: "string", description: "Attachment ID from the results." },
        filename: { type: "string", description: "Filename from the results." },
        save_to_drive: { type: "boolean", description: "If true, upload to Google Drive instead of returning it." },
        send_to_user: { type: "boolean", description: "Also send the file to the user in chat. Default false: opening an attachment is for YOU to read it. Only true when the user asked to be sent it." },
      },
      required: ["source", "message_id", "attachment_id", "filename"],
    },
    activityDescription(input) {
      return `Downloading attachment: ${(input.filename || "file").substring(0, 40)}`;
    },
  },
  // --- IMAP mail tools (the zero-project email tier; search handled by data access) ---
  {
    name: "send_mail",
    groups: ["imap_mail"],
    description: "Send a new email through the connected IMAP mailbox. Can attach files the user sent you or that you fetched. To send from a declared alias address, pass from_alias.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated, optional)" },
        from_alias: { type: "string", description: "Optional: send from a declared alias (must be listed in the email connection settings)" },
        attachment_ids: { type: "array", items: { type: "string" }, description: "Optional: attachment_ids of files to attach" },
      },
      required: ["to", "subject", "body"],
    },
    activityDescription(input) { return `Drafting email to ${(input.to || "").substring(0, 30)}`; },
  },
  {
    name: "reply_to_mail",
    groups: ["imap_mail"],
    description: "Reply to an email in the connected IMAP mailbox. Use search_cache first to find the message id; threading headers are taken from the cached original.",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The cached message's id (from search_cache, source 'imap')" },
        body: { type: "string", description: "Reply body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated, optional)" },
        from_alias: { type: "string", description: "Optional: reply from a declared alias" },
        attachment_ids: { type: "array", items: { type: "string" }, description: "Optional: attachment_ids of files to attach" },
      },
      required: ["message_id", "body"],
    },
    activityDescription() { return "Drafting a reply"; },
  },
  {
    name: "create_mail_draft",
    groups: ["imap_mail"],
    description: "Save an email as an unsent draft in the connected IMAP mailbox's Drafts folder, when the user asks for a draft rather than a send. For a reply draft, pass message_id and the threading headers come from the cached original. Nothing is sent.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Draft body (plain text)" },
        to: { type: "string", description: "Recipient (for a new draft; optional for a reply draft)" },
        subject: { type: "string", description: "Subject (for a new draft)" },
        message_id: { type: "string", description: "For a reply draft: the cached message's id being replied to" },
        cc: { type: "string", description: "CC recipients (optional)" },
        from_alias: { type: "string", description: "Optional: draft from a declared alias" },
        attachment_ids: { type: "array", items: { type: "string" }, description: "Optional: attachment_ids of files to attach" },
      },
      required: ["body"],
    },
    activityDescription() { return "Saving a draft"; },
  },
  // --- Google Gmail Tools (send/reply only, search handled by data access) ---
  {
    name: "gmail_send",
    groups: ["gmail"],
    description: "Send a new email via Gmail. Can include file attachments the user sent you or that you fetched from an email.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated, optional)" },
        attachment_ids: { type: "array", items: { type: "string" }, description: "Optional: attachment_ids of files to attach (from a user upload, list_attachments, or fetch_attachment). The original files are attached as-is." },
        account: { type: "string", description: "Optional: which Google account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
      required: ["to", "subject", "body"],
    },
    activityDescription(input) { return `Drafting email to ${(input.to || "").substring(0, 30)}`; },
  },
  {
    name: "gmail_reply",
    groups: ["gmail"],
    description: "Reply to an existing Gmail message. Use search_cache first to find the message ID and thread ID. Can include file attachments the user sent you or that you fetched from an email.",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID to reply to" },
        thread_id: { type: "string", description: "The thread ID of the message" },
        body: { type: "string", description: "Reply body (plain text)" },
        attachment_ids: { type: "array", items: { type: "string" }, description: "Optional: attachment_ids of files to attach (from a user upload, list_attachments, or fetch_attachment). The original files are attached as-is." },
        account: { type: "string", description: "Optional: which Google account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
      required: ["message_id", "thread_id", "body"],
    },
    activityDescription() { return "Drafting a reply"; },
  },
  {
    name: "gmail_create_draft",
    groups: ["gmail"],
    description: "Save an email as an unsent Gmail draft, when the user asks for a draft rather than a send. For a reply, pass message_id and thread_id and the draft is saved into the account that owns that thread, worked out from the cache, so it lands in the right mailbox on its own. For a new email, pass to and subject, and name the account if the user means a non-primary one. Nothing is sent.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Draft body (plain text)" },
        message_id: { type: "string", description: "For a reply draft: the message ID being replied to (from search_cache)" },
        thread_id: { type: "string", description: "For a reply draft: the thread ID of that message" },
        to: { type: "string", description: "For a new (non-reply) draft: recipient email address" },
        subject: { type: "string", description: "For a new (non-reply) draft: subject line" },
        cc: { type: "string", description: "CC recipients (comma-separated, optional)" },
        attachment_ids: { type: "array", items: { type: "string" }, description: "Optional: attachment_ids of files to attach (from a user upload, list_attachments, or fetch_attachment)." },
        account: { type: "string", description: "Which Google account holds the draft (email or fragment). A reply resolves this from the thread automatically; for a new email, omit for the primary account." },
        allow_duplicate: { type: "boolean", description: "Only when the user actually wants a SECOND draft on a thread that already has one, e.g. two versions to choose between. Left off, a thread that already holds an unsent draft is refused and you are given that draft's id to edit with gmail_draft_update instead." },
      },
      required: ["body"],
    },
    activityDescription() { return "Saving a draft"; },
  },
  {
    name: "gmail_draft_update",
    groups: ["gmail"],
    description: "Rewrite the wording of an unsent Gmail draft in place. It edits the existing message, so attachments and inline images stay exactly where they are, which is the whole reason to edit a draft rather than compose a new one. Find it with search_cache (drafts carry is_draft and draft_id) and pass its draft_id, not its message id. body replaces the wording; to, cc and subject only change if you pass them; images are kept unless the user asks for them removed, in which case pass keep_inline_images false. Sending is still gmail_send or gmail_reply.",
    input_schema: {
      type: "object",
      properties: {
        draft_id: { type: "string", description: "The draft_id field on the cached draft from search_cache. NOT its id or external_id, which are the message id and will 404: a Gmail draft has two different identifiers." },
        to: { type: "string", description: "Only if CHANGING the recipient. Omit to keep the one the draft already has." },
        subject: { type: "string", description: "Only if changing the subject. Omit to keep the existing one." },
        body: { type: "string", description: "The new wording, plain text. It replaces the words only: images and attachments already in the draft are kept." },
        keep_inline_images: { type: "boolean", description: "Default true: images already in the draft are kept. Set FALSE when the user asks for the pictures or screenshots taken out, which also removes the underlying attachments rather than leaving them stranded." },
        body_html: { type: "string", description: "Optional HTML version. Omit unless you need specific formatting; without it the plain text is used and any inline images the draft already had are re-attached." },
        cc: { type: "string", description: "Only if changing CC. Omit to keep existing." },
        account: { type: "string", description: "REQUIRED when the draft is not on the primary account: pass the account field from the cached draft. Get this wrong and the edit lands in a different mailbox." },
      },
      required: ["draft_id", "body"],
    },
    activityDescription() { return "Updating a draft"; },
  },
  // --- Outlook (Microsoft 365) send/reply + calendar write ---
  {
    name: "outlook_send",
    groups: ["outlook"],
    description: "Send a new email via Outlook (Microsoft 365).",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated, optional)" },
        account: { type: "string", description: "Optional: which Microsoft account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
      required: ["to", "subject", "body"],
    },
    activityDescription(input) { return `Drafting email to ${(input.to || "").substring(0, 30)}`; },
  },
  {
    name: "outlook_reply",
    groups: ["outlook"],
    description: "Reply to an existing Outlook message. Use search_cache first to find the message ID.",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The Outlook message ID to reply to" },
        body: { type: "string", description: "Reply body (plain text)" },
        account: { type: "string", description: "Optional: which Microsoft account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
      required: ["message_id", "body"],
    },
    activityDescription() { return "Drafting a reply"; },
  },
  {
    name: "outlook_cal_create_event",
    groups: ["outlook"],
    description: "Create a new event on the user's Outlook (Microsoft 365) calendar.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start datetime in ISO format, e.g. '2026-02-25T14:00:00Z'" },
        end: { type: "string", description: "End datetime in ISO format" },
        location: { type: "string", description: "Event location (optional)" },
        body: { type: "string", description: "Event description (optional)" },
      },
      required: ["subject", "start", "end"],
    },
    activityDescription(input) { return `Creating event: ${(input.subject || "").substring(0, 40)}`; },
  },
  {
    name: "outlook_cal_update_event",
    groups: ["outlook"],
    description: "Update an existing Outlook calendar event. Use search_calendar first to find the event ID.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Outlook event ID" },
        subject: { type: "string" },
        start: { type: "string", description: "ISO datetime" },
        end: { type: "string", description: "ISO datetime" },
        location: { type: "string" },
        body: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "outlook_cal_delete_event",
    groups: ["outlook"],
    description: "Delete an Outlook calendar event.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Outlook event ID" },
      },
      required: ["event_id"],
    },
  },
  // --- Google Calendar Tools (create/delete only, list/search handled by Sentinel) ---
  {
    name: "gcal_create_event",
    groups: ["gcal"],
    description: "Create a new Google Calendar event. Supports attaching Drive files.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start datetime, ISO WITH the UTC offset of the timezone the user means, e.g. '2026-02-25T14:00:00+09:00'. A bare time like '2pm' means 2pm where the user currently is, so use their current offset, not UTC." },
        end: { type: "string", description: "End datetime in the same format and timezone as start." },
        description: { type: "string", description: "Event description (optional)" },
        location: { type: "string", description: "Event location (optional)" },
        attendees: { type: "string", description: "Comma-separated email addresses of attendees (optional)" },
        drive_file_id: { type: "string", description: "Google Drive file ID to attach to the event (optional)" },
        account: { type: "string", description: "Optional: which Google account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
      required: ["summary", "start", "end"],
    },
    activityDescription(input) { return `Creating event: ${(input.summary || "").substring(0, 40)}`; },
  },
  {
    name: "gcal_update_event",
    groups: ["gcal"],
    description: "Change an existing Google Calendar event (time, title, location, description, attendees). Use this to CORRECT an event, including one you just created. Never delete and recreate an event to change it. Only the fields you pass are changed. Use search_calendar to find event_id if you don't have it.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The Google Calendar event ID (from create result or search_calendar)" },
        event_name: { type: "string", description: "REQUIRED for display: the event's current title, so the confirmation shows the user which event is changing. Not used for matching." },
        summary: { type: "string", description: "New event title (optional)" },
        start: { type: "string", description: "New start datetime, ISO with the user's UTC offset, e.g. '2026-07-31T13:00:00+09:00' (optional)" },
        end: { type: "string", description: "New end datetime, same format (optional)" },
        description: { type: "string", description: "New description (optional)" },
        location: { type: "string", description: "New location (optional)" },
        account: { type: "string", description: "Optional: which Google account to use (email or fragment). Omit for the primary account." },
      },
      required: ["event_id"],
    },
    activityDescription(input) { return `Updating event: ${(input.summary || "").substring(0, 40) || "details"}`; },
  },
  // --- Google Drive Tools ---
  {
    name: "drive_search",
    groups: ["drive"],
    description: "Search Google Drive for files by name or content, or list files inside a folder. Returns file names, types, links, and IDs. If a result is a folder, you can search again with its ID as folder_id to list its contents. Searches every connected Google account by default; name an account to limit it.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query — matches file names and content. E.g. 'budget 2026', 'gym invoice', 'insurance renewal'. Can be omitted when using folder_id to list folder contents." },
        folder_id: { type: "string", description: "Optional: Google Drive folder ID. When provided, lists files inside this folder instead of searching." },
        max_results: { type: "number", description: "Max files to return (default 10, max 20)" },
        account: { type: "string", description: "Optional: which Google account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
    },
    activityDescription(input) {
      if (input.query) return `Searching Drive for "${input.query.substring(0, 40)}"`;
      if (input.folder_id) return "Listing folder contents";
      return "Searching your Drive";
    },
  },
  {
    name: "drive_list_recent",
    groups: ["drive"],
    description: "List recently modified files in Google Drive. Useful for seeing what's been worked on recently. Covers every connected Google account by default.",
    input_schema: {
      type: "object",
      properties: {
        max_results: { type: "number", description: "Max files to return (default 10, max 20)" },
        account: { type: "string", description: "Optional: which Google account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
    },
    activityDescription() { return "Listing recent Drive files"; },
  },
  {
    name: "drive_read",
    groups: ["drive"],
    description: "Read the text content of a Google Drive file by its ID. Works with Google Docs, Sheets, Slides (exported as text), plain text files, and uploaded Word docs (.docx). For images, PDFs, or other binary files, use drive_send_file instead to send the actual file to the user.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Google Drive file ID from drive_search or drive_list_recent results" },
        account: { type: "string", description: "Optional: which Google account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
      required: ["file_id"],
    },
    activityDescription(input) { return `Reading Drive file: ${(input.file_id || "").substring(0, 20)}`; },
  },
  {
    name: "drive_send_file",
    groups: ["drive"],
    description: "Download a file from Google Drive and send it directly to the user in chat. Works with any file type — images, PDFs, documents, spreadsheets, etc. Use when the user wants to SEE or RECEIVE a file, not just read its text content.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Google Drive file ID from drive_search or drive_list_recent results" },
      },
      required: ["file_id"],
    },
    activityDescription(input) { return `Sending Drive file: ${(input.file_id || "").substring(0, 20)}`; },
  },
  // --- Google Maps Tools ---
  {
    name: "maps_search_places",
    groups: ["maps"],
    description: "Search for places, businesses, restaurants, attractions nearby or in a specific area. Returns names, addresses, ratings, opening hours, and links to open in Google/Apple Maps. Use when the user asks 'what's nearby', 'find me a restaurant', 'where is the nearest X', etc.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, e.g. 'ramen near Shibuya', 'pharmacy near me', 'tennis courts London'" },
        location: { type: "string", description: "Optional: lat,lng to search near, e.g. '51.5074,-0.1278'. Check saved notes for user's location." },
        radius: { type: "number", description: "Search radius in metres (default 5000, max 50000)" },
      },
      required: ["query"],
    },
    activityDescription(input) { return `Searching places: "${(input.query || "").substring(0, 40)}"`; },
  },
  {
    name: "maps_directions",
    groups: ["maps"],
    description: "Get directions between two places. Returns step-by-step route, distance, duration, and a link to open in Google/Apple Maps. Supports driving, walking, transit, and cycling.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Starting point — address, place name, or lat,lng" },
        destination: { type: "string", description: "End point — address, place name, or lat,lng" },
        mode: { type: "string", description: "Travel mode: driving, walking, transit, or bicycling (default: transit)" },
      },
      required: ["origin", "destination"],
    },
    activityDescription(input) { return `Directions: ${(input.origin || "").substring(0, 20)} to ${(input.destination || "").substring(0, 20)}`; },
  },
  {
    name: "maps_geocode",
    groups: ["maps"],
    description: "Convert an address or place name to coordinates (lat/lng), or coordinates to an address. Use when you need coordinates for other tools like weather_lookup, or when the user asks 'where is X'.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address or place name to geocode, e.g. 'AP London office' or '51.5074,-0.1278' for reverse geocode" },
      },
      required: ["address"],
    },
    activityDescription(input) { return `Geocoding: ${(input.address || "").substring(0, 40)}`; },
  },
  // --- Air Quality ---
  {
    name: "air_quality",
    groups: ["weather"],
    description: "Get current air quality for a location. Returns AQI index, pollutant levels, and health recommendations. Uses the user's saved location if no coordinates given — check store.location first.",
    input_schema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude — omit to use saved location" },
        longitude: { type: "number", description: "Longitude — omit to use saved location" },
      },
    },
    activityDescription(input) {
      if (input.latitude && input.longitude) return `Checking air quality at ${input.latitude}, ${input.longitude}`;
      return "Checking air quality";
    },
  },
  // --- Location ---
  {
    name: "send_location",
    groups: ["maps"],
    description:
      "Send a location pin/map to the user in the chat. Use when sharing a specific place or point of interest - the user sees a tappable map preview.",
    input_schema: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
        name: { type: "string", description: "Place name" },
        address: { type: "string", description: "Street address" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "save_location",
    groups: ["maps", "weather", "tfl"],
    description: "Save or update the user's current location. Call this proactively when the user mentions where they are (e.g. 'I'm in Tokyo', 'just landed in Osaka', 'at the office') — geocode the place first with maps_geocode, then save. Also called when user sends a Telegram location pin.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable location name, e.g. 'Tokyo, Japan' or 'AP Office, London'" },
        latitude: { type: "number", description: "Latitude" },
        longitude: { type: "number", description: "Longitude" },
      },
      required: ["name", "latitude", "longitude"],
    },
  },
  // --- TfL Tools ---
  {
    name: "tfl_line_status",
    groups: ["tfl"],
    description: "Get current status of London transport lines (Tube, Overground, Elizabeth line, DLR, Tram). Shows disruptions, delays, and service info. Use when user asks about tube status, delays, or London transport.",
    input_schema: {
      type: "object",
      properties: {
        line: { type: "string", description: "Optional: specific line name e.g. 'jubilee', 'northern', 'elizabeth'. Omit for all lines." },
      },
    },
    activityDescription(input) {
      if (input.line) return `Checking ${input.line} line status`;
      return "Checking TfL line status";
    },
  },
  {
    name: "tfl_journey",
    groups: ["tfl"],
    description: "Plan a journey using London public transport (Tube, bus, rail, walking). Returns route options with times, changes, and line info. Use when user asks how to get somewhere in London.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Starting point — postcode, station name, or lat,lng (e.g. 'SW1A 1AA', 'Victoria', '51.5074,-0.1278')" },
        to: { type: "string", description: "Destination — postcode, station name, or lat,lng" },
        time: { type: "string", description: "Optional: departure time in HHmm format, e.g. '0830'. Defaults to now." },
        date: { type: "string", description: "Optional: date in YYYYMMDD format. Defaults to today." },
      },
      required: ["from", "to"],
    },
    activityDescription(input) { return `TfL journey: ${(input.from || "").substring(0, 20)} to ${(input.to || "").substring(0, 20)}`; },
  },
  {
    name: "tfl_departures",
    groups: ["tfl"],
    description: "Get live departure times from a specific London station. Shows the next trains/buses with destination and minutes until arrival. Use when user asks 'when is the next train from X' or 'next tube from X'. This gives real-time live data, unlike tfl_journey which plans routes.",
    input_schema: {
      type: "object",
      properties: {
        station: { type: "string", description: "Station name, e.g. 'King's Cross', 'Camden Town', 'Victoria'" },
        line: { type: "string", description: "Optional: filter by line, e.g. 'northern', 'victoria', 'jubilee'" },
        direction: { type: "string", description: "Optional: 'inbound' or 'outbound' to filter direction" },
      },
      required: ["station"],
    },
    activityDescription(input) { return `Departures from ${(input.station || "").substring(0, 30)}`; },
  },
  // --- Google Calendar Delete ---
  {
    name: "gcal_delete_event",
    groups: ["gcal"],
    description: "Delete a Google Calendar event by its event ID. Use search_calendar first to find the event ID. Always include event_name so the user can see what's being deleted.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The Google Calendar event ID from list/search results" },
        event_name: { type: "string", description: "Event title for display in confirmation message. Not used for matching — just shown to the user." },
        account: { type: "string", description: "Optional: which Google account to use (email or fragment, e.g. 'work'). Omit for the primary account." },
      },
      required: ["event_id"],
    },
    activityDescription(input) { return `Deleting event: ${(input.event_name || "").substring(0, 40)}`; },
  },
  {
    name: "calendar_delete_event",
    groups: ["calendar"],
    description: "Delete a calendar event from ANY calendar source (Google, Apple Calendar, Outlook). Use search_calendar first to find the event. Provide the event title and date to identify it. Works for Exchange/Apple Calendar events that gcal_delete_event can't reach.",
    input_schema: {
      type: "object",
      properties: {
        event_title: { type: "string", description: "The event title to delete" },
        event_date: { type: "string", description: "The event date/time (e.g. 'Saturday, 11 April 2026 at 12:00:00')" },
        source: { type: "string", description: "Calendar source: 'gcal', 'mac_calendar', 'outlook'. If unknown, omit and the system will try all." },
      },
      required: ["event_title"],
    },
    activityDescription(input) { return `Deleting: ${(input.event_title || "").substring(0, 40)}`; },
  },
  // --- CalDAV calendar (iCloud / Fastmail / Nextcloud via CALDAV_* env; no Google needed) ---
  {
    name: "caldav_list_events",
    groups: ["caldav"],
    description: "List calendar events in a date range from the connected CalDAV calendar (iCloud or another CalDAV server). Use this to answer what's-on-my-calendar questions when Google Calendar is not connected.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Range start, ISO datetime or date (e.g. '2026-08-10' or '2026-08-10T00:00:00+09:00')" },
        to: { type: "string", description: "Range end, same format" },
      },
      required: ["from", "to"],
    },
    activityDescription() { return "Checking the calendar"; },
  },
  {
    name: "caldav_create_event",
    groups: ["caldav"],
    description: "Create an event on the connected CalDAV calendar (iCloud or another CalDAV server).",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start datetime, ISO WITH the UTC offset of the timezone the user means, e.g. '2026-02-25T14:00:00+09:00'. A bare time like '2pm' means 2pm where the user currently is, so use their current offset, not UTC." },
        end: { type: "string", description: "End datetime in the same format and timezone as start." },
        description: { type: "string", description: "Event description (optional)" },
        location: { type: "string", description: "Event location (optional)" },
      },
      required: ["summary", "start", "end"],
    },
    activityDescription(input) { return `Creating event: ${(input.summary || "").substring(0, 40)}`; },
  },
  {
    name: "caldav_update_event",
    groups: ["caldav"],
    description: "Update an event on the connected CalDAV calendar. Use caldav_list_events first to get the event_url.",
    input_schema: {
      type: "object",
      properties: {
        event_url: { type: "string", description: "The event_url from caldav_list_events" },
        summary: { type: "string", description: "New title (optional)" },
        start: { type: "string", description: "New start, ISO with offset (optional)" },
        end: { type: "string", description: "New end, ISO with offset (optional)" },
        description: { type: "string", description: "New description (optional)" },
        location: { type: "string", description: "New location (optional)" },
      },
      required: ["event_url"],
    },
    activityDescription(input) { return `Updating event`; },
  },
  {
    name: "caldav_delete_event",
    groups: ["caldav"],
    description: "Delete an event from the connected CalDAV calendar. Use caldav_list_events first to get the event_url. Always include event_name so the user can see what's being deleted.",
    input_schema: {
      type: "object",
      properties: {
        event_url: { type: "string", description: "The event_url from caldav_list_events" },
        event_name: { type: "string", description: "Event title for display in the confirmation message. Not used for matching." },
      },
      required: ["event_url"],
    },
    activityDescription(input) { return `Deleting event: ${(input.event_name || "").substring(0, 40)}`; },
  },
  // --- Dashboard settings (read/write) ---
  {
    name: "get_settings",
    core: true,
    description: "Get current dashboard settings including pulse config, notification platforms, location, connected services, and all user preferences. Use when you need the latest state or the user asks about their settings.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_settings",
    core: true,
    description: "Change a dashboard setting. Can update pulse level/platforms/quiet hours, location, bot name, or any other user preference. Changes are reflected on the dashboard immediately.",
    input_schema: {
      type: "object",
      properties: {
        pulse_level: { type: "string", description: "off, low, medium, or high" },
        pulse_platforms: { type: "array", items: { type: "string" }, description: "Chat platforms for pulse notifications, e.g. ['whatsapp', 'telegram']" },
        quiet_start: { type: "number", description: "Hour to start quiet period (0-23)" },
        quiet_end: { type: "number", description: "Hour to end quiet period (0-23)" },
        preferred_name: { type: "string", description: "User's preferred display name" },
        bot_name: { type: "string", description: "What the bot is called" },
        llm_provider: { type: "string", description: "LLM provider for bring-your-own-key users: 'anthropic', 'openai', 'gemini' (requires their API key). Unset = ClosedHand's built-in model. Only change if user explicitly asks." },
      },
    },
  },
  // --- Pulse (proactive assistant) ---
  {
    name: "pulse_toggle",
    groups: ["scheduling"],
    description: "Turn Pulse on or off, or change its level. Pulse runs on its own background interval, completely separate from schedules and workers. Do NOT use list_schedules to check pulse status. The current pulse status is in your system prompt under PULSE STATUS. Only call this tool to CHANGE the state.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true to enable, false to disable" },
        interval_minutes: { type: "number", description: "Minutes between checks (default 20, min 10, max 60). Optional." },
        quiet_start: { type: "number", description: "Hour to start quiet period (0-23, default 22 = 10pm). Optional." },
        quiet_end: { type: "number", description: "Hour to end quiet period (0-23, default 7 = 7am). Optional." },
      },
      required: ["enabled"],
    },
    activityDescription(input) { return input.enabled ? "Enabling pulse" : "Disabling pulse"; },
  },
  {
    name: "pulse_check",
    groups: ["scheduling"],
    description: "Run a single Pulse check right now — gathers data from all sources (calendar, email, weather, transport) and reports anything noteworthy. Use for one-off requests like 'check on things for me', 'anything I should know?', 'what's going on?', 'give me an update'. Does NOT change whether Pulse is enabled or disabled.",
    input_schema: { type: "object", properties: {} },
    activityDescription() { return "Running pulse check"; },
  },
  {
    name: "semantic_search",
    groups: ["search"],
    description: "Deep search across ALL connected service data by meaning. Returns results BEYOND what was already auto-surfaced in your context (no duplicates). Call this to get additional relevant emails, calendar events, documents, and service data that didn't make the auto-surfaced top 7. Use freely whenever the user wants detail. Use the service filter for targeted searches (e.g. service='slack').",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        service: { type: "string", description: "Optional: filter to a specific service (email, calendar, slack, notion, etc.)" },
        max_results: { type: "number", description: "Max results to return (default 10)" },
      },
      required: ["query"],
    },
    activityDescription(input) { return `Searching all services for "${(input.query || "").substring(0, 40)}"`; },
  },

  // --- Service connection management ---
  {
    name: "list_connections",
    groups: ["connections"],
    description: "List the user's connected services and available integrations. Use when the user asks about their connections, integrations, linked services, what's set up, what they can connect, etc.",
    input_schema: { type: "object", properties: {} },
    activityDescription() { return "Checking connections"; },
  },
  {
    name: "connect_service",
    groups: ["connections"],
    description: "Generate a one-tap link for the user to connect a new service via OAuth. Use when the user wants to connect, link, hook up, add, or set up any integration (e.g. 'connect Shopify', 'link my Notion', 'add Slack', 'set up Meta Ads', 'I want to use HubSpot'). Map natural language to the correct service key — e.g. 'Facebook ads' or 'Instagram ads' = meta_ads, 'my store' = shopify. For Shopify, you MUST ask for the store domain first (e.g. mystore.myshopify.com) and pass it as store_domain.",
    input_schema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service key to connect (e.g. shopify, meta_ads, slack, notion, github, stripe, hubspot, asana, dropbox, salesforce, mailchimp, spotify, zoom, gitlab)",
        },
        store_domain: {
          type: "string",
          description: "Required for Shopify only — the myshopify.com domain (e.g. mystore.myshopify.com)",
        },
      },
      required: ["service"],
    },
    activityDescription(input) { return `Connecting ${(input.service || "service").replace(/_/g, " ")}`; },
  },
  {
    name: "disconnect_service",
    groups: ["connections"],
    description: "Disconnect a linked service, removing its authorization and access. Use when the user clearly wants to disconnect, remove, unlink, or turn off a service. NEVER call this for ambiguous requests — if unsure whether the user wants to disconnect, ask them to confirm first. Cannot disconnect Google or Microsoft (signup services).",
    input_schema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service key to disconnect (e.g. shopify, meta_ads, slack, notion)",
        },
      },
      required: ["service"],
    },
  },
  // --- General API request tool ---
  {
    name: "api_request",
    core: true,
    groups: ["web"],
    description: "Make an HTTP request to any REST API. Auto-authenticates for connected services (Google, Shopify, Meta, WhatsApp, Slack). Use for any API call not covered by a dedicated tool. Non-GET requests require user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method",
        },
        url: {
          type: "string",
          description: "Full URL to request (e.g. https://graph.facebook.com/v21.0/me)",
        },
        service: {
          type: "string",
          enum: ["google", "shopify", "meta", "whatsapp", "slack", "none"],
          description: "Service to auto-authenticate with. Omit or use 'none' for unauthenticated requests.",
        },
        account: {
          type: "string",
          description: "Google only: which account to authenticate as (email or fragment). Omit for the primary account. A write that belongs to an existing thread or item MUST use the account that owns it (the account field on the cached item), or it lands in the wrong mailbox.",
        },
        body: {
          type: "object",
          description: "JSON request body (for POST/PUT/PATCH)",
        },
        headers: {
          type: "object",
          description: "Additional HTTP headers (key-value pairs)",
        },
      },
      required: ["method", "url"],
    },
    activityDescription(input) {
      let path = "";
      try { path = " " + new URL(input.url).pathname.substring(0, 30); } catch {}
      return `${input.method || "GET"} ${input.service || "api"}:${path}`;
    },
  },

  // --- Flight tracking ---
  {
    name: "list_flights",
    groups: ["travel"],
    description: "List tracked flights detected from email bookings. Shows upcoming flights with live status if within 48 hours of departure.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "flight_scan",
    groups: ["travel"],
    description: "Scan emails for flight bookings and start tracking them. Searches recent booking confirmation emails and extracts flight details.",
    input_schema: {
      type: "object",
      properties: {},
    },
    activityDescription() { return "Scanning emails for flights"; },
  },
  // --- Sandbox (Cloud Workspace) ---
  {
    name: "sandbox_exec",
    groups: ["sandbox"],
    description: "Execute code in the user's persistent cloud workspace. Supports Python, Node.js, and Bash. The workspace persists files between sessions. Use for data analysis, scripts, file processing, calculations, web scraping, or anything that benefits from actual code execution. Output is captured from stdout/stderr.",
    input_schema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "node", "bash"], description: "Programming language to use" },
        code: { type: "string", description: "The code to execute. For Python use print() for output. For Node use console.log(). Working directory is /workspace." },
      },
      required: ["language", "code"],
    },
    activityDescription(input) { return `Running ${input.language || "code"} ${input.language === "bash" ? "command" : "code"}`; },
  },
  {
    name: "sandbox_file_read",
    groups: ["sandbox"],
    description: "Read a file from the user's cloud workspace. Returns the text content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to /workspace, e.g. 'output.csv' or 'scripts/analysis.py'" },
      },
      required: ["path"],
    },
  },
  {
    name: "sandbox_file_write",
    groups: ["sandbox"],
    description: "Write or create a file in the user's cloud workspace. Files persist between sessions.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to /workspace" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "sandbox_file_list",
    groups: ["sandbox"],
    description: "List files in a directory of the user's cloud workspace. Shows file names, sizes, and types.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to /workspace (default: root)" },
      },
    },
  },
  {
    name: "sandbox_file_download",
    groups: ["sandbox"],
    description: "Download a file from the user's cloud workspace and send it to them in chat. Use when the user wants to receive a generated file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to /workspace" },
      },
      required: ["path"],
    },
  },
  {
    name: "sandbox_upload",
    groups: ["sandbox"],
    description: "Upload a previously saved attachment into the user's cloud workspace so it can be processed by code. Use when the user wants to analyse or transform a file they sent earlier.",
    input_schema: {
      type: "object",
      properties: {
        attachment_id: { type: "string", description: "Attachment ID from list_attachments, e.g. 'att_1708612345678'" },
        destination: { type: "string", description: "Destination path in workspace, e.g. 'data/input.csv'. Defaults to original filename." },
      },
      required: ["attachment_id"],
    },
  },
  {
    name: "sandbox_packages",
    groups: ["sandbox"],
    description: "Install packages in the user's cloud workspace. Packages persist between sessions.",
    input_schema: {
      type: "object",
      properties: {
        manager: { type: "string", enum: ["pip", "npm"], description: "Package manager to use" },
        packages: { type: "array", items: { type: "string" }, description: "Package names to install, e.g. ['pandas', 'scikit-learn']" },
      },
      required: ["manager", "packages"],
    },
  },
  {
    name: "sandbox_status",
    groups: ["sandbox"],
    description: "Check the status of the user's cloud workspace. Shows whether it's running, sleeping, disk usage, and installed packages.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "sandbox_gateway",
    groups: ["sandbox"],
    description: "Make an authenticated API call to a connected service through the sandbox gateway. Credentials are injected server-side — the sandbox never sees tokens. Use for API calls that need OAuth (Google, Shopify, Meta, Slack). For unauthenticated public HTTP requests, use service 'none'. Write requests (non-GET, except read-only GraphQL queries) require user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: ["google", "microsoft", "shopify", "meta", "whatsapp", "slack", "none"],
          description: "Service to authenticate with. Use 'none' for unauthenticated public HTTP requests.",
        },
        account: {
          type: "string",
          description: "Optional, google only: which Google account to authenticate as (email or fragment). Omit for the primary account.",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method",
        },
        reason: {
          type: "string",
          description: "One plain-English sentence shown to the user explaining what this request does, e.g. 'Create a 10% discount code called SUMMER10'. Required for write requests.",
        },
        url: {
          type: "string",
          description: "Full API URL to call",
        },
        body: {
          type: "object",
          description: "JSON request body (for POST/PUT/PATCH)",
        },
      },
      required: ["service", "method", "url"],
    },
  },
  {
    name: "sandbox_browse",
    groups: ["sandbox"],
    description: "Drive the cloud computer's browser (Playwright over CDP, attached to the Chrome the user watches). Reads pages and acts on them using the user's own logged-in sessions, so posting a comment or working through a signed-in web app happens here, never on the user's Mac. PREFER batch: one connection for a whole sequence, where separate calls each cost seconds reconnecting. All calls share one tab, so pass url once then act with selectors; passing it again re-navigates and loses your place. A failed click or fill returns the selectors that ARE on the page, so use one of those rather than guessing again.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to open. Omit on follow-up calls to keep working on the page the previous call left behind.",
        },
        action: {
          type: "string",
          enum: ["batch", "screenshot", "scrape_text", "extract_data", "click", "fill", "press", "wait_for", "eval_js"],
          description: "batch runs a whole sequence on one connection and is preferred: separate calls each cost seconds reconnecting, which is what makes long jobs time out. Single actions for when you need to look before deciding: screenshot, scrape_text, extract_data, click, fill, press, wait_for, eval_js.",
        },
        selector: {
          type: "string",
          description: "CSS selector. Targets the element for click/fill/wait_for, and the text to read for scrape_text.",
        },
        text: {
          type: "string",
          description: "For fill: the text to type in.",
        },
        submit: {
          type: "boolean",
          description: "For fill: press Enter afterwards, which is how most comment boxes and search fields send.",
        },
        index: {
          type: "number",
          description: "For click: which match to click when the selector hits several, e.g. the 3rd post in a feed. Default 0.",
        },
        key: {
          type: "string",
          description: "For press: key name, e.g. Enter, Escape, ArrowDown.",
        },
        script: {
          type: "string",
          description: "For eval_js: JavaScript run in the page. Return values that survive JSON, not DOM nodes.",
        },
        steps: {
          type: "array",
          description: "For batch: the sequence to run on one connection, max 20. Each entry is {action, ...that action's params}, e.g. [{\"action\":\"goto\",\"url\":\"...\"},{\"action\":\"fill\",\"selector\":\"textarea\",\"text\":\"hi\",\"submit\":true},{\"action\":\"screenshot\"}]. Stops at the first failed step and returns everything up to it. fill also takes dismiss_popup to press Escape before Enter, for boxes where an autocomplete would swallow it.",
          items: { type: "object" },
        },
        selectors: {
          type: "object",
          description: "For extract_data action: dict mapping field names to CSS selectors, e.g. {\"title\": \"h1\", \"prices\": \".price\"}",
        },
        full_page: {
          type: "boolean",
          description: "For screenshot action: capture full scrollable page (default false)",
        },
        send_to_user: {
          type: "boolean",
          description: "Send the screenshot to the user in chat. Default false: screenshots come back to YOU so you can see the page. Only set true if the user explicitly asked to be shown it.",
        },
      },
      required: ["action"],
    },
  },

  // --- Background Agents ---
  {
    name: "agent_start",
    groups: ["agents"],
    description: "Hand a long job to a background agent. It works on its own and reports back in this chat, while the user keeps talking to you. Use it for anything over a minute or two of tool work rather than making them watch a status line; they can follow it in the Agents tab. Put everything in the goal, including what you already found out, since the agent cannot see this conversation. The goal must stand alone: the agent cannot see this conversation, so never pass the user's message verbatim when it leans on context. 'You should be able to see the schedule now' became an agent hunting land registry schedules when the user meant their dental benefit PDF. Name the object, the account it lives on, and what was already tried.",
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Clear description of what to accomplish" },
        success_criteria: { type: "array", items: { type: "string" }, description: "Optional specific success criteria to verify output quality. Auto-generated if omitted." },
      },
      required: ["goal"],
    },
    activityDescription(input) { return `Starting agent: ${(input.goal || "").substring(0, 40)}`; },
  },
  {
    name: "agent_status",
    groups: ["agents"],
    description: "Check status of running or recent background agents.",
    input_schema: { type: "object", properties: {} },
    activityDescription() { return "Checking agent status"; },
  },
  {
    name: "agent_cancel",
    groups: ["agents"],
    description: "Cancel a running background agent by task ID.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The agent task ID to cancel" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "agent_note",
    groups: ["agents"],
    description: "Pass an instruction to an agent that is ALREADY RUNNING, so it folds the change in mid-run instead of the user waiting for it to finish. Use when the user adds or changes scope while an agent works ('also check X', 'skip the Y part', 'the account is Z not W'). The note reaches the agent at its next step. Only start a new agent for work unrelated to what is running.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "The instruction, self-contained: the agent cannot see this conversation, so name the objects and accounts it needs." },
        task_id: { type: "string", description: "Which running agent. Omit when only one is running." },
      },
      required: ["note"],
    },
    activityDescription() { return "Passing a note to the running agent"; },
  },
  {
    name: "agent_map",
    groups: ["agents"],
    agentOnly: true,
    description: "Fan a set of similar, INDEPENDENT subtasks out as parallel sub-runs, each with its own clean context, instead of grinding them through this one conversation. Use when the same job repeats over several items (per supplier, per document, per account question) and no item needs another's result. Each sub-run gets the prompt with its item filled in, works with the same tools, and returns its findings; you then synthesise the results. Do not use for sequential work or fewer than 2 items.",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "The items to fan over, 2 to 8. Each becomes one sub-run." },
        prompt: { type: "string", description: "The subtask, self-contained, with {item} where each item slots in. Sub-runs cannot see this conversation: include every account name, constraint and fact they need." },
        label: { type: "string", description: "Two or three words naming the batch for progress display, e.g. 'supplier checks'." },
      },
      required: ["items", "prompt"],
    },
    activityDescription(input) { return `Fanning out ${(input.items || []).length} sub-tasks`; },
  },
  {
    name: "agent_report_read",
    groups: ["agents"],
    description: "Read the full stored output of a finished agent run. The report holds detail the chat digest dropped, so check it before re-researching anything a run already covered: reading costs a fraction of redoing. Also the way to fetch the current text before revising with agent_report_update. Without task_id, reads the most recent completed run that produced output.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "A specific run's task ID. Omit for the most recent completed run with output." },
      },
    },
    activityDescription() { return "Reading a finished report"; },
  },
  {
    name: "agent_report_update",
    groups: ["agents"],
    description: "Replace the stored output of a finished agent run with a revised version. When the user asks for changes to a document an agent produced (rewording, corrections, a column added, a section dropped), edit that same document rather than starting a new agent: agent_report_read for the current text, then this with the COMPLETE revised document, since it replaces the whole thing. The dashboard card and its PDF download update immediately and the run is marked edited. A new agent is only for changes that need new research.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The run to update. Omit for the most recent completed run with output." },
        new_content: { type: "string", description: "The complete revised document, markdown as before. It replaces the stored output entirely." },
      },
      required: ["new_content"],
    },
    activityDescription() { return "Revising a finished report"; },
  },
  // --- Automations ---
  {
    name: "automation_run",
    groups: ["automations"],
    description: "Run a saved automation by name, or start a quick one-off task. Use when the user says things like 'run my daily briefing', 'check oil prices', or any task that matches a saved automation name. Also use for one-off tasks like 'research X for me'.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of a saved automation to run (optional if providing prompt for a one-off task)" },
        prompt: { type: "string", description: "One-off task description if not running a saved automation" },
      },
    },
  },
  {
    name: "automation_create",
    groups: ["automations"],
    description: "Create a saved agent that runs on a schedule or when something happens. Use for anything recurring: 'check oil prices every morning', 'summarise my emails every evening', 'alert me when Shopify orders over 500 come in'. This makes exactly what the New Agent form makes, so it shows up in their dashboard and can be paused, edited, given skills and a quality bar. Prefer this over add_schedule whenever the request repeats.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name for the automation (kebab-case, e.g. 'oil-monitor')" },
        description: { type: "string", description: "One-line plain English description" },
        trigger_type: { type: "string", enum: ["manual", "scheduled", "event"], description: "When this automation runs" },
        cron_expression: { type: "string", description: "Cron expression if scheduled (e.g. '0 8 * * *' for daily at 8am)" },
        human_schedule: { type: "string", description: "Human-readable schedule (e.g. 'Every day at 8am')" },
        event_source: { type: "string", description: "Event source if event-triggered (email, shopify, github, etc.)" },
        event_condition: { type: "string", description: "Event condition in plain English" },
        prompt: { type: "string", description: "The detailed task instructions for what this automation does each time it runs" },
        model: { type: "string", enum: ["fast", "balanced", "thorough"], description: "Speed/quality trade-off. Default: balanced." },
        use_cloud: { type: "boolean", description: "Whether this automation needs the Cloud Computer" },
        urgent: { type: "boolean", description: "Whether alerts bypass quiet hours" },
      },
      required: ["name", "prompt"],
    },
    activityDescription(input) { return `Creating automation: ${(input.name || "").substring(0, 30)}`; },
  },
  {
    name: "automation_list",
    groups: ["automations"],
    description: "List the user's saved automations with their status and schedule. Use when asked 'what automations do I have', 'show my automations', etc.",
    input_schema: { type: "object", properties: {} },
    activityDescription() { return "Listing automations"; },
  },
  {
    name: "automation_pause",
    groups: ["automations"],
    description: "Pause a saved automation by name. It will stop running on schedule but can be resumed later.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Name of the automation to pause" } },
      required: ["name"],
    },
  },
  {
    name: "automation_resume",
    groups: ["automations"],
    description: "Resume a paused automation by name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Name of the automation to resume" } },
      required: ["name"],
    },
  },
  // --- Bridge (Mac app) tools (create only, search/read handled by Sentinel) ---
  {
    name: "bridge_calendar_create",
    groups: ["bridge"],
    description: "Create a calendar event on the user's Mac default calendar.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 start time" },
        end: { type: "string", description: "ISO 8601 end time" },
        location: { type: "string" },
        notes: { type: "string" },
      },
      required: ["title", "start", "end"],
    },
    activityDescription(input) { return `Creating event: ${(input.title || "").substring(0, 40)}`; },
  },
  // --- Bridge file system + shell tools ---
  {
    name: "bridge_files_list",
    groups: ["bridge"],
    description: "List files in a directory on the user's Mac. Returns file names, sizes, and modification dates.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list (default ~/Desktop)" },
      },
    },
  },
  {
    name: "bridge_files_read",
    groups: ["bridge"],
    description: "Read a text file from the user's Mac. Returns content with line numbers. Use offset/limit for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file to read" },
        offset: { type: "integer", description: "Start reading from this line number (0-based, default 0)" },
        limit: { type: "integer", description: "Max number of lines to return (default: all)" },
      },
      required: ["path"],
    },
    activityDescription(input) { return `Reading: ${(input.path || "").substring(0, 40)}`; },
  },
  {
    name: "bridge_files_write",
    groups: ["bridge"],
    description: "Write content to a file on the user's Mac. Creates the file if it doesn't exist, overwrites if it does.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file to write" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    activityDescription(input) { return `Writing: ${(input.path || "").substring(0, 40)}`; },
  },
  {
    name: "bridge_files_move",
    groups: ["bridge"],
    description: "Move or rename a file on the user's Mac.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current path of the file" },
        to: { type: "string", description: "New path for the file" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "bridge_files_delete",
    groups: ["bridge"],
    description: "Move a file to Trash on the user's Mac.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to move to Trash" },
      },
      required: ["path"],
    },
  },
  {
    name: "bridge_files_search",
    groups: ["bridge"],
    description: "Search for files by name using Spotlight on the user's Mac. Fast filename search across the whole system or a specific directory.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term to match against file names" },
        path: { type: "string", description: "Optional directory to limit the search to" },
      },
      required: ["query"],
    },
    activityDescription(input) { return `Searching files: "${(input.query || "").substring(0, 30)}"${input.path ? " in " + input.path.substring(0, 20) : ""}`; },
  },
  {
    name: "bridge_files_edit",
    groups: ["bridge"],
    description: "Precise string replacement in a file on the user's Mac. Finds old_string and replaces with new_string. Fails if old_string is not unique (provide more context) unless replace_all is true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        old_string: { type: "string", description: "Exact text to find and replace" },
        new_string: { type: "string", description: "Text to replace it with" },
        replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "bridge_files_grep",
    groups: ["bridge"],
    description: "Search file contents on the user's Mac using regex. Returns matching lines with file paths and line numbers. Uses ripgrep if available.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory to search in (default: current dir)" },
        glob: { type: "string", description: "File pattern filter (e.g. '*.js', '*.py')" },
        context: { type: "integer", description: "Number of context lines before and after each match" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "bridge_files_glob",
    groups: ["bridge"],
    description: "Find files by name pattern on the user's Mac. Returns matching file paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. '*.js', 'config.*')" },
        path: { type: "string", description: "Directory to search in (default: current dir)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "bridge_shell_run",
    groups: ["bridge"],
    description: "Run a shell command on the user's Mac. Returns stdout, stderr, and exit code. Use for any terminal operation not covered by other tools.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
    activityDescription(input) { return `Running: ${(input.command || "").substring(0, 40)}`; },
  },
  // --- Bridge: Browser ---
  {
    name: "bridge_browser_active_tab",
    groups: ["bridge"],
    description: "Get the URL and title of the active browser tab on the user's Mac. Supports Safari and Chrome.",
    input_schema: {
      type: "object",
      properties: {
        browser: { type: "string", description: "Browser to query: 'safari' (default) or 'chrome'" },
      },
    },
  },
  {
    name: "bridge_browser_open_url",
    groups: ["bridge"],
    description: "Open a URL in the user's browser on their Mac. Whichever browser you open it in, pass that same browser to the follow-up tools (page_content, click, type, execute_js), otherwise you will be reading a different browser with a different session and it may look signed out.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open (https only)" },
        browser: { type: "string", description: "Browser to use: 'safari', 'chrome', or omit for default" },
      },
      required: ["url"],
    },
    activityDescription(input) {
      try { return `Opening ${new URL(input.url).hostname}`; } catch { return "Opening a URL"; }
    },
  },
  {
    name: "bridge_browser_page_content",
    groups: ["bridge"],
    description: "Read the text content of the active browser tab on the user's Mac. Returns the visible text of the current page.",
    input_schema: {
      type: "object",
      properties: {
        browser: { type: "string", description: "Browser to act on: 'safari' (default) or 'chrome'. Must match where the page is open, and where the user is signed in." },
      },
    },
    activityDescription() { return "Reading page content"; },
  },
  {
    name: "bridge_browser_list_tabs",
    groups: ["bridge"],
    description: "List all open browser tabs (URL and title) on the user's Mac.",
    input_schema: {
      type: "object",
      properties: {
        browser: { type: "string", description: "Browser to query: 'safari' (default) or 'chrome'" },
      },
    },
  },
  {
    name: "bridge_browser_execute_js",
    groups: ["bridge"],
    description: "Execute JavaScript in the active browser tab on the user's Mac. Full access to the page DOM, can click buttons, fill forms, extract data, interact with any web app the user is logged into. If Chrome cannot run scripts, use bridge_ax_read_ui / bridge_ax_click on the Google Chrome app instead. Never ask the user to change a browser setting.",
    input_schema: {
      type: "object",
      properties: {
        javascript: { type: "string", description: "JavaScript code to execute in the page context" },
        browser: { type: "string", description: "Browser to act on: 'safari' (default) or 'chrome'. Must match where the page is open, and where the user is signed in." },
      },
      required: ["javascript"],
    },
  },
  {
    name: "bridge_browser_click",
    groups: ["bridge"],
    description: "Click an element on the active browser page by CSS selector.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click (e.g. '#submit-btn', '.login-button', 'a[href=\"/settings\"]')" },
        browser: { type: "string", description: "Browser to act on: 'safari' (default) or 'chrome'. Must match where the page is open, and where the user is signed in." },
      },
      required: ["selector"],
    },
  },
  {
    name: "bridge_browser_type",
    groups: ["bridge"],
    description: "Type text into an input field on the active browser page. Can target by CSS selector or type into the currently focused element.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type into the field" },
        selector: { type: "string", description: "CSS selector for the input (optional, uses focused element if omitted)" },
        browser: { type: "string", description: "Browser to act on: 'safari' (default) or 'chrome'. Must match where the page is open, and where the user is signed in." },
      },
      required: ["text"],
    },
  },
  {
    name: "bridge_browser_switch_tab",
    groups: ["bridge"],
    description: "Switch to a specific browser tab by index (1-based).",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Tab number to switch to (1 = first tab)" },
        browser: { type: "string", description: "Browser to act on: 'safari' (default) or 'chrome'. Must match where the page is open, and where the user is signed in." },
      },
      required: ["index"],
    },
  },
  {
    name: "bridge_browser_close_tab",
    groups: ["bridge"],
    description: "Close the current active tab in the user's browser.",
    input_schema: {
      type: "object",
      properties: {
        browser: { type: "string", description: "Browser to act on: 'safari' (default) or 'chrome'. Must match where the page is open, and where the user is signed in." },
      },
    },
  },
  {
    name: "bridge_browser_navigate",
    groups: ["bridge"],
    description: "Navigate the current browser tab to a URL (stays in same tab instead of opening a new one).",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to (https only)" },
        browser: { type: "string", description: "Browser to act on: 'safari' (default) or 'chrome'. Must match where the page is open, and where the user is signed in." },
      },
      required: ["url"],
    },
  },
  // --- Bridge: System ---
  {
    name: "bridge_system_info",
    groups: ["bridge"],
    description: "Get system information from the user's Mac: battery level, disk space, hostname, OS version, uptime.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "bridge_screenshot",
    groups: ["bridge"],
    description: "Take a screenshot of the user's Mac screen. Returns a base64-encoded PNG image.",
    input_schema: {
      type: "object",
      properties: {},
    },
    activityDescription() { return "Taking a screenshot"; },
  },
  {
    name: "bridge_launch_app",
    groups: ["bridge"],
    description: "Launch an application on the user's Mac by name.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Application name (e.g. 'Safari', 'Finder', 'Notes')" },
      },
      required: ["app"],
    },
  },
  {
    name: "bridge_clipboard_read",
    groups: ["bridge"],
    description: "Read the current clipboard contents on the user's Mac.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "bridge_clipboard_write",
    groups: ["bridge"],
    description: "Write text to the clipboard on the user's Mac.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to copy to the clipboard" },
      },
      required: ["text"],
    },
  },
  {
    name: "bridge_keep_awake",
    groups: ["bridge"],
    description: "Toggle the keep-awake setting on the user's Mac to prevent it from sleeping.",
    input_schema: {
      type: "object",
      properties: {
        enable: { type: "boolean", description: "true to keep awake, false to allow sleep" },
      },
      required: ["enable"],
    },
  },
  // --- Bridge: Accessibility (any app) ---
  {
    name: "bridge_ax_list_windows",
    groups: ["bridge"],
    description: "List all open windows across all running apps on the user's Mac. Returns app name, window title, position, and size. Optionally filter by app name.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Filter by app name (optional)" },
      },
    },
  },
  {
    name: "bridge_ax_focus_window",
    groups: ["bridge"],
    description: "Bring an app's window to the front on the user's Mac.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "App name to focus (e.g. 'Safari', 'Finder')" },
        index: { type: "integer", description: "Window index (0-based, default 0)" },
      },
      required: ["app"],
    },
  },
  {
    name: "bridge_ax_read_ui",
    groups: ["bridge"],
    description: "Read the UI element tree of any running app on the user's Mac. Returns buttons, text fields, labels, and other interactive elements. Use this to understand what is on screen in any app.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "App name to read (e.g. 'Maps', 'Finder', 'Photoshop')" },
        depth: { type: "integer", description: "How deep to traverse the UI tree (default 3, max ~6)" },
      },
      required: ["app"],
    },
  },
  {
    name: "bridge_ax_click",
    groups: ["bridge"],
    description: "Click a button or UI element in any running app on the user's Mac, identified by its title or description text. Works invisibly without moving the mouse.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "App name" },
        title: { type: "string", description: "Text label of the element to click" },
        role: { type: "string", description: "UI role (default 'AXButton'). Others: AXMenuItem, AXLink, AXCheckBox, AXPopUpButton" },
        description: { type: "string", description: "Accessibility description of the element (alternative to title)" },
      },
      required: ["app"],
    },
  },
  {
    name: "bridge_ax_set_value",
    groups: ["bridge"],
    description: "Set the value of a text field or other input in any running app on the user's Mac. Works invisibly without taking focus.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "App name" },
        value: { type: "string", description: "Text to set in the field" },
        title: { type: "string", description: "Label of the text field (optional)" },
        role: { type: "string", description: "UI role (default 'AXTextField')" },
      },
      required: ["app", "value"],
    },
  },
  // --- Interactive shell sessions (for CLI tools like claude, python, node) ---
  {
    name: "bridge_session_start",
    groups: ["bridge"],
    description: "Start a persistent interactive shell session. Use for CLI tools that need ongoing conversation (e.g. claude, python, node REPL). The session stays alive between calls so you can have a back-and-forth conversation.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name (e.g. 'claude', 'python'). Used to reference this session later." },
        command: { type: "string", description: "Executable path (default: /bin/zsh). For Claude Code use: /usr/local/bin/claude" },
        args: { type: "array", items: { type: "string" }, description: "Arguments for the command" },
      },
      required: ["name"],
    },
  },
  {
    name: "bridge_session_send",
    groups: ["bridge"],
    description: "Send input to a running interactive session and read the response. Use this to have a conversation with a CLI tool like Claude Code.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        input: { type: "string", description: "Text to send to the session (a newline is added automatically)" },
        wait_ms: { type: "integer", description: "How long to wait for response in milliseconds (default 3000). Use longer for slow commands." },
      },
      required: ["name", "input"],
    },
  },
  {
    name: "bridge_session_read",
    groups: ["bridge"],
    description: "Read pending output from a session without sending anything. Use to check if a long-running command has produced more output.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        wait_ms: { type: "integer", description: "How long to wait for output in milliseconds (default 1000)" },
      },
      required: ["name"],
    },
  },
  {
    name: "bridge_session_end",
    groups: ["bridge"],
    description: "End a persistent shell session.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name to end" },
      },
      required: ["name"],
    },
  },
  {
    name: "bridge_session_list",
    groups: ["bridge"],
    description: "List all active interactive shell sessions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "bridge_session_type_to",
    groups: ["bridge"],
    description: "Type text into an existing terminal or app window. Activates the app, types the text, and optionally presses Enter. Use this to interact with existing Claude Code sessions, Terminal.app, iTerm, or any app with a text input. VISIBLE to user.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "App name to type into (e.g. 'Code' for VS Code, 'Terminal', 'iTerm2')" },
        text: { type: "string", description: "Text to type" },
        press_enter: { type: "boolean", description: "Press Enter after typing (default true)" },
      },
      required: ["app", "text"],
    },
  },
  // --- Raw input control (mouse + keyboard) — last resort, visible to user ---
  {
    name: "bridge_input_mouse_click",
    groups: ["bridge"],
    description: "Click at specific screen coordinates on the user's Mac. VISIBLE to user (physically moves mouse). Use only when Accessibility API methods fail. Requires Unrestricted Mode.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X screen coordinate" },
        y: { type: "number", description: "Y screen coordinate" },
        button: { type: "string", description: "left (default) or right" },
        clicks: { type: "integer", description: "Number of clicks (default 1, use 2 for double-click)" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "bridge_input_mouse_move",
    groups: ["bridge"],
    description: "Move the mouse cursor to specific screen coordinates. VISIBLE to user.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X screen coordinate" },
        y: { type: "number", description: "Y screen coordinate" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "bridge_input_mouse_drag",
    groups: ["bridge"],
    description: "Click and drag from one screen position to another. VISIBLE to user.",
    input_schema: {
      type: "object",
      properties: {
        from_x: { type: "number" }, from_y: { type: "number" },
        to_x: { type: "number" }, to_y: { type: "number" },
      },
      required: ["from_x", "from_y", "to_x", "to_y"],
    },
  },
  {
    name: "bridge_input_key_type",
    groups: ["bridge"],
    description: "Type text using the keyboard. VISIBLE to user (characters appear in focused app). Use for typing into apps where ax.set_value doesn't work.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
      },
      required: ["text"],
    },
  },
  {
    name: "bridge_input_key_press",
    groups: ["bridge"],
    description: "Press a single key with optional modifiers (e.g. Return, Tab, Escape, arrow keys).",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name: return, tab, escape, space, delete, up, down, left, right, f1-f12, a-z, 0-9" },
        modifiers: { type: "array", items: { type: "string" }, description: "Modifier keys: cmd, shift, alt, ctrl" },
      },
      required: ["key"],
    },
  },
  {
    name: "bridge_input_key_combo",
    groups: ["bridge"],
    description: "Press a keyboard shortcut (e.g. cmd+c, cmd+shift+a). VISIBLE to user.",
    input_schema: {
      type: "object",
      properties: {
        combo: { type: "string", description: "Key combo like 'cmd+c', 'cmd+shift+a', 'ctrl+alt+delete'" },
      },
      required: ["combo"],
    },
  },
  {
    name: "bridge_input_scroll",
    groups: ["bridge"],
    description: "Scroll the screen. VISIBLE to user.",
    input_schema: {
      type: "object",
      properties: {
        dy: { type: "integer", description: "Vertical scroll (negative = scroll down, positive = scroll up)" },
        dx: { type: "integer", description: "Horizontal scroll" },
      },
    },
  },
  // --- Deferred MCP tool loading ---
  {
    name: "get_tool_details",
    core: true,
    description: "Get the full parameter schema for a tool before calling it. Use this when you want to call a tool listed under ADDITIONAL TOOLS or MCP TOOLS. Returns the full schema so you can call the tool on your next turn.",
    input_schema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "The exact name of the tool to get details for" },
      },
      required: ["tool_name"],
    },
  },
  // --- Team tools ---
  // === DATASETS (structured data for automations + conversation) ===
  {
    name: "dataset_create",
    groups: ["datasets"],
    description: "Create a named dataset (like a spreadsheet table). Define columns with names and types. Use for tracking ad campaigns, content calendars, task lists, or any structured data that persists across conversations and automation runs.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Dataset name (unique per user). e.g. 'Ad Campaign Q2', 'Content Calendar'" },
        columns: {
          type: "array",
          description: "Column definitions. Each column has a name and optional type (text/number/date/boolean/status). Default type is text.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["text", "number", "date", "boolean", "status"] },
            },
            required: ["name"],
          },
        },
        description: { type: "string", description: "What this dataset is for" },
      },
      required: ["name", "columns"],
    },
    activityDescription(input) { return `Creating dataset "${input.name}"`; },
  },
  {
    name: "dataset_add_rows",
    groups: ["datasets"],
    description: "Add one or more rows to an existing dataset. Each row is an object with column names as keys.",
    input_schema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name" },
        rows: {
          type: "array",
          description: "Array of row objects. Keys must match column names.",
          items: { type: "object" },
        },
      },
      required: ["dataset", "rows"],
    },
    activityDescription(input) { return `Adding ${input.rows?.length || 0} rows to "${input.dataset}"`; },
  },
  {
    name: "dataset_query",
    groups: ["datasets"],
    description: "Query rows from a dataset. Optionally filter by column values. Returns matching rows.",
    input_schema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name" },
        filter: {
          type: "object",
          description: "Filter conditions as { column_name: value }. Only returns rows where all conditions match.",
        },
        limit: { type: "number", description: "Max rows to return (default 50)" },
        order_by: { type: "string", description: "Column name to sort by" },
        order_dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default asc)" },
      },
      required: ["dataset"],
    },
    activityDescription(input) { return `Querying "${input.dataset}"`; },
  },
  {
    name: "dataset_update_rows",
    groups: ["datasets"],
    description: "Update rows in a dataset that match a filter. Sets the specified columns to new values.",
    input_schema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name" },
        filter: { type: "object", description: "Filter to find rows to update, e.g. { status: 'approved', id: '...' }" },
        set: { type: "object", description: "Column values to update, e.g. { status: 'posted', posted_date: '2026-04-07' }" },
      },
      required: ["dataset", "filter", "set"],
    },
    activityDescription(input) { return `Updating rows in "${input.dataset}"`; },
  },
  {
    name: "dataset_delete_rows",
    groups: ["datasets"],
    description: "Delete rows from a dataset that match a filter.",
    input_schema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name" },
        filter: { type: "object", description: "Filter to find rows to delete" },
      },
      required: ["dataset", "filter"],
    },
    activityDescription(input) { return `Deleting rows from "${input.dataset}"`; },
  },
  {
    name: "dataset_list",
    groups: ["datasets"],
    description: "List all datasets for the current user with their column schemas and row counts.",
    input_schema: { type: "object", properties: {} },
    activityDescription() { return "Listing datasets"; },
  },
  {
    name: "dataset_delete",
    groups: ["datasets"],
    description: "Delete an entire dataset and all its rows.",
    input_schema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name to delete" },
      },
      required: ["dataset"],
    },
    activityDescription(input) { return `Deleting dataset "${input.dataset}"`; },
  },
  {
    name: "rag_retrieve",
    groups: ["rag"],
    description: "Retrieve and send an original file the user indexed into File Search on their Cloud Computer or Local Computer. Finds it by meaning (vector search) or exact path, then sends the actual file. For Google Drive files, prefer drive_search then drive_read or drive_send_file: those hit Drive live and cover every account, whereas this only reaches what File Search has already indexed. Use this tool for the Computer sources that drive_search cannot see.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to find the file" },
        file_path: { type: "string", description: "Exact file path if known from RAG context" },
        origin: { type: "string", enum: ["cloud", "bridge"], description: "Where the file lives" },
      },
    },
    activityDescription(input) { return "Retrieving file from library"; },
  },
];

module.exports = { INTERNAL_TOOLS };
