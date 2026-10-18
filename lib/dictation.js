// lib/dictation.js: the web chat's mic. The browser records and sends 16 kHz
// mono WAV through the webapp (POST /api/dictation, webapp/public/dictation.js),
// and it is written out here by the same built-in speech to text as a voice
// note from a chat app (lib/voice.js). The browser's own dictation was used
// before: it sent the voice to Apple or Google, and Firefox had none.

// About four minutes of 16 kHz mono WAV; the browser stops at two.
const LIMIT = "8mb";
// After a tap on the mic the model stays loaded this long, since one message
// spoken is often followed by another.
const KEEP_MS = 5 * 60000;
// The speech to text's own errors are written for people; anything else is
// a fault worth logging, not showing.
const SAYABLE = /busy|missing|too long|can't be written out/i;

// POST /internal/dictation/warm when the mic is tapped, so the model loads
// while the person talks; POST /internal/dictation with the WAV as the body.
function register(app, deps = {}) {
  const verifyToken = deps.verifyToken || require("./web-chat-ws").verifyToken;
  const transcribe = deps.transcribe || require("./voice").transcribeAudio;
  const warm = deps.warm || ((ms) => require("./services/listen").warm(ms));
  const body = deps.body || require("express").raw({ type: "audio/wav", limit: LIMIT });
  app.post("/internal/dictation/warm", (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    res.json({ warming: warm(KEEP_MS) });
  });
  app.post("/internal/dictation", body, async (req, res) => {
    const userId = verifyToken(req.get("x-closedhand-token"));
    if (!userId) return res.status(401).json({ error: "Not allowed" });
    const wav = req.body;
    if (!Buffer.isBuffer(wav) || wav.length <= 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
      return res.status(400).json({ error: "No recording came through. Tap the mic and try again." });
    }
    try {
      warm(KEEP_MS);
      res.json({ text: await transcribe(wav) });
    } catch (e) {
      console.error(`[dictation] not written out: ${e.message}`);
      res.status(503).json({ error: SAYABLE.test(e.message) ? e.message : "Closedhand couldn't write that out just now. Try again, or type it." });
    }
  });
}

module.exports = { register };
