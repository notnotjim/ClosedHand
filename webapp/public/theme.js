// Light or dark, as the person picked with the sun and moon at the top of the
// web chat and the dashboard: the server puts the pick on <html
// data-theme-pick> when it serves a page (the device's own when there is
// none), and this, loaded first in every page's head, sets data-theme before
// anything is drawn. The colours themselves are
// in interface.css, by name, under :root and :root[data-theme="light"].
// Switching plays closedhand.com's transition (its theme.js): the other theme
// spreads from the control inside a glowing ember ring, stars come out on the
// way to dark and a warm glow comes up on the way to light.
(function () {
  var BAR = { dark: '#100E0D', light: '#EFE6D6' };
  var root = document.documentElement;
  var device = window.matchMedia('(prefers-color-scheme: light)');

  function pick() {
    var given = root.getAttribute('data-theme-pick');
    return given === 'light' || given === 'dark' ? given : 'device';
  }
  function current() {
    var p = pick();
    return p === 'device' ? (device.matches ? 'light' : 'dark') : p;
  }
  // The browser bar takes the page's colour: one theme-color, the one in use.
  function bar(theme) {
    var bars = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < bars.length; i++) {
      if (i) { bars[i].remove(); continue; }
      bars[i].removeAttribute('media');
      bars[i].setAttribute('content', BAR[theme]);
    }
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    bar(theme);
    root.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  // The dashboard, in its frame over the web chat, takes the web chat's pick,
  // even one made a moment ago and not yet kept.
  try { if (window.parent !== window && window.parent.closedhandTheme) root.setAttribute('data-theme-pick', window.parent.closedhandTheme.pick()); } catch (e) { /* not the web chat's frame */ }
  apply(current());
  // This runs before the rest of the head is read, so the bar's tag comes later.
  document.addEventListener('DOMContentLoaded', function () { bar(current()); });
  // Matching the device follows it when it changes, too.
  device.addEventListener('change', function () { if (pick() === 'device') apply(current()); });

  function sparkle(x, y, theme) {
    var layer = document.createElement('div');
    layer.className = 'theme-sparkle';
    layer.setAttribute('aria-hidden', 'true');
    if (theme === 'dark') {
      for (var i = 0; i < 7; i++) {
        var star = document.createElement('i');
        // Spread round the lower half, below the control.
        var angle = Math.PI * (i + 0.2 + 0.6 * Math.random()) / 7;
        var far = 24 + Math.random() * 48;
        star.style.left = Math.round(x + Math.cos(angle) * far) + 'px';
        star.style.top = Math.round(y + Math.sin(angle) * far * 0.8) + 'px';
        star.style.animationDelay = (320 + Math.random() * 420) + 'ms';
        star.style.setProperty('--size', (3 + Math.random() * 3).toFixed(1) + 'px');
        layer.appendChild(star);
      }
    } else {
      var glow = document.createElement('b');
      glow.style.left = Math.round(x) + 'px';
      glow.style.top = Math.round(y) + 'px';
      layer.appendChild(glow);
    }
    document.body.appendChild(layer);
    setTimeout(function () { layer.remove(); }, 1900);
  }

  // A new pick, from the point on screen it was made at ({ x, y }, or the
  // top right): the page changes inside the ring, or at once with reduced
  // motion or without view transitions.
  function setPick(next, from) {
    var before = current();
    root.setAttribute('data-theme-pick', next);
    var after = current();
    if (after === before) return;
    var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var x = from && isFinite(from.x) ? from.x : innerWidth - 40, y = from && isFinite(from.y) ? from.y : 40;
    if (still) { apply(after); return; }
    sparkle(x, y, after);
    if (!document.startViewTransition) { apply(after); return; }
    var reach = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
    root.style.setProperty('--reveal-x', Math.round(x) + 'px');
    root.style.setProperty('--reveal-y', Math.round(y) + 'px');
    root.style.setProperty('--reveal-r', reach + 'px');
    var ring = document.createElement('div');
    ring.className = 'theme-ring';
    ring.setAttribute('aria-hidden', 'true');
    var shift = document.startViewTransition(function () {
      apply(after);
      document.body.appendChild(ring);
    });
    shift.finished.finally(function () { ring.remove(); });
  }

  // The dashboard opens in a frame over the web chat: it follows a new pick
  // at once, without a switch of its own.
  function follow(next) {
    root.setAttribute('data-theme-pick', next);
    apply(current());
  }

  // The sun and moon flip to the other theme from where they were pressed,
  // and the pick is kept in the person's settings, so every page and every
  // device opens in it. The same control as closedhand.com's.
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('.theme-toggle');
    if (!button) return;
    var was = pick(), next = current() === 'light' ? 'dark' : 'light';
    var box = button.getBoundingClientRect();
    var frames = function (to) {
      var frame = document.getElementById('dashIframe');
      try { if (frame && frame.contentWindow.closedhandTheme) frame.contentWindow.closedhandTheme.follow(to); } catch (e) { /* not loaded yet */ }
    };
    setPick(next, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
    frames(next);
    fetch('/api/settings/appearance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick: next }) })
      .then(function (r) { if (!r.ok) throw new Error('not saved'); })
      .catch(function () { setPick(was); frames(was); });
  });

  window.closedhandTheme = { current: current, pick: pick, setPick: setPick, follow: follow };
})();
