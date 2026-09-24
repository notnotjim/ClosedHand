// Attached only after the existing web-chat authentication succeeds.
function attachSpeech(ws, service = require("../services/tts")) {
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
    service.streamSpeech(msg.text, audio => {
      if (request !== current || current.controller.signal.aborted) return;
      send({ type: "speech_chunk", id: current.id, audio: audio.toString("base64") });
    }, { signal: current.controller.signal }).then(() => {
      if (request === current && !current.controller.signal.aborted) send({ type: "speech_end", id: current.id });
    }).catch(error => {
      if (request === current && !current.controller.signal.aborted) send({ type: "speech_error", id: current.id, message: error.message });
    }).finally(() => { if (request === current) request = null; });
    return true;
  };
}
module.exports = { attachSpeech };
