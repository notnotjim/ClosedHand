// Speech to text on the computer running Closedhand (Whisper base, bundled at
// build time like the voice). Used for what's said in a video when the chosen
// models can't hear it themselves, and for voice notes. Nothing leaves the
// computer, and the model is unloaded a minute after its last use.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { fork } = require("child_process");
const manifest = require("../speech/listen-assets.json");
const DIRECTORY = path.join(__dirname, "../../assets/listen/whisper-base");
const RATE = 16000;

function createListeningService(options = {}) {
  const directory = options.directory || DIRECTORY;
  const spawn = options.spawn || ((file, settings) => fork(file, [], settings));
  const idleMs = options.idleMs ?? 60000;
  // A minute of speech takes this computer up to about half a minute when it
  // is busy; the limit leaves room for that and still ends a stuck run.
  const timeoutMs = options.timeoutMs ?? 10 * 60000;
  const queue = [];
  let worker = null, active = null, ready = false, idleTimer = null, timer = null, nextId = 0, keepUntil = 0;
  const isAvailable = () => manifest.files.length > 0 && manifest.files.every((file) => fs.existsSync(path.join(directory, file.path)));
  function stopWorker() {
    const old = worker;
    worker = null; ready = false;
    clearTimeout(idleTimer);
    if (old) old.kill();
  }
  function finish(error, result) {
    const job = active;
    if (!job) return;
    active = null;
    clearTimeout(timer);
    if (error) job.reject(error); else job.resolve(result);
    pump();
  }
  function deadline() {
    clearTimeout(timer);
    timer = setTimeout(() => { stopWorker(); finish(new Error("Writing out the speech took too long.")); }, timeoutMs);
  }
  function dispatch() { if (active && ready) worker.send({ id: active.id, audio: active.audio, timestamps: active.timestamps }); }
  function startWorker() {
    const instance = spawn(path.join(__dirname, "../speech/listen-worker.js"), {
      serialization: "advanced", stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { PATH: process.env.PATH || "", LANG: process.env.LANG || "en_US.UTF-8" },
    });
    worker = instance;
    instance.on("message", (msg) => {
      if (worker !== instance) return;
      if (msg.type === "ready") { ready = true; dispatch(); return; }
      if (!active || msg.id !== active.id) return;
      if (msg.type === "progress") deadline();
      else if (msg.type === "done") finish(null, { language: msg.language, lines: msg.lines, text: msg.text });
      else if (msg.type === "error") {
        console.error("[listen] Transcription failed:", msg.error);
        stopWorker();
        finish(new Error("Couldn't write out the speech."));
      }
    });
    const failed = (error) => {
      if (worker !== instance) return;
      console.error("[listen] Worker failed:", error.message);
      stopWorker();
      finish(new Error("Speech to text couldn't start."));
    };
    instance.on("error", failed);
    instance.on("exit", (code) => failed(new Error(`Listening worker exited (${code})`)));
    // Two cores: four wrote out a sentence faster on a quiet computer, but
    // slower while Closedhand was also indexing, which is most of the time.
    instance.send({ type: "init", directory, threads: Math.max(1, Math.min(2, Math.floor(os.cpus().length / 2))) });
  }
  // The model is released a while after its last use: idleMs, or longer
  // while warm() asked for it to be kept.
  function idle() {
    clearTimeout(idleTimer);
    worker?.unref();
    idleTimer = setTimeout(stopWorker, Math.max(idleMs, keepUntil - Date.now()));
    idleTimer.unref();
  }
  function pump() {
    if (active) return;
    clearTimeout(idleTimer);
    active = queue.shift() || null;
    if (!active) { idle(); return; }
    deadline();
    try {
      if (!worker) startWorker();
      worker.ref();
      if (ready) dispatch();
    } catch (error) { stopWorker(); finish(error); }
  }
  // 16 kHz mono samples (Float32Array, or 16-bit PCM in a Buffer) to
  // { language, lines: [{ start, text }], text }. timestamps false skips the
  // times of each line, which only a video's transcript needs: a voice note
  // or the mic is written out about a third faster without them.
  function transcribe(audio, { timestamps = true } = {}) {
    try {
      if (!isAvailable()) throw new Error("The built-in speech to text is missing. Update Closedhand to restore it.");
      if (queue.length >= 3) throw new Error("Speech to text is busy. Try again in a moment.");
    } catch (error) { return Promise.reject(error); }
    const samples = audio instanceof Float32Array ? audio : pcm16ToFloat(audio);
    return new Promise((resolve, reject) => { queue.push({ id: ++nextId, audio: samples, timestamps, resolve, reject }); pump(); });
  }
  // Loads the model before the speech arrives, as while someone is still
  // talking into the web chat's mic, and keeps it for keepMs. Loading takes
  // seconds; a loaded model writes out a sentence in about one.
  function warm(keepMs = idleMs) {
    if (!isAvailable()) return false;
    keepUntil = Math.max(keepUntil, Date.now() + keepMs);
    try { if (!worker) startWorker(); } catch (error) { stopWorker(); return false; }
    if (!active) idle();
    return true;
  }
  return { isAvailable, transcribe, warm };
}

function pcm16ToFloat(buffer) {
  const view = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  return Float32Array.from(view, (s) => s / 32768);
}

// A WAV file's samples, for voice notes that arrive as WAV.
function wavSamples(buffer) {
  let i = 12;
  while (i + 8 <= buffer.length) {
    const id = buffer.toString("ascii", i, i + 4), size = buffer.readUInt32LE(i + 4);
    if (id === "data") return pcm16ToFloat(buffer.subarray(i + 8, i + 8 + size));
    i += 8 + size + (size % 2);
  }
  throw new Error("Not a WAV file");
}

module.exports = { ...createListeningService(), createListeningService, pcm16ToFloat, wavSamples, RATE };
