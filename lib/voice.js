// lib/voice.js: voice to text, for voice notes from chat apps and the web
// chat's mic (lib/dictation.js).
//
// Everything is written out on the computer running Closedhand by its
// built-in speech to text (lib/services/listen.js), so it is the same for
// everyone, costs nothing and never leaves the computer. It reads Ogg Opus
// (WhatsApp, Telegram) and 16 kHz mono WAV (the web chat's mic).
async function transcribeAudio(buffer) {
  const kind = buffer.subarray(0, 4).toString("ascii");
  const listen = require("./services/listen");
  const samples = kind === "OggS" ? require("./speech/audio").oggOpusSamples(buffer)
    : kind === "RIFF" ? listen.wavSamples(buffer)
    : null;
  if (!samples) throw new Error("This kind of voice note can't be written out on this computer yet. Type the message instead.");
  return String((await listen.transcribe(samples)).text || "").trim();
}

module.exports = { transcribeAudio };
