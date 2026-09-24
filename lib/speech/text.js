const MAX_TEXT = 12000;

function speechText(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("There is no text to read aloud.");
  if (text.length > MAX_TEXT) throw new Error("This reply is too long to read aloud. Ask for a shorter version.");
  const clean = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\|/g, ", ")
    .replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(clean)) throw new Error("There is no text to read aloud in this reply.");
  return clean;
}

// Short sentences start playback promptly. Never truncate a long sentence.
function chunks(text, limit = 180) {
  const sentences = text.split(/(?<=[.!?])\s+/u);
  const result = [];
  for (const sentence of sentences) {
    let chunk = "";
    for (const word of sentence.trim().split(/\s+/)) {
      if (chunk && chunk.length + word.length + 1 > limit) { result.push(chunk); chunk = ""; }
      // Very long tokens are broken too, so malformed input cannot overflow a model context.
      for (let offset = 0; offset < word.length; offset += limit) {
        const piece = word.slice(offset, offset + limit);
        if (offset) { if (chunk) result.push(chunk); chunk = piece; }
        else chunk += (chunk ? " " : "") + piece;
      }
    }
    if (chunk) result.push(chunk);
  }
  return result;
}
module.exports = { speechText, chunks, MAX_TEXT };
