// lib/embed-route.js: POST /internal/embed, how File Search in the dashboard
// (webapp/rag-processor.js) uses the local embedding model, which runs here in
// the bot. { texts, query } in, { vectors } out, each the 1536-wide vector the
// index keeps. A query is someone waiting and goes ahead of background work.
// { images } (base64, JPEG or PNG) embeds pictures by what they show, into the
// same space, with EmbeddingGemma 2.
const MAX_TEXTS = 64;

function register(app, deps = {}) {
  const verifyToken = deps.verifyToken || require("./web-chat-ws").verifyToken;
  const usi = deps.usi || require("./services/usi");
  const body = deps.body || require("express").json({ limit: "40mb" });
  app.post("/internal/embed", body, async (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    if (!usi.isLocalEmbed()) return res.status(409).json({ error: "This Closedhand embeds with a hosted model" });
    if (Array.isArray(req.body?.images)) {
      const lm = deps.localModels || require("./local-models");
      if (lm.embedderSpec().runner !== "eg2") return res.status(409).json({ error: "Pictures are embedded by EmbeddingGemma 2 only" });
      try {
        const vectors = [];
        for (const image of req.body.images.slice(0, 8)) vectors.push(await lm.localEmbedMedia("image", Buffer.from(String(image), "base64")));
        return res.json({ vectors });
      } catch (e) {
        console.log(`[embed] picture not embedded: ${e.message}`);
        return res.status(503).json({ error: "The picture model is not ready yet" });
      }
    }
    const texts = Array.isArray(req.body?.texts) ? req.body.texts.slice(0, MAX_TEXTS).map((t) => String(t || "")) : [];
    if (!texts.length) return res.status(400).json({ error: "Nothing to embed" });
    // A file's chunks wait their turn with the rest of the indexing.
    const vectors = await usi.embedBatch(texts, { quick: !!req.body.query }).catch(() => []);
    if (vectors.length !== texts.length) return res.status(503).json({ error: "The embedding model is not ready yet" });
    res.json({ vectors });
  });
}

module.exports = { register, MAX_TEXTS };
