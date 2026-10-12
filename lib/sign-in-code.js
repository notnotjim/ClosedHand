// Sends the code for the second step of signing in through the personal URL
// (webapp/sign-in-code.js makes and checks it). Every chat app linked to the
// person gets it, whatever their update settings: a sign-in can't wait for a
// digest or a chosen channel. With no chat that takes it, it goes to their
// own inbox from Closedhand's email address, when that is turned on. The
// code itself is never logged.

// Every chat app the bot can message (lib/messaging.js sendToPlatform). A
// WhatsApp linked as a device on the person's own number is "whatsapp_linked";
// leaving it out once sent the code only to Telegram.
const NAMES = { telegram: "Telegram", whatsapp: "WhatsApp", whatsapp_linked: "WhatsApp", discord: "Discord", slack: "Slack", line: "LINE" };

function codeText(code, from) {
  return `Your Closedhand sign-in code is ${code}. It works once, for 10 minutes.\n\n`
    + `If you didn't just sign in, someone has your dashboard password${from ? ` (the attempt came from ${from})` : ""}. `
    + "Change it on the computer running Closedhand.";
}

// Where the code went, as the sign-in page names it: "your Telegram", "your
// email". Empty when nothing could take it.
async function deliver(userId, code, from, deps = {}) {
  const db = deps.db || require("./db").supabase;
  const sendToPlatform = deps.sendToPlatform || require("./messaging").sendToPlatform;
  const text = codeText(code, from);
  const { data: links, error } = await db.from("chat_links").select("platform, platform_user_id").eq("user_id", userId);
  if (error) throw new Error(`chat links unavailable (${error.message})`);
  const sent = new Set();
  for (const link of links || []) {
    const name = NAMES[link.platform];
    if (!name || sent.has(name)) continue;
    try {
      await sendToPlatform(link.platform, link.platform_user_id, text);
      sent.add(name);
    } catch (e) {
      console.log(`[sign-in] code not delivered by ${name}: ${e.message}`);
    }
  }
  if (sent.size) return [...sent].map((name) => `your ${name}`);
  const sendToOwner = deps.sendToOwner || require("./assistant-email").sendToOwner;
  try {
    await sendToOwner(userId, "Your Closedhand sign-in code", text, { sealed: true });
    return ["your email"];
  } catch (e) {
    console.log(`[sign-in] code not delivered by email: ${e.message}`);
    return [];
  }
}

// POST /internal/sign-in-code on the bot, for the webapp: { code, from }.
function register(app, deps = {}) {
  const verifyToken = deps.verifyToken || require("./web-chat-ws").verifyToken;
  app.post("/internal/sign-in-code", async (req, res) => {
    const userId = verifyToken(req.get("x-closedhand-token"));
    if (!userId) return res.status(401).json({ error: "Not allowed" });
    const code = String((req.body || {}).code || "");
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "No code to send." });
    try {
      const sentTo = await deliver(userId, code, String((req.body || {}).from || "").slice(0, 60), deps);
      if (!sentTo.length) {
        return res.status(409).json({ error: "Closedhand has no chat app or email to send a sign-in code to. Sign in on the computer running Closedhand, at http://localhost:3000, and link Telegram or WhatsApp." });
      }
      console.log(`[sign-in] code sent to ${sentTo.join(" and ")}`);
      res.json({ sentTo });
    } catch (e) {
      console.error(`[sign-in] code not sent: ${e.message}`);
      res.status(503).json({ error: "Closedhand couldn't send your sign-in code just now. Try again in a minute." });
    }
  });
}

module.exports = { register, deliver, codeText };
