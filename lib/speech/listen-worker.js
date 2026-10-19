// Speech to text on this computer (Whisper, from assets/listen). Runs in its
// own process like the voice, so the model's memory is released when idle.
const path = require("path");

async function run(workerData) {
  const { env, pipeline, Tensor } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.useFSCache = false;
  env.localModelPath = path.dirname(workerData.directory);
  const asr = await pipeline("automatic-speech-recognition", path.basename(workerData.directory), {
    dtype: "q8", device: "cpu", local_files_only: true,
    session_options: { intraOpNumThreads: workerData.threads, interOpNumThreads: 1, enableCpuMemArena: false },
  });
  const config = asr.model.generation_config;

  // The library assumes English unless told otherwise, so the language is
  // found the way Whisper itself does it: one step of the model, reading
  // which language token it rates most likely for the first 30 seconds.
  async function language(audio) {
    const { input_features } = await asr.processor(audio.subarray(0, 16000 * 30));
    const start = new Tensor("int64", [BigInt(config.decoder_start_token_id)], [1, 1]);
    const out = await asr.model({ input_features, decoder_input_ids: start });
    let best = null;
    for (const [token, id] of Object.entries(config.lang_to_id)) if (!best || out.logits.data[id] > out.logits.data[best[1]]) best = [token, id];
    return best[0].slice(2, -2);
  }

  async function writeOut(samples, id, timestamps = true) {
    const lang = await language(samples);
    if (id) process.send({ type: "progress", id });
    const out = await asr(samples, { language: lang, task: "transcribe", return_timestamps: timestamps, chunk_length_s: 30 });
    const text = String(out.text || "").trim();
    const lines = timestamps
      ? (out.chunks || []).map((c) => ({ start: c.timestamp?.[0] ?? null, text: String(c.text || "").trim() })).filter((c) => c.text)
      : (text ? [{ start: null, text }] : []);
    return { language: lang, lines, text };
  }
  // One run on a second of quiet before saying ready: the first run after
  // loading is several times slower than the rest, so nobody's speech waits
  // for it.
  await writeOut(new Float32Array(16000));
  process.send({ type: "ready" });

  process.on("message", async ({ id, audio, timestamps }) => {
    try {
      const samples = audio instanceof Float32Array ? audio : new Float32Array(audio);
      process.send({ type: "done", id, ...(await writeOut(samples, id, timestamps !== false)) });
    } catch (error) { process.send({ type: "error", id, error: error.message }); }
  });
}
process.on("disconnect", () => process.exit(0));
process.once("message", (options) => {
  if (options.type !== "init") process.exit(1);
  run(options).catch((error) => { console.error(error.message); process.exit(1); });
});
