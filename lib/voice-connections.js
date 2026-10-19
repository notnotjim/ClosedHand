// lib/voice-connections.js: a connected service as Closedhand's voice.
//
// When the person has connected a service that can speak, or write out
// speech (found when it was connected, webapp/connection-jobs.js), whether as an
// MCP server or with a key for its plain API, and left the
// "Closedhand's voice" switch on its tile on, spoken replies, Read aloud,
// voice notes and the web chat's mic go through it. Whatever goes wrong falls
// back to the built-in voice for that message, and the tile says why.
// Switched off or disconnected, there is only the built-in voice.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MAX_BYTES = 25 * 1024 * 1024;
// Which audio format to ask for, where the service lets Closedhand choose: a
// chat app's voice note has to be Ogg Opus (WAV and raw PCM are encoded here),
// while every browser plays MP3.
const PREFER = {
  voiceNote: [/opus|ogg/i, /wav|pcm/i, /mp3|mpeg/i],
  browser: [/mp3|mpeg/i, /wav|pcm/i, /opus|ogg/i],
};

const db = () => require("./db").supabase;

// The connection switched on for a job ("speak" or "hear"), or null.
async function connectionFor(userId, job, deps = {}) {
  if (!userId) return null;
  const { data, error } = await (deps.db || db()).from("user_mcps").select("id, name, caps, updated_at, transport").eq("user_id", userId).eq("status", "connected");
  if (error) throw new Error(error.message);
  return (data || []).filter((r) => r.caps?.voice?.on && r.caps.voice[job])
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))[0] || null;
}

// The tile shows the last time the built-in voice stood in, and why; a
// working voice clears it. Nothing is written while nothing changes.
async function note(row, why, deps = {}) {
  const was = row.caps?.voice?.fallback?.why || null;
  const now = why ? String(why).slice(0, 200) : null;
  if (was === now) return;
  const store = deps.db || db();
  const { data, error } = await store.from("user_mcps").select("caps").eq("id", row.id).single();
  if (error || !data?.caps?.voice) return;
  const voice = { ...data.caps.voice };
  if (now) voice.fallback = { at: new Date().toISOString(), why: now }; else delete voice.fallback;
  // caps holds no secrets, so there is nothing to seal.
  const { error: writeError } = await store.from("user_mcps").update({ caps: { ...data.caps, voice } }).eq("id", row.id);
  if (writeError) console.warn(`[voice] couldn't note the fallback on ${row.name}: ${writeError.message}`);
}

