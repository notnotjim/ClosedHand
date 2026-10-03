// The installer's opening screen. macOS Terminal draws block characters short
// of their cell, so there the large fist must be coloured spaces only; the
// small one, and every other terminal, keep the half blocks. Runs the installer's own drawing code at a
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

// opts: clock (seconds), os (uname), ssh, display: the computer the screen thinks it is on.
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
ui_draw 3 "Getting the code"
`);
  const env = { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TERM_PROGRAM: termProgram };
  if (opts.ssh) env.SSH_CONNECTION = '10.0.0.2 50000 10.0.0.1 22';
  if (opts.display) env.DISPLAY = ':0';
  const out = execFileSync('sh', [file], { env }).toString();
  fs.rmSync(dir, { recursive: true });
  return out;
}
// The fist is drawn in greys (256-colour 232 to 255); the bar's green is not part of it.
const fist = out => out.split('\n').filter(l => /\x1b\[(?:0;)?(?:38|48);5;(?:23[2-9]|24\d|25[0-5])[;m]/.test(l));

test('macOS Terminal gets the large fist in coloured spaces only', () => {
  const lines_ = fist(screen(102, 43, 'Apple_Terminal'));
  assert.equal(lines_.length, 28);
  for (const l of lines_) assert.doesNotMatch(l, /[\u2580-\u259f]/, 'no block characters');
});

test('the small fist, and every other terminal, keep the half blocks as they were', () => {
  assert.deepEqual(fist(screen(80, 24, 'Apple_Terminal')), fist(screen(80, 24, 'vscode')));
  for (const [cols, lines, rows] of [[80, 24, 14], [140, 36, 14], [102, 43, 28]]) {
    const lines_ = fist(screen(cols, lines, 'vscode'));
    assert.equal(lines_.length, rows);
    assert.ok(lines_.some(l => /[\u2580\u2584]/.test(l)));
  }
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
