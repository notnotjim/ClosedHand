// Runs the actual bundled model without an account or external service.
const fs = require('fs');
const path = require('path');
const { createSpeechService } = require('../lib/services/tts');
const { monitorEventLoopDelay } = require('perf_hooks');
const service = createSpeechService({ idleMs: 500 });
const output = process.argv[2] || '/tmp/closedhand-voice';
fs.mkdirSync(output, { recursive: true });
const text = 'Your flight is delayed by two hours. I found your boarding pass and checked your plans for tonight.';
(async () => {
  const histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
  const initial = process.memoryUsage().rss;
  const start = performance.now(); let first = null, seconds = 0, chunks = 0;
  await service.streamSpeech(text, audio => {
    first ??= performance.now() - start;
    seconds += audio.readUInt32LE(40) / 48000;
    fs.writeFileSync(path.join(output, `sample-${++chunks}.wav`), audio);
  });
  const total = performance.now() - start;
  const rss = process.memoryUsage().rss;
  const warmStart = performance.now();
  const ogg = await service.synthesize('Your boarding pass is ready.');
  const warmMs = Math.round(performance.now() - warmStart);
  fs.writeFileSync(path.join(output, 'sample.ogg'), ogg);
  await new Promise(r => setTimeout(r, 1500));
  histogram.disable();
  console.log(JSON.stringify({ firstMs: Math.round(first), totalMs: Math.round(total), audioSeconds: seconds,
    chunks, warmMs, opusBytes: ogg.length, initialRssMB: Math.round(initial / 1048576),
    loadedRssMB: Math.round(rss / 1048576), idleRssMB: Math.round(process.memoryUsage().rss / 1048576),
    eventLoopP99Ms: Math.round(histogram.percentile(99) / 1e6) }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
