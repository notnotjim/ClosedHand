(function () {
  'use strict';
  var context = null;
  var current = null;
  var sequence = 0;
  var speaker = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>';
  var stopIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

  function reset(item, message) {
    if (!item) return;
    item.button.innerHTML = speaker;
    item.button.title = 'Read aloud';
    item.button.setAttribute('aria-label', 'Read aloud');
    item.button.setAttribute('aria-pressed', 'false');
    item.status.textContent = message || '';
    item.button.classList.remove('done');
  }
  function stop(message) {
    var item = current;
    if (!item) return;
    current = null;
    clearTimeout(item.timer);
    item.send({ type: 'speech_cancel', id: item.id });
    item.nodes.forEach(function (node) { try { node.stop(); } catch (_) {} });
    reset(item, message);
  }
  function deadline(item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(function () {
      if (current === item) stop('Reading aloud took too long. Try again.');
    }, 130000);
  }
  function complete(item) {
    if (current === item && item.finished && item.nodes.size === 0 && item.decoding === 0) {
      current = null;
      clearTimeout(item.timer);
      reset(item);
    }
  }
  function addControl(tools, text, send) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-tool';
    var status = document.createElement('span');
    status.className = 'voice-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var control = { button: button, status: status };
    reset(control);
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      if (current && current.button === button) { stop(); return; }
      stop();
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) { status.textContent = 'This browser cannot play the voice.'; return; }
      try {
        // Resume during the tap, so delayed audio also works on mobile browsers.
        context = context || new AudioContext();
        var resumed = context.resume();
        var item = { button: button, status: status, send: send, id: 'voice-' + (++sequence),
          nodes: new Set(), next: 0, finished: false, decoding: 0, chain: Promise.resolve() };
        current = item;
        button.innerHTML = stopIcon;
        button.title = 'Stop reading';
        button.setAttribute('aria-label', 'Stop reading');
        button.setAttribute('aria-pressed', 'true');
        button.classList.add('done');
        status.textContent = 'Preparing voice…';
        resumed.catch(function () { if (current === item) stop('Couldn’t play audio. Tap to try again.'); });
        if (!send({ type: 'speech', id: item.id, text: text })) {
          stop('Connecting. Try again in a moment.');
          return;
        }
        deadline(item);
      } catch (_) { stop('Couldn’t start audio. Tap to try again.'); }
    });
    tools.appendChild(button);
    tools.appendChild(status);
  }
  function receive(message) {
    if (!/^speech_(chunk|end|error)$/.test(message.type || '')) return false;
    var item = current;
    if (!item || item.id !== message.id) return true;
    if (message.type === 'speech_error') { stop(message.message || 'Couldn’t read this reply aloud. Try again.'); return true; }
    if (message.type === 'speech_end') {
      item.finished = true;
      clearTimeout(item.timer);
      complete(item);
      return true;
    }
    deadline(item);
    item.decoding++;
    // Decodes may finish out of order. Preserve the order of spoken sentences.
    item.chain = item.chain.then(async function () {
      if (current !== item) return;
      var bytes = Uint8Array.from(atob(message.audio), function (c) { return c.charCodeAt(0); });
      var buffer = await context.decodeAudioData(bytes.buffer);
      if (current !== item) return;
      var source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      item.nodes.add(source);
      source.onended = function () {
        source.disconnect();
        item.nodes.delete(source);
        complete(item);
      };
      var start = Math.max(context.currentTime + 0.03, item.next);
      source.start(start);
      item.next = start + buffer.duration;
      item.status.textContent = '';
    }).catch(function () {
      if (current === item) stop('Couldn’t play this reply. Tap to try again.');
    }).finally(function () { item.decoding--; complete(item); });
    return true;
  }
  window.addEventListener('pagehide', function () { stop(); });
  window.ClosedHandSpeech = { addControl: addControl, receive: receive, stop: stop };
}());
