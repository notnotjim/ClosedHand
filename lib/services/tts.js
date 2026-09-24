// Built-in Kokoro speech. One bounded worker serves chat apps and web playback.
// Text and audio stay on the computer running ClosedHand. No hosted fallback.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Worker } = require("worker_threads");
const { speechText } = require("../speech/text");
const manifest = require("../speech/assets.json");
const DIRECTORY = path.join(__dirname, "../../assets/voice/kokoro-v1");

function createSpeechService(options = {}) {
  const directory = options.directory || DIRECTORY;
  const WorkerClass = options.Worker || Worker;
  const idleMs = options.idleMs ?? 60000;
  const timeoutMs = options.timeoutMs ?? 120000;
  const queue = [];
  let worker = null, active = null, ready = false, idleTimer = null, timer = null, nextId = 0;
  function isTtsAvailable() {
    return manifest.files.length > 0 && manifest.files.every(file => fs.existsSync(path.join(directory, file.path)));
  }
  function stopWorker() {
    const old = worker;
    worker = null; ready = false;
    clearTimeout(idleTimer);
    if (old) old.terminate().catch(() => {});
  }
  function finish(error, audio) {
    const job = active;
    if (!job) return;
    active = null;
    clearTimeout(timer);
    job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error); else job.resolve(audio);
    pump();
  }
  function deadline() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stopWorker();
      finish(new Error("Reading aloud took too long. Try a shorter reply."));
    }, timeoutMs);
  }
  function dispatch() {
    if (active && ready) worker.postMessage({ id: active.id, text: active.text, format: active.format });
  }
  function startWorker() {
    const instance = new WorkerClass(path.join(__dirname, "../speech/worker.js"), {
      workerData: { directory, threads: Math.max(1, Math.min(2, Math.floor(os.cpus().length / 2))) },
    });
    worker = instance;
    instance.on("message", msg => {
      if (worker !== instance) return;
      if (msg.type === "ready") { ready = true; dispatch(); return; }
      if (!active || msg.id !== active.id) return;
      if (msg.type === "progress") { deadline(); }
      else if (msg.type === "chunk") {
        deadline();
        try { active.onChunk?.(Buffer.from(msg.audio)); }
        catch (err) { stopWorker(); finish(err); }
      } else if (msg.type === "done") finish(null, msg.audio ? Buffer.from(msg.audio) : undefined);
      else if (msg.type === "error") {
        console.error("[voice] Synthesis failed:", msg.error);
        stopWorker();
        finish(new Error("Couldn't read this reply aloud. Try again."));
      }
    });
    const failed = error => {
      if (worker !== instance) return;
      console.error("[voice] Worker failed:", error.message);
      stopWorker();
      finish(new Error("The voice couldn't start. Try again."));
    };
    instance.on("error", failed);
    instance.on("exit", code => failed(new Error(`Voice worker exited (${code})`)));
  }
  function pump() {
    if (active) return;
    clearTimeout(idleTimer);
    active = queue.shift() || null;
    if (!active) {
      worker?.unref();
      idleTimer = setTimeout(stopWorker, idleMs);
      idleTimer.unref();
      return;
    }
    deadline();
    try {
      if (!worker) startWorker();
      worker.ref();
      if (ready) dispatch();
    } catch (error) { stopWorker(); finish(error); }
  }
  function submit(text, format, { signal, onChunk } = {}) {
    let clean;
    try {
      clean = speechText(text);
      if (!isTtsAvailable()) throw new Error("The built-in voice is missing. Update ClosedHand to restore it.");
      if (signal?.aborted) throw new Error("Reading stopped.");
      if (queue.length >= 3) throw new Error("The voice is busy. Try again in a moment.");
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const job = { id: ++nextId, text: clean, format, signal, onChunk, resolve, reject };
      job.abort = () => {
        if (active === job) { stopWorker(); finish(new Error("Reading stopped.")); }
        else {
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          signal?.removeEventListener("abort", job.abort);
          reject(new Error("Reading stopped."));
        }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      queue.push(job);
      pump();
    });
  }
  return {
    isTtsAvailable,
    synthesize: (text, options) => submit(text, "ogg", options),
    streamSpeech: (text, onChunk, options = {}) => submit(text, "wav", { ...options, onChunk }),
  };
}
module.exports = { ...createSpeechService(), createSpeechService };
