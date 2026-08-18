// lib/onboarding.js — Conversational onboarding state machine + platform welcome + feedback

const ctx = require("./context");
const { saveStore } = require("./storage");
const { getConversation } = require("./conversation");
const { sendTyping, sendText, sendToPlatform } = require("./messaging");
const { isGoogleConnected, googleApiRequest } = require("./services/google");
const { isShopifyConnected } = require("./services/shopify");
const { isSlackConnected } = require("./services/slack-api");
const { supabase, UserStore } = require("../user-store");
const { swapToCloudStore, cleanupUserContext } = require("./storage");
const { scanEmailsForFlights } = require("./flights");
const { startFlightCheckForUser } = require("./flights-scheduler");
const { MODEL_MAP, getInternalClient } = require("./llm");

// Everything onboarding learns is written straight to the facts table rather
// than through pin_fact, so nothing used to mirror it into data_vectors. That
// left every new install with an assistant that knew things its own Context
// Brain could not show and passive recall could not reach. Built lazily
// because the embedder pulls in the provider config.
let _fv = null;
function _factVectors() {
  if (!_fv) {
    const { factVectors } = require("./services/fact-vectors");
    _fv = factVectors({
      supabase,
      embed: (text) => require("./services/usi").embedDocument(text),
    });
  }
  return _fv;
}

// For the interactive steps, where waiting on an embed would show up as a
// pause before the next thing ClosedHand says.
function _mirrorInBackground(userId, key, value) {
  _factVectors().mirrorFact(userId, key, value)
    .catch(e => console.log(`[Onboarding] "${key}" saved but not mirrored to Context Brain: ${e.message}`));
}

