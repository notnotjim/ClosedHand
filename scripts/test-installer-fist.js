// The installer's opening screen. The fist is painted in the brand's cream as
// the install runs, one brush stroke as far along as the install has got.
// macOS Terminal draws block characters short of their cell, so there the
// large fist is coloured spaces only; the small one, and every other terminal,
// use half blocks at the stroke's edges. Runs the installer's own drawing code at a
// given terminal size, with tput answered by the test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const install = path.join(__dirname, '..', 'install.sh');
const drawing = fs.readFileSync(install, 'utf8').match(/# --- The drawing[\s\S]*?(?=# --- Preconditions)/)[0]
  .replace('if [ ! -t 1 ] || [ "${TERM:-dumb}" = "dumb" ]; then return 0; fi', '')
  .replace(/^  trap .*$/gm, '').replace("printf '\\033[?25l\\n'", '');

// opts: clock (seconds), os (uname), ssh, display: the computer the screen thinks it is on;
// pct, how far the install has got; colorterm, what the terminal says of its colours.
function screen(cols, lines, termProgram, log = '/dev/null', opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fist-'));
  const file = path.join(dir, 'draw.sh');
  fs.writeFileSync(file, `tput() { case "$1" in cols) echo ${cols} ;; lines) echo ${lines} ;; colors) echo 256 ;; esac; }
date() { echo ${opts.clock || 0}; }
uname() { echo ${opts.os || 'Darwin'}; }
say() { printf '%s\\n' "$*"; }
LOG=${log}
${drawing}
ui_init
[ "$UI" = "1" ] || { echo PLAIN; exit 0; }
ui_draw ${opts.pct ?? 3} "Getting the code"
`);
  const env = { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TERM_PROGRAM: termProgram };
  if (opts.colorterm) env.COLORTERM = opts.colorterm;
  if (opts.ssh) env.SSH_CONNECTION = '10.0.0.2 50000 10.0.0.1 22';
  if (opts.display) env.DISPLAY = ':0';
  const out = execFileSync('sh', [file], { env }).toString();
  fs.rmSync(dir, { recursive: true });
  return out;
}
// The fist is drawn in cream: 256-colour 230, or the brand's own where the
// terminal takes any colour. The bar's green is not part of it.
const INK = /\x1b\[(?:38|48);(?:5;230|2;239;230;214)m/;
const fist = out => out.split('\n').filter(l => INK.test(l));
// How many pixels of the fist are painted: a coloured space is two in half-block
// cells and one in macOS Terminal's large drawing; a half block is one.
const painted = (out, spaces) => fist(out).join('').split(/(\x1b\[[0-9;]*m)/).reduce((n, part, i, all) => {
  if (!/^\x1b\[(?:38|48);(?:5;230|2;239;230;214)m$/.test(part)) return n;
  const next = all[i + 1] || '';
  return n + (part.includes('[48;') ? (spaces ? next.length / 2 : next.length * 2) : next.length);
}, 0);
// The art itself: rows with ink and pixels with ink, in the 32 and 64 wide pictures.
const art = (name, width) => {
  const fr = fs.readFileSync(install, 'utf8').match(new RegExp(`^${name}='([^']*)'$`, 'm'))[1];
  const px = []; for (const [, n, ch] of fr.matchAll(/(\d+)([a-y])/g)) for (let k = 0; k < +n; k++) px.push(ch.charCodeAt(0) - 97);
  const rows = []; for (let y = 0; y * width < px.length; y++) rows.push(px.slice(y * width, (y + 1) * width));
  return { rows, ink: px.filter(v => v > 0).length };
};

test('macOS Terminal gets the large fist in coloured spaces only', () => {
  const out = screen(102, 43, 'Apple_Terminal', '/dev/null', { pct: 100 });
  const { rows, ink } = art('HAND_FIST_32', 32);
  assert.equal(fist(out).length, rows.filter(r => r.some(v => v > 0)).length, 'every row with ink, one pixel tall');
  for (const l of fist(out)) assert.doesNotMatch(l, /[\u2580-\u259f]/, 'no block characters');
  assert.equal(painted(out, true), ink, 'finished, every pixel of the fist is painted');
});

test('the small fist, and every other terminal, use half blocks only at the edges of the stroke', () => {
  assert.deepEqual(fist(screen(80, 24, 'Apple_Terminal', '/dev/null', { pct: 100 })), fist(screen(80, 24, 'vscode', '/dev/null', { pct: 100 })));
  for (const [cols, lines, name, width] of [[80, 24, 'HAND_FIST_32', 32], [140, 36, 'HAND_FIST_32', 32], [102, 43, 'HAND_FIST_64', 64]]) {
    const out = screen(cols, lines, 'vscode', '/dev/null', { pct: 100 });
    const lines_ = fist(out);
    assert.ok(lines_.some(l => /[\u2580\u2584]/.test(l)));
    assert.ok(!lines_.some(l => l.includes('\u2588')), 'a cell inked top and bottom is a coloured space, which leaves no seam');
    assert.equal(painted(out, false), art(name, width).ink);
  }
});

test('the fist is painted along its stroke as the install runs, and finished at 100%', () => {
  const at = pct => painted(screen(102, 43, 'vscode', '/dev/null', { pct }), false);
  const steps = [3, 25, 50, 75, 100].map(at);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1], `more is painted at each step: ${steps}`);
  assert.ok(steps[0] > 0 && steps[0] < steps[4] / 10, 'it starts with a touch of the brush');
  assert.equal(steps[4], art('HAND_FIST_64', 64).ink);
});

test("the fist is cream, the brand's own where the terminal takes any colour, and never grey", () => {
  const plain = screen(102, 43, 'vscode', '/dev/null', { pct: 100 });
  assert.match(plain, /\x1b\[38;5;230m/);
  assert.doesNotMatch(plain, /\x1b\[(?:38|48);5;(?:23[2-9]|24\d|25[0-5])m/, 'no greys');
  assert.match(screen(102, 43, 'vscode', '/dev/null', { pct: 100, colorterm: 'truecolor' }), /\x1b\[38;2;239;230;214m/);
});

test('the screen never says there is no account', () => {
  const out = screen(80, 24, 'Apple_Terminal');
  assert.match(out, /A personal AI assistant you actually own\n/);
  assert.match(out, /Your data stays with you\./);
  assert.doesNotMatch(out, /anonymous/i, 'what comes after installing is not anonymous, so the screen never says it is');
  assert.doesNotMatch(fs.readFileSync(install, 'utf8'), /account required/i);
});

test('the closing line alternates every 8 seconds with when setup opens, only where a browser will open', () => {
  const data = /Your data stays with you\./, setup = /Setup opens in your browser when installation is done\./;
  assert.match(screen(80, 24, 'vscode', '/dev/null', { clock: 0 }), data);
  assert.match(screen(80, 24, 'vscode', '/dev/null', { clock: 8 }), setup);
  assert.match(screen(80, 24, 'vscode', '/dev/null', { clock: 16 }), data);
  // The last second before a change is faint, so the line fades across.
  assert.ok(screen(80, 24, 'vscode', '/dev/null', { clock: 7 }).includes('\x1b[2mYour data stays with you.'));
  assert.ok(!screen(80, 24, 'vscode', '/dev/null', { clock: 3 }).includes('\x1b[2m'));
  // No browser opens over SSH or on Linux without a desktop, so it never says one will.
  assert.doesNotMatch(screen(80, 24, 'vscode', '/dev/null', { clock: 8, ssh: true }), setup);
  assert.doesNotMatch(screen(80, 24, 'vscode', '/dev/null', { clock: 8, os: 'Linux' }), setup);
  const desktop = screen(80, 24, 'vscode', '/dev/null', { clock: 8, os: 'Linux', display: true });
  if (/xdg-open/.test(execFileSync('sh', ['-c', 'command -v xdg-open || true']).toString())) assert.match(desktop, setup);
  // The opening itself asks the same question.
  assert.match(fs.readFileSync(install, 'utf8'), /OPENED=0\nif browser_here; then/);
});

test('what is finished shows green: the filled bar and each ticked box, still centred', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-log-'));
  const log = path.join(dir, 'install.log');
  fs.writeFileSync(log, 'Image ghcr.io/notnotjim/closedhand-bot:latest Pulling\nImage ghcr.io/notnotjim/closedhand-bot:latest Pulled\nImage ghcr.io/notnotjim/closedhand-webapp:latest Pulling\n');
  const out = screen(102, 43, 'Apple_Terminal', log);
  fs.rmSync(dir, { recursive: true });
  const green = '\x1b[38;5;108m', reset = '\x1b[0m';
  const bar = out.split('\n').find(l => l.includes('\u2591'));
  assert.ok(bar.includes(green + '\u2588'), 'the filled part is green');
  assert.ok(bar.indexOf(reset) < bar.indexOf('\u2591'), 'the rest of the bar is not');
  const ticks = out.split('\n').find(l => l.includes('] assistant'));
  assert.ok(ticks.includes('[ ' + green + 'x' + reset + ' ] assistant'), 'the tick is green');
  assert.match(ticks, /\[\.\.?\.? *\] dashboard/, 'a box still coming is not');
  // Centred on what shows, not on the colour codes.
  const shown = ticks.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const pad = shown.length - shown.trimStart().length, text = shown.trim().length;
  assert.ok(Math.abs(pad - Math.floor((101 - (text + 3)) / 2)) <= 2, 'centred');
});
