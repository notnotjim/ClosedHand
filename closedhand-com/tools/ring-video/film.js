// Renders the smoke ring frame by frame in Chrome (see make.sh), driven over
// its debugging port, so nothing needs installing besides Chrome.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const [n, radius, outDir, only] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4], process.argv[5]];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-film-'));
  const port = 9500 + Math.floor(Math.random() * 400);
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--allow-file-access-from-files', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  try {
    let tabs;
    for (let i = 0; i < 100 && !tabs; i++) { try { tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json(); } catch { await wait(100); } }
    const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pending = {};
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
      if (m.method === 'Runtime.exceptionThrown') console.log('pageerror', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
      const r = (await send('Runtime.evaluate', { expression, returnByValue: true })).result;
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'the film page failed');
      return r.result.value;
    };
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'file://' + path.join(__dirname, 'film.html') });
    let ready = false;
    for (let i = 0; i < 300 && !ready; i++) { ready = await evaluate('window.ready === true').catch(() => false); if (!ready) await wait(100); }
    if (!ready) throw new Error('the film page never got ready');
    const frames = only ? only.split(',').map(Number) : [...Array(n).keys()];
    for (const i of frames) {
      const url = await evaluate(`window.frame(${i}, ${n}, ${radius})`);
      fs.writeFileSync(path.join(outDir, 'f' + String(i).padStart(4, '0') + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    }
    ws.close();
    console.log('wrote', frames.length);
  } finally {
    await new Promise((r) => { chrome.once('exit', r); chrome.kill(); });
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