const WELCOME_MESSAGE = `Hey. I'm ClosedHand.

The world is changing fast. Most people are sleepwalking into a future where a handful of companies know everything about them. I'm built to be the opposite of that.

I'm your personal AI assistant, and I live in your chat - Telegram, WhatsApp, Discord, wherever you are. Same conversation, any device. No app to download.

Connect your email, calendar, files, notes, music, payments, and more - 50+ services built in, with unlimited more through a verified library of safe extensions. The more you connect, the better I get.

I don't just wait around. I keep an eye on your inbox, calendar, and schedule, and if something needs your attention, I'll tell you. Not spam. Just the things that matter.

I can work in the background too. Research, draft, schedule, coordinate - like a team of agents running in parallel, all from one conversation. No extra hardware, no setup.

Your data is yours. You can view everything I hold about you and wipe it at any moment. Go quiet long enough, I'll wipe it myself. Conversations are encrypted. Nothing is sold or shared. ClosedHand is purpose-driven - a portion of all revenue goes to Privacy International.

Tap below to connect your first account.

Tip: send /new to start a fresh conversation anytime, or /threads to jump back into a previous one.

Spot something broken or odd? Send /bug and what happened.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSettings() {
  return ctx.activeUserStore?.profile?.settings || {};
}

async function saveProfileSetting(key, value) {
  const currentSettings = ctx.activeUserStore?.profile?.settings || {};
  const newSettings = { ...currentSettings, [key]: value };
  ctx.activeUserStore.profile.settings = newSettings;
  await supabase
    .from("profiles")
    .update({ settings: newSettings, updated_at: new Date().toISOString() })
    .eq("id", ctx.activeUserStore.userId);
}

async function updateOnboardingStep(step) {
  await saveProfileSetting("onboarding_step", step);
}

function markOnboarded() {
  ctx.store.facts["_onboarded"] = new Date().toISOString();
  saveStore();
}

// ---------------------------------------------------------------------------
// Background scan — silent email/calendar fetch + Claude note extraction
// ---------------------------------------------------------------------------

function startBackgroundScan(userId) {
  // Fire-and-forget — don't block onboarding conversation
  (async () => {
    try {
      if (!isGoogleConnected()) return;

      // Fetch emails (last 30, headers + snippets)
      let emails = [];
      try {
        const listData = await googleApiRequest("GET",
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30`
        );
        if (listData.messages) {
          for (const msg of listData.messages.slice(0, 30)) {
            try {
              const detail = await googleApiRequest("GET",
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`
              );
              const headers = detail.payload?.headers || [];
              const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
              emails.push({
                subject: getHeader("Subject"),
                from: getHeader("From"),
                to: getHeader("To"),
                date: getHeader("Date"),
                snippet: detail.snippet,
              });
            } catch (e) { /* skip individual failures */ }
          }
        }
      } catch (e) {
        console.log(`Background scan email fetch failed: ${e.message}`);
      }

      // Fetch calendar events (next 14 days)
      let events = [];
      try {
        const now = new Date().toISOString();
        const twoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        const calData = await googleApiRequest("GET",
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(twoWeeks)}&maxResults=30&singleEvents=true&orderBy=startTime`
        );
        events = (calData.items || []).map((e) => ({
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          location: e.location || null,
          attendees: (e.attendees || []).map((a) => a.email).slice(0, 5),
        }));
      } catch (e) {
        console.log(`Background scan calendar fetch failed: ${e.message}`);
      }

      if (emails.length === 0 && events.length === 0) {
        console.log(`Background scan for ${userId}: no data found`);
        return;
      }

      // Claude extraction — notes only, no welcome message
      const scanPrompt = `You are an AI assistant performing a background scan for a new user. Analyse the following email and calendar data and extract key facts about this person. Be concise and specific.

From the data, identify:
- Their full name (from email signatures or From fields)
- Job title and company (from signatures, email domains, calendar events)
- Key contacts they interact with frequently
- Upcoming commitments in the next 2 weeks
- Current projects or topics they're working on
- Location/timezone clues
- Any patterns you notice

EMAILS (${emails.length}):
${JSON.stringify(emails, null, 1)}

CALENDAR (${events.length} events):
${JSON.stringify(events, null, 1)}

Respond ONLY with notes. Each line should be KEY: VALUE format. Use descriptive keys like "profile-name", "profile-job-title", "profile-company", "contact-frequent-1", "upcoming-key-event-1", "project-current-1", "profile-location". Include 8-15 notes covering the most important facts.`;

      const { client: scanClient, model: scanModel } = getInternalClient(userId);
      const response = await scanClient.messages.create({
        model: scanModel,
        max_tokens: 1000,
        messages: [{ role: "user", content: scanPrompt }],
      });

      const scanResult = response.content[0]?.text || "";

      // Parse notes — need to reload the user store since this runs async
      const userStore = await UserStore.load(userId);
      const noteLines = scanResult.split("\n").filter((l) => l.match(/^[a-z][\w-]+:/i));
      const scanned = [];
      for (const line of noteLines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.substring(0, colonIdx).trim().toLowerCase().replace(/\s+/g, "-");
          const value = line.substring(colonIdx + 1).trim();
          if (key && value) {
            userStore.notes[key] = value;
            scanned.push([key, value]);
          }
        }
      }
      userStore.markDirty("notes");
      await userStore.save();

      // These are the first things ClosedHand knows about the user, and they
      // are written straight to the facts table rather than through pin_fact,
      // so nothing had mirrored them into data_vectors. The assistant knew
      // them from the prompt while Context Brain showed an empty half and
      // passive recall could not reach them, on every new install, in the
      // first hour. Failures are reported, never fatal: the facts are saved.
      const mirror = await _factVectors().mirrorFacts(userId, scanned);
      if (mirror.failed.length > 0) {
        console.log(`[Onboarding] ${mirror.failed.length} of ${scanned.length} scanned facts are not in Context Brain yet (${mirror.failed[0].reason}); they are saved and will mirror when next edited.`);
      }

      console.log(`Background scan complete for ${userId}: ${noteLines.length} notes saved, ${mirror.mirrored} mirrored to Context Brain`);

      // Also scan for flight bookings
      try {
        const newFlights = await scanEmailsForFlights(userId);
        if (newFlights.length > 0) {
          console.log(`Background scan found ${newFlights.length} flights for ${userId}`);
          startFlightCheckForUser(userId);

          // Send a proactive follow-up about detected flights
          try {
            const { data: chatLinks } = await supabase
              .from("chat_links")
              .select("platform, platform_user_id")
              .eq("user_id", userId)
              .not("platform_user_id", "is", null);

            if (chatLinks?.length) {
              const flightList = newFlights.map(f => {
                const dep = f.departure?.airport || "?";
                const arr = f.arrival?.airport || "?";
                const depDate = new Date(f.departure?.dateTime);
                const dateStr = depDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
                return `${f.flightNumber} (${dep} to ${arr}) on ${dateStr}`;
              }).join("\n");

              const msg = `By the way, I found ${newFlights.length === 1 ? "a flight" : `${newFlights.length} flights`} in your email:\n\n${flightList}\n\nI'll track ${newFlights.length === 1 ? "it" : "them"} automatically and let you know about any gate changes, delays, or updates.`;

              const WEBAPP_URL = process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000";
              for (const link of chatLinks) {
                try {
                  if (link.platform === "telegram" && ctx.bot) {
                    await ctx.bot.sendMessage(link.platform_user_id, msg, {
                      reply_markup: { inline_keyboard: [[
                        { text: "View flights", web_app: { url: `${WEBAPP_URL}/dashboard#schedules` } }
                      ]] }
                    });
                  } else {
                    await sendToPlatform(link.platform, link.platform_user_id, msg);
                  }
                } catch {}
              }
            }
          } catch (notifyErr) {
            console.error(`Flight notification error for ${userId}: ${notifyErr.message}`);
          }
        }
      } catch (flightErr) {
        console.error(`Background flight scan error for ${userId}: ${flightErr.message}`);
      }
    } catch (e) {
      console.error(`Background scan error for ${userId}: ${e.message}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// Onboarding state machine
// ---------------------------------------------------------------------------

async function handleOnboardingMessage(userId, chatId, text) {
  const conversation = getConversation(userId);
  const settings = getSettings();
  const step = settings.onboarding_step || null;

  // Detect user's first name from profile for initial greeting
  const rawProfileName = ctx.activeUserStore?.profile?.display_name
    || ctx.activeUserStore?.profile?.name
    || null;
  const profileName = rawProfileName ? rawProfileName.trim().split(/\s+/)[0] : null;

  switch (step) {
    case null:
    case undefined: {
      // First message — kick off background scan + ask for bot name
      startBackgroundScan(userId);

      const greeting = profileName
        ? `Hey ${profileName}. ClosedHand here. What would you like to call me?`
        : `Hey there. ClosedHand here. What would you like to call me?`;

      conversation.push({ role: "user", content: text });
      conversation.push({ role: "assistant", content: greeting });
      await updateOnboardingStep("name_bot");
      saveStore();
      sendText(chatId, greeting);
      return;
    }

    case "name_bot": {
      // User gave a bot name
      const botName = text.trim().split(/\s+/).slice(0, 3).join(" "); // Cap at 3 words
      await saveProfileSetting("bot_name", botName);

      const nameConfirm = profileName
        ? `${botName}. I like it. And you're ${profileName}, right?`
        : `${botName}. I like it. And what should I call you?`;

      conversation.push({ role: "user", content: text });
      conversation.push({ role: "assistant", content: nameConfirm });
      await updateOnboardingStep("greet_user");
      saveStore();
      sendText(chatId, nameConfirm);
      return;
    }

    case "greet_user": {
      // User confirmed/gave their name
      const lower = text.trim().toLowerCase();
      let preferredName;

      if (profileName && (lower === "yes" || lower === "yeah" || lower === "yep" || lower === "yea" || lower === "that's right" || lower === "correct" || lower === "ye")) {
        preferredName = profileName;
      } else {
        // Strip filler words like "just", "call me", "it's", "i'm" etc. to extract the actual name
        let cleaned = text.trim()
          .replace(/^(just|call me|it's|i'm|i am|my name is|my name's|go by|they call me|you can call me)\s+/i, "")
          .replace(/\s+(is fine|is ok|is good|is cool|works|please|thanks|will do|for short).*$/i, "")
          .trim();
        preferredName = (cleaned || text.trim()).split(/\s+/).slice(0, 3).join(" ");
      }

      await saveProfileSetting("preferred_name", preferredName);
      ctx.store.facts["profile-name"] = preferredName;
      // Not awaited: this is mid-conversation and an embed round trip would be
      // added to the user's wait for the very next line.
      _mirrorInBackground(userId, "profile-name", preferredName);

      conversation.push({ role: "user", content: text });

      const locationAsk = `Nice one, ${preferredName}. And where are you based?`;
      conversation.push({ role: "assistant", content: locationAsk });
      await updateOnboardingStep("ask_location");
      saveStore();
      sendText(chatId, locationAsk);
      return;
    }

    case "ask_location": {
      conversation.push({ role: "user", content: text });

      const skipPhrases = ["skip", "nowhere", "nah", "pass", "rather not", "no", "n/a", "na"];
      const isSkip = skipPhrases.some(p => text.trim().toLowerCase() === p) || text.trim().length < 2;

      if (!isSkip) {
        try {
          const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text.trim())}&format=json&limit=1`;
          const geoRes = await fetch(geoUrl, {
            headers: { "User-Agent": "ClosedHand/1.0 (contact@closedhand.ai)" },
          });
          const geoData = await geoRes.json();

          if (geoData && geoData.length > 0) {
            const place = geoData[0];
            const locationObj = {
              name: place.display_name.split(",")[0].trim(),
              latitude: parseFloat(place.lat),
              longitude: parseFloat(place.lon),
              updated: new Date().toISOString(),
            };
            ctx.store.location = locationObj;
            ctx.store.facts["profile-location"] = locationObj.name;
            _mirrorInBackground(userId, "profile-location", locationObj.name);
            await saveProfileSetting("location", locationObj);
          }
        } catch (e) {
          console.log(`Onboarding geocode failed: ${e.message}`);
          // Not critical, just move on
        }
      }

      const signOff = generateOnboardingSignOff(userId, chatId);
      conversation.push({ role: "assistant", content: signOff });
      markOnboarded();
      await saveProfileSetting("onboarding_step", "done");
      saveStore();
      sendText(chatId, signOff);
      return;
    }

    default: {
      // Shouldn't happen, but recover gracefully — treat as complete
      markOnboarded();
      await saveProfileSetting("onboarding_step", "done");
      saveStore();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Sign-off — clean, hardcoded message in the bot's voice
// ---------------------------------------------------------------------------

function generateOnboardingSignOff(userId, chatId) {
  const settings = getSettings();
  const preferredName = settings.preferred_name || "mate";

  // Check what the background scan found
  const noteKeys = Object.keys(ctx.store.facts);
  const hasNotes = noteKeys.some(k => !k.startsWith("_"));
  const flightKeys = noteKeys.filter(k => k.startsWith("flight-"));
  const hasFlights = flightKeys.length > 0;

  if (hasNotes) {
    let msg = `Right, ${preferredName}. I've already got some context from your connected services, so I'm not starting from zero.`;

    if (hasFlights) {
      msg += `\n\nI've spotted ${flightKeys.length === 1 ? "a flight" : "some flights"} in your email. I'll track ${flightKeys.length === 1 ? "it" : "them"} and let you know if anything changes with gates, delays, or timing.`;
    }

    msg += `\n\nIf you ever want to see everything I'm keeping track of, flights, schedules, reminders, it's all in your dashboard.`;

    msg += `\n\nWhen you see a thinking emoji, that's me working on something - hang tight and I'll get back to you.`;

    msg += `\n\nYour messages and data are encrypted, stay on your server, can't be read by anyone (including us), never used for training, and you can wipe everything whenever you want. Just ask me stuff. I'm here.`;
    return msg;
  }

  return `Right, ${preferredName}. If you connect your email and calendar from your dashboard, I'll actually be useful straight away. Daily briefings, flight tracking, reminders, keeping track of things for you.

When you see a thinking emoji, that's me working on something - hang tight and I'll get back to you.

Your messages and data are encrypted, stay on your server, can't be read by anyone (including us), never used for training, and you can wipe everything whenever you want.

Just ask me stuff. I'm here.`;
}

// ---------------------------------------------------------------------------
// Platform welcome (existing users adding a new platform)
// ---------------------------------------------------------------------------

async function generatePlatformWelcome(userId, chatId, platform) {
  try {
    const userStore = await UserStore.load(userId);
    swapToCloudStore(userStore, userId, chatId);

    const notes = ctx.store.facts || {};
    const conversation = getConversation(userId);
    const isExistingUser = !!notes["_onboarded"];
    const settings = userStore.profile?.settings || {};
    const botName = settings.bot_name || "ClosedHand";

    if (!isExistingUser) {
      return "Account linked! You're all set. Say hello and I'll get to know you.";
    }

    const notesSummary = Object.entries(notes)
      .filter(([k]) => !k.startsWith("_"))
      .slice(0, 15)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const recentMessages = conversation.slice(-6)
      .map(m => `${m.role}: ${typeof m.content === "string" ? m.content.substring(0, 150) : "[media]"}`)
      .join("\n");

    const connectedServices = [];
    if (isGoogleConnected()) connectedServices.push("Gmail", "Calendar", "Drive");
    if (isShopifyConnected()) connectedServices.push("Shopify");
    if (isSlackConnected()) connectedServices.push("Slack");

    const welcomePrompt = `You are ${botName}, a personal AI assistant. The user just connected you on ${platform} — they already use you on another chat platform and are now adding ${platform} too. Their conversation history carries across all platforms.

What you know about them:
${notesSummary || "No notes saved yet."}

Recent conversation:
${recentMessages || "No recent messages."}

Connected services: ${connectedServices.join(", ") || "None yet"}

Write a short welcome message (2-3 sentences) for this ${platform} connection. Be warm and familiar — you know this person. Reference something specific you know about them (a name, a recent topic, an upcoming event). Make it clear their conversation continues seamlessly here. Don't be cheesy or over-the-top. No bullet points, no emojis.`;

    const { client: internalClient, model: internalModel } = getInternalClient(userId);
    const response = await internalClient.messages.create({
      model: internalModel,
      max_tokens: 200,
      messages: [{ role: "user", content: welcomePrompt }],
    });

    const welcome = response.content[0]?.text?.trim();
    if (welcome) return welcome;
  } catch (e) {
    console.error(`Platform welcome error: ${e.message}`);
  } finally {
    cleanupUserContext();
  }

  return "Account linked! Your conversation carries over from your other platforms - pick up right where you left off.";
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------


module.exports = { WELCOME_MESSAGE, handleOnboardingMessage, generatePlatformWelcome };
