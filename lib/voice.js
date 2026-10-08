// lib/voice.js — Audio transcription via Groq Whisper API

const https = require("https");

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Voice notes are written out by Groq when a Groq key is set, and otherwise
// on the computer running ClosedHand (lib/services/listen.js), so they work
// for everyone. The computer reads Ogg Opus (WhatsApp, Telegram) and WAV.
async function transcribeAudio(buffer, filename = "voice.ogg") {
  if (GROQ_API_KEY) return transcribeWithGroq(buffer, filename);
  const kind = buffer.subarray(0, 4).toString("ascii");
  const listen = require("./services/listen");
  const samples = kind === "OggS" ? require("./speech/audio").oggOpusSamples(buffer)
    : kind === "RIFF" ? listen.wavSamples(buffer)
    : null;
  if (!samples) throw new Error("This kind of voice note can't be written out on this computer yet. Type the message instead.");
  return (await listen.transcribe(samples)).text;
}

function transcribeWithGroq(buffer, filename) {
  return new Promise((resolve, reject) => {

    const boundary = "----FormBoundary" + Date.now().toString(16);
    const model = "whisper-large-v3";

    // Build multipart form data manually
    const parts = [];
    // File part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`
    ));
    parts.push(buffer);
    parts.push(Buffer.from("\r\n"));
    // Model part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`
    ));
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/audio/transcriptions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.text) {
            resolve(data.text.trim());
          } else {
            reject(new Error(data.error?.message || "Transcription returned no text"));
          }
        } catch (e) {
          reject(new Error("Failed to parse transcription response"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Transcription timeout")); });
    req.write(body);
    req.end();
  });
}

module.exports = { transcribeAudio };
