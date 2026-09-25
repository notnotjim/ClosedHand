import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('.', import.meta.url);
const html = readFileSync(new URL('offline.html', root), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Missing retry script');
const hash = createHash('sha256').update(script).digest('base64');
const code = readFileSync(new URL('worker.mjs', root), 'utf8')
  .replace("import offlineHtml from './offline.html';", 'const offlineHtml = ' + JSON.stringify(html) + ';')
  .replace('YCZ_REPLACE_AT_BUILD', hash);
const output = process.argv[2] || '/tmp/closedhand-phone-edge.mjs';
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, code);
console.log('Built connection page:', fileURLToPath(new URL(output, 'file:///')));
