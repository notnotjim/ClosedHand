// lib/services/tts.js -- Text-to-Speech via Google Cloud TTS API
// Uses API key auth (not OAuth). Returns OGG Opus audio buffer.

const https = require("https");

const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;

// Default voice config - natural sounding female voice
const DEFAULT_VOICE = {
  languageCode: "en-GB",
  name: "en-GB-Wavenet-A",
  ssmlGender: "FEMALE",
};

// Max text length per request (5000 bytes is Google's limit)
const MAX_TEXT_LENGTH = 4800;

async function synthesize(text, opts = {}) {
  if (!GOOGLE_TTS_API_KEY) {
    throw new Error("GOOGLE_TTS_API_KEY not configured");
  }

  if (!text || !text.trim()) {
    throw new Error("No text to synthesize");
  }

  // Truncate if too long
  let inputText = text.trim();
  if (inputText.length > MAX_TEXT_LENGTH) {
    inputText = inputText.substring(0, MAX_TEXT_LENGTH) + "...";
  }

  // Strip markdown, tool references, and other non-speech content
  inputText = inputText
    .replace(/\*\*([^*]+)\*\*/g, "$1")  // bold
    .replace(/\*([^*]+)\*/g, "$1")      // italic
    .replace(/`[^`]+`/g, "")            // inline code
    .replace(/```[\s\S]*?```/g, "")     // code blocks
    .replace(/https?:\/\/\S+/g, "")     // URLs
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // markdown links
    .replace(/\n{2,}/g, ". ")           // paragraph breaks to pauses
    .replace(/\n/g, ". ")               // line breaks to pauses
    .trim();

  if (!inputText) {
    throw new Error("Text is empty after cleanup");
  }

  const voice = {
    languageCode: opts.languageCode || DEFAULT_VOICE.languageCode,
    name: opts.voiceName || DEFAULT_VOICE.name,
    ssmlGender: opts.gender || DEFAULT_VOICE.ssmlGender,
  };

  const body = JSON.stringify({
    input: { text: inputText },
    voice: voice,
    audioConfig: {
      audioEncoding: "OGG_OPUS",
      speakingRate: opts.speed || 1.0,
      pitch: opts.pitch || 0,
      effectsProfileId: ["handset-class-device"],
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "texttospeech.googleapis.com",
      path: `/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          console.error(`[TTS] Google TTS error ${res.statusCode}: ${text.substring(0, 200)}`);
          reject(new Error(`TTS API error: ${res.statusCode}`));
          return;
        }
        try {
          const data = JSON.parse(text);
          if (!data.audioContent) {
            reject(new Error("No audio content in TTS response"));
            return;
          }
          const buffer = Buffer.from(data.audioContent, "base64");
          console.log(`[TTS] Synthesized ${inputText.length} chars, ${buffer.length} bytes audio`);
          resolve(buffer);
        } catch (e) {
          reject(new Error("Failed to parse TTS response"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("TTS request timeout")); });
    req.write(body);
    req.end();
  });
}

// Check if TTS is available
function isTtsAvailable() {
  return !!GOOGLE_TTS_API_KEY;
}

module.exports = { synthesize, isTtsAvailable };
