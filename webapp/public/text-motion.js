// Three ways for text to come alive, for any page that wants them: typed out
// the way a person types, a number counting to its value, and scrambled
// characters settling into words. With reduced motion, or once the page asks
// to skip, each one simply shows its final text.
(function () {
  "use strict";

  function still() {
    return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // Types text into el a character at a time, unevenly, pausing after
  // punctuation. opts.skip() returning true finishes it at once.
  async function type(el, text, opts) {
    opts = opts || {};
    var speed = opts.speed || 75, skip = opts.skip || function () { return false; };
    if (still() || skip()) { el.textContent = text; return; }
    el.textContent = "";
    for (var i = 0; i < text.length; i++) {
      if (skip()) { el.textContent = text; return; }
      el.textContent += text[i];
      await wait(speed * (0.55 + Math.random() * 0.9) + (/[,.!?]/.test(text[i]) ? speed * 4 : 0));
    }
  }

  // Counts el from the number it shows to `to`, easing out, in the reader's
  // own number format. Called again mid-count, it carries on from there.
  function tick(el, to, opts) {
    var format = new Intl.NumberFormat().format;
    var from = el._motionValue || 0;
    cancelAnimationFrame(el._motionFrame);
    if (still() || from === to) { el._motionValue = to; el.textContent = format(to); return; }
    var ms = (opts && opts.duration) || 1400, start = performance.now();
    (function step(now) {
      var t = Math.min(1, (now - start) / ms);
      el._motionValue = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      el.textContent = format(el._motionValue);
      if (t < 1) el._motionFrame = requestAnimationFrame(step);
    })(start);
  }

  // Shows text as scrambled characters that settle into place from left to
  // right. Dots, dashes and slashes stay put, so an address keeps its shape.
  function unscramble(el, text, opts) {
    opts = opts || {};
    var skip = opts.skip || function () { return false; };
    if (still() || skip()) { el.textContent = text; return Promise.resolve(); }
    var glyphs = "abcdefghijklmnopqrstuvwxyz0123456789";
    var ms = opts.duration || 1500, start = performance.now(), swapped = 0, shown = "";
    return new Promise(function (resolve) {
      (function step(now) {
        var settled = skip() ? text.length : Math.floor(text.length * Math.min(1, (now - start) / ms));
        // New random characters about twenty times a second, not every frame.
        if (now - swapped > 50 || settled === text.length) {
          swapped = now;
          shown = "";
          for (var i = 0; i < text.length; i++) {
            shown += i < settled || /[.\-:/]/.test(text[i]) ? text[i] : glyphs[Math.floor(Math.random() * glyphs.length)];
          }
          el.textContent = shown;
        }
        if (settled < text.length) requestAnimationFrame(step); else resolve();
      })(start);
    });
  }

  window.TextMotion = { type: type, tick: tick, unscramble: unscramble, still: still, wait: wait };
})();
