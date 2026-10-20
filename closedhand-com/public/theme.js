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

  // The sun and moon: the other theme spreads from the button in a circle.
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('.theme-toggle');
    if (!button) return;
    var next = current() === 'light' ? 'dark' : 'light';
    var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still || !document.startViewTransition) { window.closedhandTheme.set(next); return; }
    var box = button.getBoundingClientRect();
    root.style.setProperty('--reveal-x', Math.round(box.left + box.width / 2) + 'px');
    root.style.setProperty('--reveal-y', Math.round(box.top + box.height / 2) + 'px');
    document.startViewTransition(function () { window.closedhandTheme.set(next); });
  });
})();
