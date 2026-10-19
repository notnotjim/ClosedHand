// The web chat's mic. The browser records; Closedhand writes it out with its
// own built-in speech to text on the computer running it, the same as a voice
// note from a chat app (POST /api/dictation, lib/dictation.js). So it works in
// every browser, and nobody else hears it: the browser's own dictation sent
// the voice to Apple or Google. Tap to start, tap again to stop, and the words
// land in the message box, or, for talking (the phone's fist), are sent.
(function (root) {
  'use strict';
  var RATE = 16000;
  var MAX_MS = 2 * 60000;
  var MIN_SECONDS = 0.3;
  // Louder than this somewhere, or nothing reached the microphone: a phone
  // can hand over silence (just after its permission question, say), and
  // speech to text writes silence out as a stray "you".
  var HEARD = 0.004;

  function loudest(parts) {
    var peak = 0;
    for (var p = 0; p < parts.length; p++) {
      var s = parts[p];
      for (var i = 0; i < s.length; i++) { var v = s[i] < 0 ? -s[i] : s[i]; if (v > peak) peak = v; }
    }
    return peak;
  }

  // Safari on an iPhone asks for the microphone every time unless the site
  // is set to Allow, and a page can't change that. Said once on this device,
  // and only while it would still ask.
  var ALLOW_TIP = "Safari asks for the microphone each time unless you allow it for this site: tap the page menu beside the address, then the three dots, and under Website Settings set Microphone to Allow.";
  function iphoneSafari() {
    var ua = (root.navigator && root.navigator.userAgent) || "";
    return /iPhone|iPad|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  }
  function allowTip(say) {
    try {
      if (!iphoneSafari() || root.localStorage.getItem("closedhand.micAllowTip")) return;
      var perms = root.navigator.permissions;
      if (!perms || !perms.query) return;
      perms.query({ name: "microphone" }).then(function (state) {
        if (state.state !== "prompt") return;
        root.localStorage.setItem("closedhand.micAllowTip", "1");
        say(ALLOW_TIP, true);
      }).catch(function () {});
    } catch (_) {}
  }

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

  // Wires a mic button to the message box. The note says what is happening:
  // listening, writing it out, or what went wrong. opts: send (true, or a
  // function asked each time) sends the words instead of leaving them in the
  // box, calling onWords; onStop runs inside the tap that stops, where a
  // phone lets sound be started for the reply; thing names the button in
  // what the note says; labels { idle, recording } are its name; hints
  // { idle, recording, busy } make the note a line that always shows.
  // Returns false where the browser can't record.
  function attach(button, input, note, opts) {
    opts = opts || {};
    var Context = root.AudioContext || root.webkitAudioContext;
    var media = root.navigator && root.navigator.mediaDevices;
    if (!button || !input) return false;
    if (!Context || !media || !media.getUserMedia) { button.hidden = true; return false; }
    var take = null, busy = false, noteTimer = null;
    var thing = opts.thing || 'the mic';
    var labels = opts.labels || { idle: 'Speak instead of typing', recording: 'Stop and write it out' };
    var hints = opts.hints || null;

    function say(message, stay) {
      if (!note) return;
      clearTimeout(noteTimer);
      var shown = message || (hints ? hints.idle : '');
      note.textContent = shown;
      note.hidden = !shown;
      if (message && !stay) noteTimer = setTimeout(function () { say(''); }, 8000);
    }
    function look(state) {
      button.classList.toggle('recording', state === 'recording');
      button.classList.toggle('busy', state === 'busy');
      button.setAttribute('aria-pressed', state === 'recording' ? 'true' : 'false');
      var label = state === 'recording' ? labels.recording : labels.idle;
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
        say('That was too short to hear. Tap ' + thing + ', speak, then tap it again.');
        return;
      }
      if (loudest(t.parts) < HEARD) {
        look('idle');
        say('No sound came through from the microphone. Tap ' + thing + ' and try again.');
        return;
      }
      var all = new Float32Array(length), at = 0;
      t.parts.forEach(function (p) { all.set(p, at); at += p.length; });
      busy = true;
      look('busy');
      say(hints ? hints.busy : 'Writing it out…', true);
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
          say('');
          var sending = typeof opts.send === 'function' ? opts.send() : !!opts.send;
          if (sending && opts.onWords) opts.onWords(words);
          else input.focus();
          allowTip(say);
        })
        .catch(function (e) { say(e.message); })
        .then(function () { busy = false; look('idle'); });
    }

    look('idle');
    // Pressing the mic leaves focus where it is: focus would open the box out
    // under the pointer and move the mic before the tap lands, as with attach.
    button.addEventListener('mousedown', function (e) { e.preventDefault(); });
    button.addEventListener('click', function () {
      if (take) { if (opts.onStop) opts.onStop(); stop(); return; }
      if (busy) return;
      // The speech to text loads while the person talks, not after, and so
      // does the voice when the reply will be read aloud.
      var sending = typeof opts.send === 'function' ? opts.send() : !!opts.send;
      fetch('/api/dictation/warm' + (sending ? '?voice=1' : ''), { method: 'POST' }).catch(function () {});
      // Made inside the tap, as phones only let sound start from one. Safari
      // picks the recording kind of audio session itself while it records.
      try { if (root.navigator && "audioSession" in root.navigator) root.navigator.audioSession.type = "auto"; } catch (_) {}
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
        say(hints ? hints.recording : "Listening. Tap the mic again when you're done.", true);
      }).catch(function () {
        context.close();
        say("Closedhand can't hear you yet. Allow the microphone for this page, then tap " + thing + ' again.');
      });
    });
    say('');
    return true;
  }

  var api = { downsample: downsample, encodeWav: encodeWav, attach: attach, RATE: RATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClosedhandDictation = api;
})(typeof window !== 'undefined' ? window : this);
