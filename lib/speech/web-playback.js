// Attached only after the existing web-chat authentication succeeds. A voice
// the person connected, when one is on, reads the message out whole; otherwise,
// or when it fails, the built-in voice reads it sentence by sentence.
function attachSpeech(ws, service = require("../services/tts"), userId = null, voice = null) {
  let request = null;
  function send(message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }
  ws.on("close", () => request?.controller.abort());
  return function handleSpeech(msg) {
    if (msg.type === "speech_cancel") {
      if (request && request.id === msg.id) request.controller.abort();
      return true;
    }
    if (msg.type !== "speech") return false;
    if (typeof msg.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(msg.id)) return true;
    request?.controller.abort();
    const current = { id: msg.id, controller: new AbortController() };
    request = current;
    const live = () => request === current && !current.controller.signal.aborted;
    const builtIn = () => service.streamSpeech(msg.text, audio => {
      if (!live()) return;
      send({ type: "speech_chunk", id: current.id, audio: audio.toString("base64") });
    }, { signal: current.controller.signal }).then(() => {
      if (live()) send({ type: "speech_end", id: current.id });
    });
    const work = !userId ? builtIn() : (voice || require("../voice-connections"))
      .speak(msg.text, { userId, target: "browser", builtIn: false }).catch(() => null)
      .then((got) => {
        if (!live()) return null;
        if (!got) return builtIn();
        send({ type: "speech_chunk", id: current.id, audio: got.buffer.toString("base64") });
        send({ type: "speech_end", id: current.id });
        return null;
      });
    work.catch(error => {
      if (live()) send({ type: "speech_error", id: current.id, message: error.message });
    }).finally(() => { if (request === current) request = null; });
    return true;
  };
}
module.exports = { attachSpeech };
