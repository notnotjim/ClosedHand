// A service the person connects that can speak or write out speech becomes
// Closedhand's voice, with no code for that service: its tools are read once
// when it is connected, the answer is checked against the tools' own
// definitions, and voice notes, the mic, spoken replies and Read aloud go
// through it while its switch is on. Whatever fails falls back to the
// built-in voice for that message, and the tile says why.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findJobs, check } = require("../webapp/connection-jobs");
const voice = require("../lib/voice-connections");

// An invented voice service's tools, in the shapes services publish.
const TOOLS = [
  { name: "list_agents", description: "List conversational agents.", inputSchema: { type: "object", properties: {} } },
  { name: "text_to_speech", description: "Convert text to speech with a chosen voice and return the audio.",
    inputSchema: { type: "object", required: ["text", "output_format"], properties: {
      text: { type: "string" }, voice_id: { type: "string" },
      output_format: { type: "string", enum: ["mp3_44100_128", "pcm_16000", "opus_48000_64"] } } } },
  { name: "speech_to_text", description: "Transcribe an audio recording to text.",
    inputSchema: { type: "object", required: ["audio_base64"], properties: { audio_base64: { type: "string" }, language: { type: "string", default: "auto" } } } },
];
const answer = (input) => async () => ({ content: [{ type: "tool_use", name: "report_jobs", input }] });

test("the model's reading is kept only where the tools' own definitions bear it out", async () => {
  const { voice: plan } = await findJobs(TOOLS, { model: "kestrel-1" }, { request: answer({
    speak: { found: true, tool: "text_to_speech", text_argument: "text", format_argument: "output_format", fixed_arguments: {} },
    hear: { found: true, tool: "speech_to_text", audio_argument: "audio_base64", audio_as: "base64" },
    search: { found: false },
  }) });
  assert.deepEqual(plan.speak, { tool: "text_to_speech", text: "text", format: { arg: "output_format", values: ["mp3_44100_128", "pcm_16000", "opus_48000_64"] }, fixed: {} });
  assert.deepEqual(plan.hear, { tool: "speech_to_text", audio: "audio_base64", as: "base64", fixed: {} });

  assert.equal(check(TOOLS, { found: true, tool: "make_speech", text_argument: "text" }, "speak"), null, "a tool it doesn't have");
  assert.equal(check(TOOLS, { found: true, tool: "text_to_speech", text_argument: "words" }, "speak"), null, "an argument it doesn't take");
  assert.equal(check(TOOLS, { found: true, tool: "text_to_speech", text_argument: "text", fixed_arguments: { output_format: "wav_8000" } }, "speak"), null, "a value its list doesn't allow");
  assert.equal(check(TOOLS, { found: true, tool: "speech_to_text", audio_argument: "audio_base64", audio_as: "url" }, "hear"), null, "a web address would mean putting the recording online");
});

test("a service with nothing about voice costs no model call, and a failed check keeps what was found", async () => {
  let asked = 0;
  const count = async () => { asked++; throw new Error("down"); };
  const noJobs = Object.fromEntries(Object.keys(require("../webapp/connection-jobs").TOOL_JOBS).map((j) => [j, null]));
  assert.deepEqual(await findJobs([TOOLS[0]], { model: "kestrel-1" }, { request: count }), { voice: null, jobs: noJobs });
  assert.equal(asked, 0);
  assert.deepEqual(await findJobs(TOOLS, null), { voice: undefined, jobs: undefined }, "no model to ask");
  assert.deepEqual(await findJobs(TOOLS, { model: "kestrel-1" }, { request: count }), { voice: undefined, jobs: undefined }, "the model failed");
});

// A stand-in for the database: one connection with a voice plan.
function store(caps) {
  const row = { id: "conn-1", name: "Kestrel Voice", updated_at: "2026-10-19T10:00:00Z", caps };
  const writes = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: (k1) => ({
          eq: async () => ({ data: [row], error: null }),
          single: async () => ({ data: { caps: row.caps }, error: null }),
        }),
      }),
      update: (patch) => ({ eq: async () => { writes.push(patch.caps.voice); row.caps = patch.caps; return { error: null }; } }),
    }),
  };
  return { db, writes, row };
}
const plan = { speak: { tool: "text_to_speech", text: "text", format: { arg: "output_format", values: ["mp3_44100_128", "pcm_16000", "opus_48000_64"] }, fixed: {} }, hear: { tool: "speech_to_text", audio: "audio_base64", as: "base64", fixed: {} } };
const builtIn = { isTtsAvailable: () => true, synthesize: async () => Buffer.from("OggS built-in voice") };
const wav = () => { const b = Buffer.alloc(44 + 4800); b.write("RIFF", 0); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(4800, 40); return b; };

