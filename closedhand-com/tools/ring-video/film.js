// Renders the ring and 3D fist frame by frame in Chrome (see make.sh).
const { chromium } = require(process.env.PW);
const fs = require('fs'), path = require('path');
(async () => {
  const [n, radius, height, depth, outDir, only] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]), process.argv[6], process.argv[7]];
  fs.mkdirSync(outDir, { recursive: true });
  const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('pageerror', e.message));
  p.on('console', m => { if (m.type() === 'error') console.log('console', m.text()); });
  await p.goto('file://' + path.join(__dirname, 'film.html'));
  await p.waitForFunction(() => typeof window.loadFist === 'function');
  await p.evaluate(([svg, h, d]) => window.loadFist(svg, h, d), [fs.readFileSync(path.join(__dirname, 'fist.svg'), 'utf8'), height, depth]);
  await p.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const frames = only ? only.split(',').map(Number) : [...Array(n).keys()];
  for (const i of frames) {
    const url = await p.evaluate(([i, n, rad]) => window.frame(i, n, rad), [i, n, radius]);
    fs.writeFileSync(path.join(outDir, 'f' + String(i).padStart(4, '0') + '.png'), Buffer.from(url.split(',')[1], 'base64'));
  }
  await b.close();
  console.log('wrote', frames.length);
})();
