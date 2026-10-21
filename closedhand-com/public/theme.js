// Light or dark. The site follows the device until the person taps the sun
// or moon in the header; then their pick is remembered in this browser.
// Loaded in <head>, before anything is drawn, so a page never shows the other
// theme first. The colours themselves are in interface.css, by name, under
// :root and :root[data-theme="light"].
(function () {
  var KEY = 'closedhand-theme';
  var BAR = { dark: '#100E0D', light: '#EFE6D6' };
  var root = document.documentElement;
  var device = window.matchMedia('(prefers-color-scheme: light)');

  function picked() {
    try { var theme = localStorage.getItem(KEY); return theme === 'light' || theme === 'dark' ? theme : null; } catch (e) { return null; }
  }
  function current() { return picked() || (device.matches ? 'light' : 'dark'); }

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

  apply(current());
  // This runs before the rest of the head is read, so the bar's tags come later.
  document.addEventListener('DOMContentLoaded', function () { bar(current()); });
  // Still following the device: follow it when it changes, too.
  device.addEventListener('change', function () { if (!picked()) apply(current()); });

  window.closedhandTheme = {
    current: current,
    set: function (theme) {
      try { localStorage.setItem(KEY, theme); } catch (e) { /* remembered for this page only */ }
      apply(theme);
    },
  };

  // The sun and moon: the other theme spreads from the button inside a
  // glowing ember ring, the home page's smoke ring, while in the button the
  // sun sets and the moon rises (interface.css). Stars come out on the way
  // to dark; a warm glow comes up on the way to light.
  function sparkle(box, theme) {
    var x = box.left + box.width / 2, y = box.top + box.height / 2;
    var layer = document.createElement('div');
    layer.className = 'theme-sparkle';
    layer.setAttribute('aria-hidden', 'true');
    if (theme === 'dark') {
      for (var i = 0; i < 7; i++) {
        var star = document.createElement('i');
        // Spread round the lower half, where the page is: the header is above.
        var angle = Math.PI * (i + 0.2 + 0.6 * Math.random()) / 7;
        var far = 24 + Math.random() * 48;
        star.style.left = Math.round(x + Math.cos(angle) * far) + 'px';
        star.style.top = Math.round(y + Math.sin(angle) * far * 0.8) + 'px';
        star.style.animationDelay = (320 + Math.random() * 420) + 'ms';
        star.style.setProperty('--size', (0.19 + Math.random() * 0.19).toFixed(2) + 'rem');
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
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('.theme-toggle');
    if (!button) return;
    var next = current() === 'light' ? 'dark' : 'light';
    var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var box = button.getBoundingClientRect();
    if (still) { window.closedhandTheme.set(next); return; }
    sparkle(box, next);
    if (!document.startViewTransition) { window.closedhandTheme.set(next); return; }
    var x = box.left + box.width / 2, y = box.top + box.height / 2;
    var reach = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
    root.style.setProperty('--reveal-x', Math.round(x) + 'px');
    root.style.setProperty('--reveal-y', Math.round(y) + 'px');
    root.style.setProperty('--reveal-r', reach + 'px');
    var ring = document.createElement('div');
    ring.className = 'theme-ring';
    ring.setAttribute('aria-hidden', 'true');
    var shift = document.startViewTransition(function () {
      window.closedhandTheme.set(next);
      document.body.appendChild(ring);
    });
    shift.finished.finally(function () { ring.remove(); });
  });
})();
