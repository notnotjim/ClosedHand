// lib/hear-route.js: POST /internal/hear, how File Search in the dashboard
// (webapp/rag-processor.js) gets recordings and videos written out: the
// speech to text lives here, in the bot. The file is the body, its name is
// ?name=, and a video asks for ?video=1 and up to ?frames=N frames; ?vectors=1
// asks for the sound and frames embedded too (EmbeddingGemma 2 only).
// Answers { text, duration, frames: [{ time, jpeg, vector }], sound: [{ start,
// end, vector }], note }, where text is what's said, one line per stretch,
// each starting with its time ("[7:55]").

const LIMIT = "500mb";
// Its own errors are written for people; anything else is logged, not shown.
const SAYABLE = /sandbox|too long|couldn't open|can't/i;

function register(app, deps = {}) {
  const verifyToken = deps.verifyToken || require("./web-chat-ws").verifyToken;
  const hear = deps.hear || ((args) => require("./video").hearMedia(args));
  const body = deps.body || require("express").raw({ type: () => true, limit: LIMIT });
  app.post("/internal/hear", body, async (req, res) => {
    const userId = verifyToken(req.get("x-closedhand-token"));
    if (!userId) return res.status(401).json({ error: "Not allowed" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through." });
    try {
      const heard = await hear({
        userId, buffer: req.body, name: String(req.query.name || "file").slice(0, 200),
        video: req.query.video === "1", frames: Math.max(0, Math.min(24, Number(req.query.frames) || 0)), vectors: req.query.vectors === "1",
      });
      res.json({
        text: saidText(heard.said),
        duration: heard.duration || null,
        frames: (heard.frames || []).map((f) => ({ time: f.time, jpeg: Buffer.from(f.jpeg).toString("base64"), vector: f.vector || null })),
        sound: heard.sound || [],
        note: heard.note || null,
      });
    } catch (e) {
      console.error(`[hear] not written out: ${e.message}`);
      res.status(503).json({ error: e.userFacing || SAYABLE.test(e.message) ? e.message : "Closedhand couldn't hear this file just now." });
    }
  });
}

// What's said, whole, each line with its time.
function saidText(said) {
  const { clock } = require("./video");
  return (said?.lines || []).map((l) => (l.start == null ? "" : `[${clock(l.start)}] `) + l.text).join("\n");
}

module.exports = { register, saidText };
