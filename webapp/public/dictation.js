// The web chat's mic. The browser records; Closedhand writes it out with its
// own built-in speech to text on the computer running it, the same as a voice
// note from a chat app (POST /api/dictation, lib/dictation.js). So it works in
// every browser, and nobody else hears it: the browser's own dictation sent
// the voice to Apple or Google. Tap to start, tap again to stop, and the words
// land in the message box.
(function (root) {
  'use strict';
  var RATE = 16000;
  var MAX_MS = 2 * 60000;
  var MIN_SECONDS = 0.3;

  // Mono samples at any rate to 16 kHz, each output sample the average of the
  // input samples it covers.
  function downsample(samples, fromRate) {
    if (fromRate === RATE) return samples;
    var step = fromRate / RATE;
    var out = new Float32Array(Math.floor(samples.length / step));
    for (var i = 0; i < out.length; i++) {
      var a = Math.floor(i * step), b = Math.min(samples.length, Math.floor((i + 1) * step));
      if (b <= a) { out[i] = samples[a] || 0; continue; }
      var sum = 0;
      for (var j = a; j < b; j++) sum += samples[j];
      out[i] = sum / (b - a);
    }
    return out;
  }

  // 16 kHz mono samples to the bytes of a 16-bit WAV file.
  function encodeWav(samples) {
    var bytes = new ArrayBuffer(44 + samples.length * 2), v = new DataView(bytes);
    function text(at, s) { for (var i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); }
    text(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    text(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return bytes;
  }

  // Wires the mic button to the message box. The note under the box says
  // what is happening: listening, writing it out, or what went wrong.
  function attach(button, input, note) {
    var Context = root.AudioContext || root.webkitAudioContext;
    var media = root.navigator && root.navigator.mediaDevices;
    if (!button || !input) return;
    if (!Context || !media || !media.getUserMedia) { button.hidden = true; return; }
    var take = null, busy = false, noteTimer = null;

    function say(message, stay) {
      if (!note) return;
      clearTimeout(noteTimer);
      note.textContent = message || '';
      note.hidden = !message;
      if (message && !stay) noteTimer = setTimeout(function () { say(''); }, 8000);
    }
    function look(state) {
      button.classList.toggle('recording', state === 'recording');
      button.classList.toggle('busy', state === 'busy');
      button.setAttribute('aria-pressed', state === 'recording' ? 'true' : 'false');
      var label = state === 'recording' ? 'Stop and write it out' : 'Speak instead of typing';
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    function stop() {
      if (!take) return;
      var t = take;
      take = null;
      clearTimeout(t.timer);
      t.processor.onaudioprocess = null;
      t.processor.disconnect();
      t.source.disconnect();
      t.stream.getTracks().forEach(function (track) { track.stop(); });
      var rate = t.context.sampleRate;
      t.context.close();
      var length = 0;
      t.parts.forEach(function (p) { length += p.length; });
      if (length < rate * MIN_SECONDS) {
        look('idle');
        say('That was too short to hear. Tap the mic, speak, then tap it again.');
        return;
      }
      var all = new Float32Array(length), at = 0;
      t.parts.forEach(function (p) { all.set(p, at); at += p.length; });
      busy = true;
      look('busy');
      say('Writing it out…', true);
      fetch('/api/dictation', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav(downsample(all, rate)) })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) throw new Error(j.error || "Closedhand couldn't write that out just now. Try again, or type it.");
            return j;
          });
        })
        .then(function (j) {
          var words = String(j.text || '').trim();
          if (!words) { say("Closedhand didn't catch any words. Try again a little closer to the mic."); return; }
          input.value = input.value.trim() ? input.value.replace(/\s*$/, ' ') + words : words;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
          say('');
        })
        .catch(function (e) { say(e.message); })
        .then(function () { busy = false; look('idle'); });
    }

    look('idle');
    // Pressing the mic leaves focus where it is: focus would open the box out
    // under the pointer and move the mic before the tap lands, as with attach.
    button.addEventListener('mousedown', function (e) { e.preventDefault(); });
    button.addEventListener('click', function () {
      if (take) { stop(); return; }
      if (busy) return;
      // The speech to text loads while the person talks, not after.
      fetch('/api/dictation/warm', { method: 'POST' }).catch(function () {});
      // Made inside the tap, as phones only let sound start from one.
      var context = new Context();
      media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
        var source = context.createMediaStreamSource(stream);
        var processor = context.createScriptProcessor(4096, 1, 1);
        var parts = [];
        processor.onaudioprocess = function (e) { parts.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
        source.connect(processor);
        processor.connect(context.destination);
        if (context.state === 'suspended') context.resume();
        take = { context: context, stream: stream, source: source, processor: processor, parts: parts, timer: setTimeout(stop, MAX_MS) };
        look('recording');
        say("Listening. Tap the mic again when you're done.", true);
      }).catch(function () {
        context.close();
        say("Closedhand can't hear you yet. Allow the microphone for this page, then tap the mic again.");
      });
    });
  }

  var api = { downsample: downsample, encodeWav: encodeWav, attach: attach, RATE: RATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClosedhandDictation = api;
})(typeof window !== 'undefined' ? window : this);
