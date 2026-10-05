// The sandbox screen is what a person watching from a phone pays for in
// bytes: every redraw crosses the tunnel. Keep it laptop-sized, and keep
// Chrome's window inside it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const entry = fs.readFileSync(path.join(__dirname, '..', 'sandbox-image', 'entrypoint.sh'), 'utf8');

test('the sandbox screen is laptop-sized and Chrome fits inside it', () => {
  const [, w, h] = entry.match(/Xvfb :99 -screen 0 (\d+)x(\d+)x24/).map(Number);
  assert.ok(w * h <= 1280 * 800, `screen ${w}x${h} is bigger than 1280x800`);
  const windows = [...entry.matchAll(/--window-size=(\d+),(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(windows.length >= 1);
  for (const [ww, wh] of windows) assert.ok(ww <= w && wh <= h, `window ${ww}x${wh} does not fit ${w}x${h}`);
  const status = fs.readFileSync(path.join(__dirname, '..', 'sandbox-image', 'agent', 'server.js'), 'utf8');
  assert.match(status, new RegExp(`resolution: "${w}x${h}"`));
});
