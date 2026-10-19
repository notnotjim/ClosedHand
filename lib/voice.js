// lib/voice.js: voice to text, for voice notes from chat apps and the web
// chat's mic (lib/dictation.js).
//
// A service the person connected and made Closedhand's voice writes it out
// first (lib/voice-connections.js). Otherwise, or when that fails, it is
// written out on the computer running Closedhand by the built-in speech to
// text (lib/services/listen.js), which costs nothing and never leaves the
// computer. That reads Ogg Opus (WhatsApp, Telegram) and 16 kHz mono WAV
// (the web chat's mic). opts.userId names the person outside a chat turn.
async function transcribeAudio(buffer, opts = {}) {
  const userId = (opts && typeof opts === "object" && opts.userId) || require("./context").activeUserId;
  const heard = await require("./voice-connections").hear(buffer, { userId }).catch(() => null);
  if (heard) return heard;
  const kind = buffer.subarray(0, 4).toString("ascii");
  const listen = require("./services/listen");
  const samples = kind === "OggS" ? require("./speech/audio").oggOpusSamples(buffer)
    : kind === "RIFF" ? listen.wavSamples(buffer)
    : null;
  if (!samples) throw new Error("This kind of voice note can't be written out on this computer yet. Type the message instead.");
  return String((await listen.transcribe(samples, { timestamps: false })).text || "").trim();
}

module.exports = { transcribeAudio };
