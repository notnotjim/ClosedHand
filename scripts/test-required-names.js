// Every name taken from one of Closedhand's own modules is one that module
// gives. A name a module stopped exporting comes back undefined with no error
// until the line that uses it runs: user-store.js kept two file-type lists
// that lib/files.js had dropped, and every load of a person with a saved chat
// attachment failed. This reads the code, so it needs nothing installed and
// starts no module. A module whose exports it can't read for certain (a
// spread, an Object.assign, exports built at run time) is left out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = /^(desktop\/\.cache|node_modules|closedhand-com\/node_modules)\//;

// Top-level pieces of a list, split on commas outside brackets and quotes.
function pieces(body) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { cur += c; if (c === '\\') { cur += body[++i] || ''; } else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if ('{[('.includes(c)) depth++;
    if ('}])'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()).filter(Boolean);
}

// The body of the braces opening at `start`.
function braced(src, start) {
  let depth = 0, quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return null; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) return null; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return null;
}

// What a module exports, or null when that can't be read from its text.
const exportsCache = new Map();
function exportedNames(file) {
  if (exportsCache.has(file)) return exportsCache.get(file);
  const src = fs.readFileSync(file, 'utf8');
  let names = new Set();
  const literal = [...src.matchAll(/^module\.exports\s*=\s*\{/gm)];
  const other = [...src.matchAll(/^module\.exports\s*=\s*[^\s{]/gm)];
  if (other.length || /Object\.assign\(\s*module\.exports|module\.exports\[/.test(src) || /^\s*(export |import )/m.test(src)) names = null;
  for (const m of literal) {
    if (!names) break;
    const body = braced(src, m.index + m[0].length - 1);
    if (body == null) { names = null; break; }
    for (const p of pieces(body)) {
      if (p.startsWith('...')) { names = null; break; }
      const key = /^(?:async\s+)?\*?\s*(?:get\s+|set\s+)?["']?([A-Za-z_$][\w$]*)["']?\s*(?:[:(]|$)/.exec(p);
      if (!key) { names = null; break; }
      names.add(key[1]);
    }
  }
  if (names) for (const m of src.matchAll(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm)) names.add(m[1]);
  if (names && !names.size) names = null;
  exportsCache.set(file, names);
  return names;
}

function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const f of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

test('every name taken from a local module is one it exports', () => {
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && !SKIP.test(f));
  const missing = [];
  let checked = 0;
  for (const rel of files) {
    const file = path.join(ROOT, rel);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)(?!\s*[.[])/g)) {
      const target = resolveLocal(file, m[2]);
      if (!target || !target.endsWith('.js')) continue;
      const names = exportedNames(target);
      if (!names) continue;
      for (const p of pieces(m[1])) {
        if (p.startsWith('...')) continue;
        const name = /^([A-Za-z_$][\w$]*)/.exec(p)?.[1];
        if (!name) continue;
        checked++;
        if (!names.has(name)) missing.push(`${rel} takes ${name} from ${path.relative(ROOT, target)}, which doesn't export it`);
      }
    }
  }
  assert.ok(checked > 500, `only ${checked} names were checked; the reading above has stopped finding them`);
  assert.deepEqual(missing, []);
});
