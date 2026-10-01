#!/usr/bin/env node
// scripts/check-rerank-callers.js — no caller may decide, by counting, whether
// to reorder.
//
// This bug has now appeared twice in the same codebase, and the second time it
// appeared in a file that already carried a comment describing the first:
//
//   brain.js      if (allResults.length > 7) rerank(...) else slice(0, 7)
//   handlers.js   if (results.length > 7 + topK) rerank(...) else slice(7)
//
// Both skip reranking precisely when the candidate set is small, which is when
// ordering is decided by whatever order retrieval happened to produce. With
// RRF that is a tie broken by which arm was appended first, so the wrong item
// reaches the model. The failure is invisible: results still come back, still
// look plausible, and are simply in the wrong order.
//
// rerank() already returns its input untouched when there is nothing to
// reorder, so a count test at a call site cannot be right, only differently
// wrong. This check exists because the comment did not hold.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IGNORE_DIRS = new Set(["node_modules", ".git", "data", "scripts"]);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

// The reranker's own internals legitimately test sizes (it is the thing that
// decides), so it is not a caller and is exempt.
const IS_RERANKER = /(^|\/)reranker\.js$/;

const violations = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (IS_RERANKER.test(rel)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/\brerank\s*\(/.test(line)) return;
    // One rule, not a list of shapes: if a size comparison appears anywhere on
    // the call's line, or in an if() just above it, the caller is deciding by
    // counting. Chasing shapes individually is how the first version of this
    // check passed a ternary straight through.
    const SIZE_TEST = /\.(length|size)\s*(>=|>|<=|<)/;
    const before = lines.slice(Math.max(0, i - 4), i).join("\n");
    const guardedAbove = /\bif\s*\([^)]*\.(length|size)\s*(>=|>|<=|<)/.test(before);
    if (SIZE_TEST.test(line) || guardedAbove) {
      violations.push({ file: rel, line: i + 1, text: line.trim().slice(0, 90) });
    }
  });
}

if (violations.length) {
  console.error("rerank() guarded by a count at the call site:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error(`
Call rerank() unconditionally. It returns the input untouched when there is
nothing to reorder, so the caller has no decision to make, and a count test can
only skip reordering in exactly the cases where order is least determined.`);
  process.exit(1);
}
console.log("OK: no rerank call is gated on a count.");