test("spoken replies come from the connected voice, in a kind each place can play", async () => {
  const { db } = store({ voice: { ...plan, on: true } });
  const calls = [];
  const callTool = async (userId, rowId, tool, args) => { calls.push(args.output_format); return { content: [{ type: "audio", data: (args.output_format.startsWith("opus") ? Buffer.from("OggS opus voice") : Buffer.from("ID3 mp3 voice")).toString("base64"), mimeType: "audio/ogg" }] }; };
  const note = await voice.speak("Ferries every forty minutes.", { userId: "u1", deps: { db, callTool, tts: builtIn } });
  assert.deepEqual([note.voiceNote, note.mimeType, note.buffer.toString()], [true, "audio/ogg", "OggS opus voice"], "chat apps ask for Ogg Opus, a voice note");
  const page = await voice.speak("Ferries every forty minutes.", { userId: "u1", target: "browser", deps: { db, callTool, tts: builtIn } });
  assert.deepEqual([page.voiceNote, page.mimeType], [false, "audio/mpeg"], "Read aloud asks for MP3, which every browser plays");
  assert.deepEqual(calls, ["opus_48000_64", "mp3_44100_128"]);

  const made = voice.forChatApp({ buffer: wav(), mimeType: "audio/wav" }, null, { oggOpus: (samples) => Buffer.from(`OggS ${samples.length} samples`) });
  assert.deepEqual([made.voiceNote, made.buffer.toString()], [true, "OggS 2400 samples"], "WAV is made into a voice note here");
  assert.equal(voice.forChatApp({ buffer: Buffer.from("ID3 mp3 voice bytes"), mimeType: "audio/mpeg" }).voiceNote, false, "MP3 goes as an audio message");
});

test("sound sent as a link is fetched, from public https addresses only", async () => {
  const fetched = [];
  const fetchFn = async (url) => { fetched.push(url); return { ok: true, headers: new Map([["content-type", "audio/mpeg"]]), body: [Buffer.from("ID3 linked voice")] }; };
  const got = await voice.audioIn({ content: [{ type: "text", text: "Saved. Download: https://files.example.net/voice/abc.mp3 (expires in 10 minutes)" }] }, { fetch: fetchFn });
  assert.equal(got.buffer.toString(), "ID3 linked voice");
  assert.equal(await voice.audioIn({ content: [{ type: "text", text: "http://files.example.net/a.mp3 https://127.0.0.1/a.mp3" }] }, { fetch: fetchFn }), null);
  assert.deepEqual(fetched, ["https://files.example.net/voice/abc.mp3"]);
});

test("when the connected voice fails, the built-in one stands in and the tile says why, once", async () => {
  const { db, writes } = store({ voice: { ...plan, on: true } });
  const failing = async () => { throw new Error("quota used up"); };
  const quiet = console.warn; console.warn = () => {};
  try {
    for (let i = 0; i < 2; i++) {
      const got = await voice.speak("Hello", { userId: "u1", deps: { db, callTool: failing, tts: builtIn } });
      assert.equal(got.buffer.toString(), "OggS built-in voice");
    }
    assert.equal(writes.length, 1, "the same reason is written once");
    assert.match(writes[0].fallback.why, /Kestrel Voice couldn't speak: quota used up/);
    await voice.speak("Hello", { userId: "u1", deps: { db, callTool: async () => ({ content: [{ type: "audio", data: Buffer.from("OggS ok").toString("base64") }] }), tts: builtIn } });
    assert.equal(writes.length, 2);
    assert.equal(writes[1].fallback, undefined, "a working voice clears it");
    assert.equal(await voice.speak("Hello", { userId: "u1", builtIn: false, deps: { db, callTool: failing, tts: builtIn } }), null, "Read aloud uses its own built-in path");
  } finally { console.warn = quiet; }
});

test("voice notes are written out by the connected service, or by the built-in one when it's off or fails", async () => {
  const on = store({ voice: { ...plan, on: true } });
  const sent = [];
  const callTool = async (userId, rowId, tool, args) => { sent.push([tool, Buffer.from(args.audio_base64, "base64").toString()]); return { content: [{ type: "text", text: JSON.stringify({ text: " Call me back after six. " }) }] }; };
  assert.equal(await voice.hear(Buffer.from("OggS voice note"), { userId: "u1", deps: { db: on.db, callTool } }), "Call me back after six.");
  assert.deepEqual(sent, [["speech_to_text", "OggS voice note"]]);
  const off = store({ voice: { ...plan, on: false } });
  assert.equal(await voice.hear(Buffer.from("OggS voice note"), { userId: "u1", deps: { db: off.db, callTool } }), null, "switched off: the built-in voice");
  const quiet = console.warn; console.warn = () => {};
  try { assert.equal(await voice.hear(Buffer.from("OggS voice note"), { userId: "u1", deps: { db: on.db, callTool: async () => { throw new Error("down"); } } }), null); }
  finally { console.warn = quiet; }
});