function sniff(b) {
  if (!b || b.length < 12) return null;
  const head = b.toString("ascii", 0, 4);
  if (head === "OggS") return "audio/ogg";
  if (head === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (b.toString("ascii", 4, 8) === "ftyp") return "audio/mp4";
  if (head === "fLaC") return "audio/flac";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  return null;
}

// A link the service sent back, fetched only from a public https address and
// only if it really is audio.
async function download(url, deps = {}) {
  if (!/^https:\/\//i.test(url) || require("./ssrf").isBlockedUrl(url)) return null;
  const r = await (deps.fetch || fetch)(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok || !r.body) return null;
  if (Number(r.headers.get("content-length") || 0) > MAX_BYTES) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > MAX_BYTES) return null;
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const type = String(r.headers.get("content-type") || "").split(";")[0].trim();
  const kind = sniff(buffer);
  if (!kind && !/^audio\//i.test(type)) return null;
  return { buffer, mimeType: /^audio\//i.test(type) ? type : kind };
}

// The sound in a tool's answer: the audio itself, a file, or a link to it.
async function audioIn(result, deps = {}) {
  const content = (result && result.content) || [];
  for (const c of content) {
    if (c && c.type === "audio" && c.data) return { buffer: Buffer.from(String(c.data), "base64"), mimeType: c.mimeType || "" };
    if (c && c.type === "resource" && c.resource?.blob && /^audio\//i.test(c.resource.mimeType || "")) return { buffer: Buffer.from(String(c.resource.blob), "base64"), mimeType: c.resource.mimeType };
  }
  const links = [];
  for (const c of content) {
    if (c && c.type === "resource_link" && c.uri) links.push(c.uri);
    if (c && c.type === "text") links.push(...(String(c.text || "").match(/https:\/\/[^\s"'<>)\]]+/g) || []));
  }
  if (result?.structuredContent) links.push(...(JSON.stringify(result.structuredContent).match(/https:\/\/[^\s"'<>)\]\\]+/g) || []));
  for (const url of links) {
    const got = await download(url, deps).catch(() => null);
    if (got) return got;
  }
  return null;
}

// The words in a tool's answer: its text, or a "text" field in what it sent.
function textIn(result) {
  const fromJson = (s) => { try { const j = JSON.parse(s); return typeof j?.text === "string" ? j.text : null; } catch { return null; } };
  if (typeof result?.structuredContent?.text === "string") return result.structuredContent.text.trim();
  const text = ((result && result.content) || []).filter((c) => c && c.type === "text").map((c) => String(c.text || "")).join("\n").trim();
  return (fromJson(text) ?? text).trim();
}

function pickFormat(format, target) {
  if (!format || !Array.isArray(format.values)) return null;
  for (const re of PREFER[target] || []) {
    const v = format.values.find((x) => re.test(x));
    if (v) return v;
  }
  return null;
}

function resample(samples, from, to) {
  if (from === to || !from) return samples;
  const out = new Float32Array(Math.max(1, Math.floor(samples.length * to / from)));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step, j = Math.floor(x), f = x - j;
    out[i] = (samples[j] || 0) * (1 - f) + (samples[j + 1] ?? samples[j] ?? 0) * f;
  }
  return out;
}
function pcm16(buffer, channels = 1) {
  const frames = Math.floor(buffer.length / 2 / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buffer.readInt16LE((i * channels + c) * 2) / 32768;
    out[i] = sum / channels;
  }
  return out;
}
function readWav(buffer) {
  let i = 12, rate = 0, channels = 1, bits = 16;
  while (i + 8 <= buffer.length) {
    const id = buffer.toString("ascii", i, i + 4), size = buffer.readUInt32LE(i + 4);
    if (id === "fmt ") { channels = buffer.readUInt16LE(i + 10); rate = buffer.readUInt32LE(i + 12); bits = buffer.readUInt16LE(i + 22); }
    if (id === "data") {
      if (bits !== 16 || !rate) return null;
      return { samples: pcm16(buffer.subarray(i + 8, i + 8 + size), channels), rate };
    }
    i += 8 + size + (size % 2);
  }
  return null;
}

// What a chat app can play: a voice note is Ogg Opus, made here from WAV or
// raw PCM; anything else (MP3) goes as an audio message.
function forChatApp(audio, chosen, deps = {}) {
  const kind = sniff(audio.buffer);
  if (kind === "audio/ogg") return { buffer: audio.buffer, mimeType: "audio/ogg", voiceNote: true };
  let pcm = null;
  if (kind === "audio/wav") pcm = readWav(audio.buffer);
  else if (!kind && chosen && /pcm/i.test(chosen)) pcm = { samples: pcm16(audio.buffer), rate: Number((chosen.match(/(\d{4,6})/) || [])[1]) || 24000 };
  if (pcm) return { buffer: (deps.oggOpus || require("./speech/audio").oggOpus)(resample(pcm.samples, pcm.rate, 24000)), mimeType: "audio/ogg", voiceNote: true };
  return { buffer: audio.buffer, mimeType: kind || audio.mimeType || "audio/mpeg", voiceNote: false };
}

// A service connected with a key is called endpoint by endpoint
// (lib/api-connections.js); an MCP connection, tool by tool.
function callTool(deps, row) {
  if (deps.callTool) return deps.callTool;
  return row?.transport === "api" ? require("./api-connections").callEndpoint : require("./user-mcp").callConnectionTool;
}

async function speakWith(row, userId, text, target, deps = {}) {
  const plan = row.caps.voice.speak;
  const chosen = pickFormat(plan.format, target);
  const args = { ...(plan.fixed || {}), [plan.text]: text, ...(chosen ? { [plan.format.arg]: chosen } : {}) };
  const result = await callTool(deps, row)(userId, row.id, plan.tool, args);
  if (result?.isError) throw new Error(textIn(result) || "it said no");
  const audio = await audioIn(result, deps);
  if (!audio || !audio.buffer.length) throw new Error("it sent back no sound");
  return target === "browser" ? { buffer: audio.buffer, mimeType: sniff(audio.buffer) || audio.mimeType || "audio/mpeg", voiceNote: false } : forChatApp(audio, chosen, deps);
}

// A spoken reply: { buffer, mimeType, voiceNote }, from the connected voice
// when one is on, else the built-in voice; null when there is neither.
// target "voiceNote" for chat apps, "browser" for Read aloud. builtIn false
// returns null instead of the built-in voice, for a caller that has its own
// way of using it (Read aloud streams it sentence by sentence).
async function speak(text, { userId = require("./context").activeUserId, target = "voiceNote", builtIn = true, deps = {} } = {}) {
  const row = await connectionFor(userId, "speak", deps).catch(() => null);
  if (row) {
    try {
      const got = await speakWith(row, userId, text, target, deps);
      await note(row, null, deps).catch(() => {});
      return got;
    } catch (e) {
      console.warn(`[voice] ${row.name} couldn't speak, so the built-in voice did: ${e.message}`);
      await note(row, `${row.name} couldn't speak: ${e.message}`, deps).catch(() => {});
    }
  }
  if (!builtIn) return null;
  const tts = deps.tts || require("./services/tts");
  if (!tts.isTtsAvailable()) return null;
  return { buffer: await tts.synthesize(text), mimeType: "audio/ogg", voiceNote: true, builtIn: true };
}

// Speech to text through the connected service: the words, or null when no
// service is on for it. Throws only for the caller to fall back.
async function hear(buffer, { userId = require("./context").activeUserId, deps = {} } = {}) {
  const row = await connectionFor(userId, "hear", deps).catch(() => null);
  if (!row) return null;
  const plan = row.caps.voice.hear;
  let file = null;
  try {
    // An upload goes as the recording itself.
    let value = plan.as === "file" ? buffer : buffer.toString("base64");
    if (plan.as === "path") {
      const ext = ({ "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/webm": "webm", "audio/flac": "flac" })[sniff(buffer)] || "ogg";
      file = path.join(os.tmpdir(), `closedhand-voice-${crypto.randomBytes(6).toString("hex")}.${ext}`);
      fs.writeFileSync(file, buffer);
      value = file;
    }
    const result = await callTool(deps, row)(userId, row.id, plan.tool, { ...(plan.fixed || {}), [plan.audio]: value });
    const words = textIn(result);
    if (result?.isError || !words) throw new Error(words || "it sent back no words");
    await note(row, null, deps).catch(() => {});
    return words;
  } catch (e) {
    console.warn(`[voice] ${row.name} couldn't write out the voice note, so the built-in voice did: ${e.message}`);
    await note(row, `${row.name} couldn't write out speech: ${e.message}`, deps).catch(() => {});
    return null;
  } finally {
    if (file) fs.rm(file, { force: true }, () => {});
  }
}

// A file name for a reply that isn't a voice note, by its kind.
function replyFileName(mimeType) {
  const ext = ({ "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/aac": "aac", "audio/webm": "webm", "audio/flac": "flac", "audio/ogg": "ogg" })[String(mimeType || "").split(";")[0]] || "mp3";
  return `reply.${ext}`;
}

module.exports = { speak, hear, connectionFor, audioIn, textIn, pickFormat, forChatApp, sniff, replyFileName };
