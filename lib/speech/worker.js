const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const { phonemize } = require("./phonemize");
const { chunks } = require("./text");
const { wav, oggOpus } = require("./audio");

async function run() {
  const { env, StyleTextToSpeech2Model, AutoTokenizer, Tensor } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.useFSCache = false;
  const modelPath = workerData.directory;
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(modelPath, {
      dtype: "q8", device: "cpu", local_files_only: true,
      session_options: { intraOpNumThreads: workerData.threads, interOpNumThreads: 1, enableCpuMemArena: false },
    }),
    AutoTokenizer.from_pretrained(modelPath, { local_files_only: true }),
  ]);
  const bytes = fs.readFileSync(path.join(modelPath, "voices/af_heart.bin"));
  const styles = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  parentPort.postMessage({ type: "ready" });

  async function render(text, output) {
    const phonemes = await phonemize(text);
    const { input_ids } = tokenizer(phonemes, { truncation: false });
    const count = input_ids.dims.at(-1);
    if (count > 512) {
      input_ids.dispose();
      const midpoint = Math.max(1, Math.floor(text.length / 2));
      await render(text.slice(0, midpoint), output);
      await render(text.slice(midpoint), output);
      return;
    }
    const offset = Math.min(Math.max(count - 2, 0), 509) * 256;
    const style = new Tensor("float32", styles.slice(offset, offset + 256), [1, 256]);
    const speed = new Tensor("float32", [1], [1]);
    let waveform;
    try {
      ({ waveform } = await model({ input_ids, style, speed }));
      const samples = Float32Array.from(waveform.data);
      if (!samples.length || !samples.every(Number.isFinite)) throw new Error("Voice produced invalid audio");
      output(samples);
    } finally {
      for (const tensor of [input_ids, style, speed, waveform]) tensor?.dispose();
    }
  }

  parentPort.on("message", async ({ id, text, format }) => {
    try {
      const buffers = [];
      for (const chunk of chunks(text)) {
        await render(chunk, samples => {
          if (format === "ogg") {
            buffers.push(samples);
            parentPort.postMessage({ type: "progress", id });
          }
          else parentPort.postMessage({ type: "chunk", id, audio: wav(samples) });
        });
      }
      let audio;
      if (format === "ogg") {
        const samples = new Float32Array(buffers.reduce((sum, b) => sum + b.length, 0));
        let offset = 0;
        for (const b of buffers) { samples.set(b, offset); offset += b.length; }
        audio = oggOpus(samples);
      }
      parentPort.postMessage({ type: "done", id, audio });
    } catch (error) { parentPort.postMessage({ type: "error", id, error: error.message }); }
  });
}
run().catch(error => { throw error; });
