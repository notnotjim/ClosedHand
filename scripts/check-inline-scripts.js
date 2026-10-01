#!/usr/bin/env node
// scripts/check-inline-scripts.js — every inline <script> in a shipped HTML
// view must parse.
//
// The dashboard's script lives inline, so a single stray apostrophe inside a
// JS string produces a page that loads, renders, and does nothing at all. That
// shipped twice. `node --check` on the .html file cannot catch it, because the
// file is not JavaScript.
//
// Extracted from the pre-push hook so CI and the hook run the same code rather
// than two copies of it that drift.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const VIEW_DIRS = ["webapp/views"];

function inlineScripts(html) {
  // Skip <script src=...>: there is no inline body to check.
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

let failed = 0;
let checked = 0;

for (const dir of VIEW_DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (!name.endsWith(".html")) continue;
    const file = path.join(full, name);
    const blocks = inlineScripts(fs.readFileSync(file, "utf8"));
    if (!blocks.length) continue;
    checked++;
    // Joined with a semicolon so one block cannot leave the next mid-statement.
    const tmp = path.join(os.tmpdir(), `inline-${name}-${process.pid}.js`);
    fs.writeFileSync(tmp, blocks.join("\n;\n"));
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (e) {
      const msg = (e.stderr || "").toString().split("\n").slice(0, 4).join("\n");
      console.error(`${dir}/${name}: inline script does not parse\n${msg}`);
      failed++;
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
}

if (failed) {
  console.error(`\n${failed} view(s) would ship a dead script.`);
  process.exit(1);
}
console.log(`OK: inline scripts parse in ${checked} view(s).`);
