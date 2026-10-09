const { responseText } = require("./model-wire");
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
// pause before the next thing Closedhand says.
function _mirrorInBackground(userId, key, value) {
  _factVectors().mirrorFact(userId, key, value)
    .catch(e => console.log(`[Onboarding] "${key}" saved but not mirrored to Context Brain: ${e.message}`));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSettings() {
  return ctx.activeUserStore?.profile?.settings || {};
}

async function saveProfileSetting(key, value) {
  await require("./profile-settings").updateSettings(ctx.activeUserStore.userId, (s) => { s[key] = value; }, { store: ctx.activeUserStore });
}

// A name the setup scan guessed that the one the person chose contradicts
// goes, with its copy in recall (lib/name-guess.js).
async function correctNameGuess(userId, chosen, store = ctx.activeUserStore) {
  try {
    const { supabase } = require("./db");
    await require("./name-guess").correct({ db: supabase, userId, chosen, store, removeVector: (u, k) => _factVectors().removeFactVector(u, k) });
  } catch (e) {
    console.error("[Onboarding] name guess correction:", e.message);
  }
}

async function updateOnboardingStep(step) {
  await saveProfileSetting("onboarding_step", step);
}

// A greeting, a question or a sentence is not an answer to "what should I
// call you". Without this, "Hi" became the bot's name and "Why did you say
// that?" became the user's, and the rest of onboarding ran on nonsense.
const GREETING = /^(hi|hello|hey|hiya|yo|sup|howdy|hi there|hey there|hello there|good (morning|afternoon|evening))[\s.!?,]*$/i;
function isNotAnAnswer(text) {
  const t = String(text || "").trim();
  return !t || GREETING.test(t) || /\?\s*$/.test(t) || t.split(/\s+/).length > 4;
}

// "Sam. And btw, can you find that story about..." is an answer and a
// question in one message. The answer is the short fragment before the first
// full stop, comma or "and"; the rest is kept and answered once onboarding
// is done, so neither half is lost. A message that does not split like that
// comes back whole.
function splitLeadingAnswer(text) {
  const t = String(text || "").trim();
  const m = t.match(/^([^.,!?\n]{1,40}?)\s*(?:[.,!]|\n|\s+(?:and|btw|also)\b)\s*([\s\S]+)$/i);
  if (!m) return { answer: t, rest: null };
  const answer = m[1].trim(), rest = m[2].trim();
  if (!answer || answer.split(/\s+/).length > 3 || GREETING.test(answer)) return { answer: t, rest: null };
  if (rest.split(/\s+/).length < 4) return { answer: t, rest: null };
  return { answer, rest };
}

// Keep the request that started onboarding, plus any later questions. A
// greeting or platform /start command is not work to resume. Store a string
// so requests saved by older versions remain compatible.
async function rememberPending(text) {
  const request = String(text || "").trim();
  if (!request || GREETING.test(request) || /^\/start(?:@\w+)?$/i.test(request)) return;
  const pending = getSettings().onboarding_pending;
  if (pending === request) return;
  await saveProfileSetting("onboarding_pending", pending ? `${pending}\n\n${request}` : request);
}

// Resume in the same chat and platform context after the introductions.
async function answerPending(userId, chatId) {
  const pending = getSettings().onboarding_pending;
  if (!pending) return;
  try {
    const { queuedAsk } = require("./engine");
    const response = await queuedAsk(userId, pending, null, chatId);
    if (response) await sendText(chatId, response);
  } catch (e) {
    console.error(`[Onboarding] earlier request failed: ${e.message}`);
    await sendText(chatId, "I couldn't finish replying to your earlier request. Please send it again.");
    return;
  }
  // Do not silently discard a request when the engine or delivery fails.
  await saveProfileSetting("onboarding_pending", null);
}

function markOnboarded() {
  ctx.store.facts["_onboarded"] = new Date().toISOString();
  saveStore();
}

// ---------------------------------------------------------------------------
// Background scan — silent email/calendar fetch + Claude note extraction
// ---------------------------------------------------------------------------

// The readable text of a Gmail message: its plain part, wherever it sits.
function plainText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf8");
  for (const part of payload.parts || []) { const t = plainText(part); if (t) return t; }
  return "";
}

function firstName(v) {
  return v ? String(v).trim().split(/\s+/)[0] : null;
}

// Runs once per install. Returns the promise so a caller with nothing else
// to do (the watcher below) can hold the context open until it finishes; the
// conversational caller just lets it run.
function startBackgroundScan(userId) {
  return (async () => {
    try {
      if (!isGoogleConnected()) return;
      if (getSettings().onboarding_scan) return;

      const t0 = Date.now();
      const since = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
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
      console.log(`[Onboarding] scan: ${emails.length} emails fetched (${since()})`);

      // How they sign their own mail is the best evidence of what they are
      // called: an account name or an address can be a nickname or a formal
      // name nobody uses. Only the opening and closing lines are kept.
      const sent = [];
      try {
        const list = await googleApiRequest("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:sent&maxResults=8");
        for (const msg of (list.messages || []).slice(0, 8)) {
          try {
            const detail = await googleApiRequest("GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`);
            const own = plainText(detail.payload).split(/\n(?:On .{0,200}wrote:|-{2,} ?Original Message|>)/)[0].trim();
            if (own) sent.push({ opening: own.slice(0, 120), closing: own.slice(-200) });
          } catch (_) { /* skip one */ }
        }
      } catch (e) {
        console.log(`Background scan sent-mail fetch failed: ${e.message}`);
      }

      // Fetch calendar events (next 14 days)
      let events = [];
      try {
        const now = new Date().toISOString();
        const twoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        const calData = await googleApiRequest("GET",
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(twoWeeks)}&maxResults=30&singleEvents=true&orderBy=startTime`
        );
        // The calendar's own timezone comes with its events: where they set
        // their life's clock, a good first guess at where they are (asked,
        // never assumed). Reading the calendar itself would need a calendar
        // permission Closedhand does not ask for.
        if (typeof calData?.timeZone === "string" && calData.timeZone) await saveProfileSetting("calendar_timezone", calData.timeZone);
        events = (calData.items || []).map((e) => ({
          summary: e.summary,
          // All-day events by their last day: Google's end is the day after.
          ...require("./calendar-dates").googleEventTimes(e),
          location: e.location || null,
          attendees: (e.attendees || []).map((a) => a.email).slice(0, 5),
        }));
      } catch (e) {
        console.log(`Background scan calendar fetch failed: ${e.message}`);
      }
      console.log(`[Onboarding] scan: ${events.length} events fetched (${since()})`);

      if (emails.length === 0 && events.length === 0 && sent.length === 0) {
        console.log(`Background scan for ${userId}: no data found`);
        await saveProfileSetting("onboarding_scan", new Date().toISOString());
        return;
      }

      // Claude extraction — notes only, no welcome message
      const scanPrompt = `You are an AI assistant performing a background scan for a new user. Analyse the following email and calendar data and extract key facts about this person. Be concise and specific. ${require("./time-context").currentTimeContext(ctx.activeUserStore).text}

Only what can be read, never guessed. From signatures, From fields and the account itself, give:
- profile-name: the name they go by, as they sign their own sent mail and as people greet them
- profile-name-certainty: certain only if their own sent mail signs off with that name, or people writing to them personally greet them by it; likely otherwise. Automated mail (shops, services, newsletters) greets people by whatever their address or a sign-up form suggests, so it never makes a name certain.
- profile-email: their main address
- profile-company: the company or business they clearly work for or run, if signatures or their own domain make it certain
- personal-plan: one personal plan the calendar or mail plainly shows, under way today or still to come (a trip, a booking, a personal event), as a short phrase starting "your", e.g. "your trip to Lisbon on 12 October" or "your stay in Da Nang until 7 October". Write places as they are usually written in English (Da Nang, not Đà Nẵng). An all-day event's end is its last day. Never work, admin, bills, health, money or relationships. Leave it out if there is none.
- personal-plan-when: now if that plan is already under way today, soon if it is still to come.

SENT BY THEM (opening and closing lines, ${sent.length}):
${JSON.stringify(sent, null, 1)}

EMAILS (${emails.length}):
${JSON.stringify(emails, null, 1)}

CALENDAR (${events.length} events):
${JSON.stringify(events, null, 1)}

Respond ONLY with lines in KEY: VALUE format using exactly those keys. Leave out any key you are not certain of. No patterns, guesses about jobs, locations, timezones, contacts or events: recall already holds the mail itself.`;

      const { client: scanClient, model: scanModel } = getInternalClient(userId);
      if (!scanClient) throw new Error("no model available for the scan");
      // A model call with no ceiling can hang the whole scan; two minutes is
      // generous for a thousand tokens.
      const response = await Promise.race([
        scanClient.messages.create({
          model: scanModel,
          max_tokens: 1000,
          messages: [{ role: "user", content: scanPrompt }],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("model call timed out after 120s")), 120000)),
      ]);
      console.log(`[Onboarding] scan: model replied (${since()})`);

      const scanResult = responseText(response) || "";

      // Parse notes — need to reload the user store since this runs async
      const userStore = await UserStore.load(userId);
      console.log(`[Onboarding] scan: store reloaded (${since()})`);
      const noteLines = scanResult.split("\n").filter((l) => l.match(/^[a-z][\w-]+:/i));
      const scanned = [];
      const ALLOWED = new Set(["profile-name", "profile-email", "profile-company"]);
      const scanNow = new Date().toISOString();
      for (const line of noteLines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.substring(0, colonIdx).trim().toLowerCase().replace(/\s+/g, "-");
          const value = line.substring(colonIdx + 1).trim();
          // Two readings for first contact only, kept as settings, not facts.
          if (key === "profile-name-certainty" && /^(certain|likely)$/i.test(value)) { await saveProfileSetting("name_certainty", value.toLowerCase()); continue; }
          if (key === "personal-plan" && /^your\s/i.test(value) && value.length <= 80) { await saveProfileSetting("welcome_highlight", value.replace(/[.\s]+$/, "")); continue; }
          if (key === "personal-plan-when" && /^(now|soon)$/i.test(value)) { await saveProfileSetting("welcome_highlight_when", value.toLowerCase()); continue; }
          // The scan reads; it does not guess. Anything beyond these three is
          // an inference about the person's life from their inbox, and it was
          // sitting in every prompt with the standing of a fact.
          if (!ALLOWED.has(key) || !value) continue;
          const name = key === "profile-name" ? value : (userStore.notes["profile-name"]?.value || userStore.notes["profile-name"] || null);
          userStore.notes[key] = { value, created: scanNow, lastAccessed: scanNow, accessCount: 0, category: "profile", subject: name || "the user", source: "setup scan" };
          scanned.push([key, value]);
        }
      }
      userStore.markDirty("facts"); // "notes" is only an alias for reading; the save writes "facts"
      await userStore.save();
      console.log(`[Onboarding] scan: ${scanned.length} notes saved (${since()})`);
      // The person may have said their name while the scan ran; a guess
      // that contradicts it goes (lib/name-guess.js).
      const chosen = (await require("./db").supabase.from("profiles").select("settings").eq("id", userId).maybeSingle()).data?.settings?.preferred_name;
      if (chosen) await correctNameGuess(userId, chosen, userStore);

      // These are the first things Closedhand knows about the user, and they
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
      // Recorded only once the notes are saved, so a scan that dies part way
      // (a timeout, a provider hiccup) is tried again on the next boot.
      await saveProfileSetting("onboarding_scan", new Date().toISOString());

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

              // The personal URL, which Telegram can open; a local address it
              // cannot, and a button pointing at one made the send fail.
              const schedulesUrl = await require("./dashboard-links").dashboardUrl("telegram", "schedules").catch(() => null);
              for (const link of chatLinks) {
                try {
                  if (link.platform === "telegram" && ctx.bot) {
                    await ctx.bot.sendMessage(link.platform_user_id, msg, schedulesUrl ? {
                      reply_markup: { inline_keyboard: [[
                        { text: "View flights", web_app: { url: schedulesUrl } }
                      ]] }
                    } : undefined);
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

// One sentence that proves the scan happened: something specific from the
// inbox or calendar, in Closedhand's own voice. Empty when there is nothing
// to say yet, so the opener stays clean rather than bluffing.
// Self-host: Google is connected on the setup page before any chat app, so
// nothing would trigger the scan until the first message. This watches for
// the connection and runs the scan then, so the opener already has something
// to say. Stops itself once the scan has run.
function watchForFirstGoogle() {
  let timer = null;
  const tick = async () => {
    try {
      const { data } = await supabase.from("connections").select("user_id").eq("service", "google").limit(1);
      const row = data?.[0];
      if (!row) return;
      const { data: prof } = await supabase.from("profiles").select("settings").eq("id", row.user_id).single();
      if (prof?.settings?.onboarding_scan) { clearInterval(timer); return; }
      clearInterval(timer);
      // Its own context bubble, not the per-user message queue: the queue
      // has a timeout sized for a chat turn, and a thirty-mail scan with a
      // model call at the end outlives it.
      await ctx.runWithInheritedContext(async () => {
        try {
          const userStore = await UserStore.load(row.user_id);
          swapToCloudStore(userStore, row.user_id, null);
          console.log(`[Onboarding] Google connected; reading the inbox and calendar for ${row.user_id}`);
          await startBackgroundScan(row.user_id);
        } finally {
          cleanupUserContext();
        }
      });
    } catch (_) { /* next tick */ }
  };
  timer = setInterval(tick, 30000);
  tick();
}

// ---------------------------------------------------------------------------
// First contact: names first, the way meeting someone starts
// ---------------------------------------------------------------------------

function factValue(v) { return v && typeof v === "object" ? v.value : v; }
function sameName(a, b) { return !!a && !!b && a.toLowerCase() === b.toLowerCase(); }

// What the person is called, from every source that says: the name the inbox
// scan read from their own mail, the chat app's profile name, and the Google
// or Microsoft account. Certain when the scan found it signed and greeted and
// nothing else names them differently, or when two of these agree; otherwise
// the likeliest one, to be checked.
function knownName(settings, platformName) {
  const scanned = firstName(factValue(ctx.store.facts["profile-name"]));
  const chat = firstName(platformName);
  const account = firstName(ctx.activeUserStore?.profile?.display_name || ctx.activeUserStore?.profile?.name);
  const differing = [account, chat].find((other) => other && scanned && !sameName(other, scanned));
  if (scanned && settings.name_certainty === "certain" && !differing) return { name: scanned, certain: true };
  for (const [a, b] of [[scanned, chat], [scanned, account], [chat, account]]) {
    if (sameName(a, b)) return { name: a, certain: true };
  }
  return { name: scanned || chat || account || null, certain: false };
}

function opener(known) {
  if (known.certain) return `Hey ${known.name}! Before we start, what would you like to call me?`;
  if (known.name) return `Hey! Is it ${known.name}? And what would you like to call me?`;
  return "Hey! Before anything else, what should I call you, and what would you like to call me?";
}

function cleanName(v, words = 3) {
  const t = String(v || "").replace(/^(just|call me|it's|i'm|i am|my name is|my name's|you can call me)\s+/i, "")
    .replace(/[.!,]+$/, "").trim();
  return t ? t.split(/\s+/).slice(0, words).join(" ") : null;
}

// The reply, read by the model, so "Sam, and call yourself Max", "Max. I'm
// Sam" and "yes, Max" all land, and anything else in it is kept for after.
// With no model to hand, a short word answers whichever name is missing.
async function readNames(userId, text, known, need) {
  const t = String(text || "").trim();
  try {
    const { client, model } = getInternalClient(userId);
    if (client) {
      const prompt = `A personal assistant meeting a new user asked: ${JSON.stringify(need.asked)}
Their reply: ${JSON.stringify(t)}
Return JSON only: {"user_name": string or null, "guess_confirmed": true, false or null, "bot_name": string or null, "other": string or null}
- user_name: what the user says they are called, without filler like "call me". null if they don't say.
- guess_confirmed: ${known.name && !known.certain ? `true if they agree they are ${known.name}, false if they say they are not, otherwise null` : "null"}.
- bot_name: the name they give the assistant, at most three words. null if they don't give one.
- other: any question or request in the reply that is not about names, word for word, or null.`;
      const res = await Promise.race([
        client.messages.create({ model, max_tokens: 120, messages: [{ role: "user", content: prompt }] }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 20000)),
      ]);
      const json = JSON.parse(((responseText(res) || "").match(/\{[\s\S]*\}/) || ["{}"])[0]);
      return { user: cleanName(json.user_name, 2), confirmed: typeof json.guess_confirmed === "boolean" ? json.guess_confirmed : null,
        bot: cleanName(json.bot_name), other: json.other ? String(json.other).trim() : null };
    }
  } catch (_) { /* fall through to the plain reading */ }
  const split = splitLeadingAnswer(t);
  split.answer = split.answer.replace(/^(no|nope|nah)[,!.\s]+/i, "");
  if (isNotAnAnswer(split.answer)) return { user: null, confirmed: null, bot: null, other: t || null };
  if (/^(yes|yeah|yep|yea|ye|correct|that's right|that's me)\b/i.test(split.answer)) return { user: null, confirmed: true, bot: null, other: split.rest };
  const word = cleanName(split.answer);
  return need.bot ? { user: null, confirmed: null, bot: word, other: split.rest } : { user: cleanName(word, 2), confirmed: null, bot: null, other: split.rest };
}

// Short, in the assistant's own voice, and personal only when the scan found
// a plan of theirs worth a mention (a trip, an event), never work or admin.
// A plan already under way is not "coming up": they are in the middle of it.
function closingLine(ack, highlight, when) {
  const mention = !highlight ? "" : when === "now"
    ? ` I see you're in the middle of ${highlight}, so I'll keep an eye on that.`
    : ` Looks like ${highlight} is coming up, so I'll keep an eye on that.`;
  const first = ack + mention;
  return first + "\n\nAsk me anything, or send me something to remember.";
}

// Where the person probably is, and what gives it away: a stay booked over
// today, their calendar's own timezone, their phone number's country. Each is
// a guess to put to them, never something to assume.
const DIAL = { "44": "the UK", "1": "North America", "61": "Australia", "64": "New Zealand", "353": "Ireland", "33": "France",
  "49": "Germany", "34": "Spain", "39": "Italy", "31": "the Netherlands", "81": "Japan", "82": "South Korea", "84": "Vietnam",
  "65": "Singapore", "66": "Thailand", "91": "India", "971": "the UAE", "27": "South Africa", "55": "Brazil", "52": "Mexico" };
function cityOf(location) {
  const parts = String(location || "").split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 2] : parts[0] || null;
}
async function placeClues(userId, chatId) {
  const clues = [];
  try {
    const now = Date.now();
    const stay = (await require("./bookings").listUpcoming(userId, { days: 1 }))
      .find((b) => b.kind === "hotel" && b.location && Date.parse(b.starts_at) <= now);
    const city = stay && cityOf(stay.location);
    if (city) clues.push({ place: city, why: "the stay you've got booked there", current: true });
  } catch (_) { /* no bookings to go on */ }
  const tz = getSettings().calendar_timezone;
  if (tz && tz.includes("/")) {
    const city = tz.split("/").pop().replace(/_/g, " ");
    if (!clues.some((c) => c.place === city)) clues.push({ place: city, why: `your calendar running on ${city} time` });
  }
  const digits = /@s\.whatsapp\.net$/.test(String(chatId || "")) ? String(chatId).split("@")[0].split(":")[0] : "";
  const code = ["971", "353", "44", "61", "64", "33", "49", "34", "39", "31", "81", "82", "84", "65", "66", "91", "27", "55", "52", "1"].find((c) => digits.startsWith(c));
  if (code) clues.push({ place: DIAL[code], why: `your number being from ${DIAL[code]}`, weak: true });
  return clues.slice(0, 3);
}

// The question, written by the model from the clues so it can be playful
// and notice when they disagree (a phone number from one country, a clock
// set to another); a plain
// template when there is no model.
async function placeQuestion(userId, clues) {
  if (!clues.length) return "And where are you these days? A city's plenty, so I get your timezone right.";
  try {
    const { client, model } = getInternalClient(userId);
    if (client) {
      const prompt = `You are a personal assistant getting to know someone. Ask where they are now, in one or two short sentences (under 30 words), warm and a little playful. Make your best guess from these clues and say what gave it away; if clues disagree, notice it lightly. Ask whether that is where they are, or if they have moved on. No emdashes. No mention of data, scanning or evidence.
Clues: ${clues.map((c) => `${c.place} (${c.why}${c.current ? ", covers today" : ""}${c.weak ? ", weak" : ""})`).join("; ")}`;
      const res = await Promise.race([client.messages.create({ model, max_tokens: 90, messages: [{ role: "user", content: prompt }] }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 20000))]);
      const line = (responseText(res) || "").trim().replace(/\s+/g, " ");
      if (line && line.length < 220 && !line.includes("\u2014")) return line;
    }
  } catch (_) { /* the template below */ }
  const c = clues.find((x) => !x.weak) || clues[0];
  return c.current ? `Still in ${c.place}, or have you moved on?` : `Is ${c.place} where you are at the moment?`;
}

async function readPlace(userId, text, clues) {
  const t = String(text || "").trim();
  try {
    const { client, model } = getInternalClient(userId);
    if (client) {
      const prompt = `A personal assistant asked a user where they are${clues[0] ? `, guessing ${clues[0].place}` : ""}. Their reply: ${JSON.stringify(t)}
Return JSON only: {"place": string or null, "agrees": true, false or null, "wants_guess": true or false, "skip": true or false, "other": string or null}
- place: the town, city or country they say they are in now, or null.
- agrees: true if they confirm the guess, false if they say it is wrong, otherwise null.
- wants_guess: true if they ask the assistant to guess ("guess", "you tell me").
- skip: true if they would rather not say.
- other: any question or request in the reply not about where they are, word for word, or null.`;
      const res = await Promise.race([client.messages.create({ model, max_tokens: 100, messages: [{ role: "user", content: prompt }] }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 20000))]);
      const json = JSON.parse(((responseText(res) || "").match(/\{[\s\S]*\}/) || ["{}"])[0]);
      return { place: json.place ? String(json.place).trim().slice(0, 60) : null, agrees: typeof json.agrees === "boolean" ? json.agrees : null,
        wantsGuess: json.wants_guess === true, skip: json.skip === true, other: json.other ? String(json.other).trim() : null };
    }
  } catch (_) { /* the plain reading below */ }
  if (/^(guess|you (tell me|guess)|go on,? guess|have a guess)\b/i.test(t)) return { place: null, agrees: null, wantsGuess: true, skip: false, other: null };
  if (/^(yes|yeah|yep|yea|ye|correct|that's right|still here|still there)\b/i.test(t)) return { place: null, agrees: true, wantsGuess: false, skip: false, other: null };
  if (/^(skip|pass|rather not|no thanks|nah|n\/a)\b/i.test(t) || t.length < 2) return { place: null, agrees: null, wantsGuess: false, skip: true, other: null };
  if (/\?\s*$/.test(t)) return { place: null, agrees: null, wantsGuess: false, skip: true, other: t };
  return { place: t.replace(/^(i'm in|im in|in|based in|living in)\s+/i, "").slice(0, 60), agrees: null, wantsGuess: false, skip: false, other: null };
}

// A place name to coordinates and its timezone, so reminders land at the
// right hour. Null when it can't be found.
async function locate(place) {
  try {
    // In English: OpenStreetMap otherwise names a place in its own language.
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1&accept-language=en`,
      { headers: { "User-Agent": "ClosedHand/1.0 (https://closedhand.com)" } });
    const hit = (await res.json())[0];
    if (!hit) return null;
    const latitude = parseFloat(hit.lat), longitude = parseFloat(hit.lon);
    const timezone = await require("./timezone").fetchTimezoneFor(latitude, longitude);
    return { name: hit.display_name.split(",")[0].trim(), latitude, longitude, ...(timezone ? { timezone } : {}), updated: new Date().toISOString() };
  } catch (_) { return null; }
}

// A chat app linked after introductions (they happen once, wherever came
// first): a short "same me, here too", never the questions again.
function hereTooLine(app) {
  const s = getSettings();
  return `Hey${s.preferred_name ? " " + s.preferred_name : ""}, it's ${s.bot_name || "Closedhand"}, here on ${app} too. Same conversation as everywhere else, so carry on wherever suits.`;
}

async function finishIntroductions(userId, chatId, conversation, ack) {
  const settings = getSettings();
  const line = closingLine(ack || `Nice to meet you, ${settings.preferred_name || "there"}.`, settings.welcome_highlight || null, settings.welcome_highlight_when || null);
  conversation.push({ role: "assistant", content: line });
  // Which messages were introductions, so "pick up where you left off" never
  // offers a chat that was only hello and names.
  await saveProfileSetting("intro", { thread: ctx.activeThreadId || ctx.activeUserStore?.activeThreadId || null, messages: conversation.length });
  await saveProfileSetting("onboarding_step", "done");
  markOnboarded();
  saveStore();
  await sendText(chatId, line);
  await answerPending(userId, chatId);
}

async function handleOnboardingMessage(userId, chatId, text, { platformName = null } = {}) {
  const conversation = getConversation(userId);
  const settings = getSettings();
  // Earlier versions asked one thing at a time; a person part way through
  // those carries on here.
  const step = { name_bot: "names", greet_user: "names" }[settings.onboarding_step] || settings.onboarding_step || null;
  const known = knownName(settings, platformName);

  if (!step) {
    await rememberPending(text);
    startBackgroundScan(userId);
    // A name the evidence agrees on is simply used.
    if (known.certain) await saveProfileSetting("preferred_name", known.name);
    const line = opener(known);
    // text is null when Closedhand opens the conversation itself.
    if (text) conversation.push({ role: "user", content: text });
    conversation.push({ role: "assistant", content: line });
    await updateOnboardingStep("names");
    saveStore();
    await sendText(chatId, line);
    return;
  }

  if (step === "ask_location") {
    if (text) conversation.push({ role: "user", content: text });
    await finishIntroductions(userId, chatId, conversation);
    return;
  }

  if (step === "place") {
    conversation.push({ role: "user", content: text });
    const clues = Array.isArray(settings.onboarding_clues) ? settings.onboarding_clues : [];
    const got = await readPlace(userId, text, clues);
    if (got.other) await rememberPending(got.other);
    // "Guess", "you tell me": it does, and says what gave it away.
    if (got.wantsGuess) {
      const line = clues.length ? `My money's on ${clues[0].place}, going by ${clues[0].why}. Close?` : "Nothing to go on yet, so you'll have to tell me. Where are you?";
      conversation.push({ role: "assistant", content: line });
      saveStore();
      await sendText(chatId, line);
      return;
    }
    const place = got.place || (got.agrees === true && clues[0] ? clues[0].place : null);
    let ack = "No problem, tell me any time.";
    if (place) {
      const loc = await locate(place);
      if (loc) {
        ctx.store.location = loc;
        ctx.store.facts["profile-location"] = loc.name;
        _mirrorInBackground(userId, "profile-location", loc.name);
        await saveProfileSetting("location", loc);
        ack = loc.timezone ? `Got it, ${loc.name}. I'll keep your reminders on ${loc.name} time.` : `Got it, ${loc.name}.`;
      } else ack = `Got it, ${place}.`;
    }
    await finishIntroductions(userId, chatId, conversation, ack);
    return;
  }

  if (step === "names") {
    conversation.push({ role: "user", content: text });
    const have = { user: settings.preferred_name || null, bot: settings.bot_name || null };
    const asked = settings.onboarding_asked || opener(known);
    const got = await readNames(userId, text, known, { asked, bot: !have.bot });
    if (got.other) await rememberPending(got.other);
    if (got.bot && !have.bot) {
      await saveProfileSetting("bot_name", got.bot);
      have.bot = got.bot;
      require("./telegram-name").showName(got.bot);
    }
    const user = got.user || (got.confirmed === true && known.name) || null;
    if (user && !have.user) {
      await saveProfileSetting("preferred_name", user);
      await correctNameGuess(userId, user);
      ctx.store.facts["profile-name"] = user;
      // Not awaited: an embed round trip would sit in front of the next line.
      _mirrorInBackground(userId, "profile-name", user);
      have.user = user;
    }
    if (have.user && have.bot) {
      const clues = await placeClues(userId, chatId);
      const line = `Nice to meet you, ${have.user}. ${have.bot} it is. ` + await placeQuestion(userId, clues);
      await saveProfileSetting("onboarding_clues", clues);
      conversation.push({ role: "assistant", content: line });
      await updateOnboardingStep("place");
      saveStore();
      await sendText(chatId, line);
      return;
    }
    // Ask only for what is still missing.
    const again = !have.user && !have.bot ? (known.name && !known.certain && got.confirmed !== false ? `Is it ${known.name}? And what would you like to call me?` : "What should I call you, and what would you like to call me?")
      : !have.user ? (known.name && got.confirmed === null ? `And is it ${known.name}?` : "And what should I call you?")
      : "And what would you like to call me?";
    await saveProfileSetting("onboarding_asked", again);
    conversation.push({ role: "assistant", content: again });
    saveStore();
    await sendText(chatId, again);
    return;
  }

  if (step === "done") { if (!ctx.store.facts["_onboarded"]) markOnboarded(); return; }
  // Shouldn't happen, but recover gracefully: treat as complete.
  await saveProfileSetting("onboarding_step", "done");
  markOnboarded();
  saveStore();
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
    const botName = settings.bot_name || "Closedhand";

    if (!isExistingUser) {
      return `${platform} linked! You're all set. Say hello and I'll get to know you.`;
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

    const welcomePrompt = `You are ${botName}, a personal AI assistant. The user just connected you on ${platform}. They already use you on another chat app and are now adding ${platform} too. Their conversation history carries across all their chat apps and the web chat.

What you know about them:
${notesSummary || "No notes saved yet."}

Recent conversation:
${recentMessages || "No recent messages."}

Connected services: ${connectedServices.join(", ") || "None yet"}

Write a short welcome message (2-3 sentences) for this ${platform} connection. Be warm and familiar: you know this person. Reference something specific you know about them (a name, a recent topic, an upcoming event). Make it clear their conversation continues seamlessly here. Don't be cheesy or over-the-top. No bullet points, no emojis.`;

    const { client: internalClient, model: internalModel } = getInternalClient(userId);
    const response = await internalClient.messages.create({
      model: internalModel,
      max_tokens: 200,
      messages: [{ role: "user", content: welcomePrompt }],
    });

    const welcome = responseText(response)?.trim();
    if (welcome) return welcome;
  } catch (e) {
    console.error(`Platform welcome error: ${e.message}`);
  } finally {
    cleanupUserContext();
  }

  return `${platform} linked! Your conversation carries over from your other chat apps and the web chat, so pick up right where you left off.`;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------


module.exports = { handleOnboardingMessage, hereTooLine, generatePlatformWelcome, startBackgroundScan, watchForFirstGoogle };
