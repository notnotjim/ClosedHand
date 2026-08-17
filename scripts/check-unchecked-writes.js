#!/usr/bin/env node
// scripts/check-unchecked-writes.js — fail the build on a NEW database write
// whose error is never inspected.
//
// The supabase client does not throw on failure. It resolves with
// { data, error }, so `await supabase.from("connections").update(...)` that
// fails looks exactly like one that succeeded. Every silent failure found in
// the retrieval pass was this shape: an index that never filled, a token that
// never saved, a seed that never landed. The code was not wrong, it just never
// asked.
//
// This is a ratchet, not a cleanup. There are ~150 existing sites and draining
// them is worth far less than stopping the next one, so the current count per
// file is recorded as a baseline and only an INCREASE fails. A decrease prints
// a reminder to re-record, which is how the number comes down over time.
//
//   node scripts/check-unchecked-writes.js           check against baseline
//   node scripts/check-unchecked-writes.js --update  re-record the baseline
//   node scripts/check-unchecked-writes.js --list    print every violation

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BASELINE = path.join(__dirname, "unchecked-writes-baseline.json");
const WRITE_METHODS = ["upsert", "insert", "update", "delete"];
// How far past the statement to look for the error being handled. A checked
// write usually tests it on the next line or two.
const LOOKAHEAD_LINES = 3;

// Replace string, template and comment contents with spaces of equal length.
// Detection then cannot be fooled by a ".delete(" inside a log message, and
// offsets still map back to the original text.
function mask(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const two = src.substr(i, 2);
    if (two === "//") {
      while (i < n && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (two === "/*") {
      while (i < n && src.substr(i, 2) !== "*/") { out += src[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " "; i++;
      while (i < n) {
        if (src[i] === "\\") { out += "  "; i += 2; continue; }
        if (src[i] === quote) { out += " "; i++; break; }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// The statement containing `pos`: back to the previous top-level boundary,
// forward to the semicolon that closes it at depth zero.
function statementAround(masked, pos) {
  let start = pos;
  let depth = 0;
  while (start > 0) {
    const c = masked[start];
    if (c === ")" || c === "}" || c === "]") depth++;
    else if (c === "(" || c === "{" || c === "[") {
      if (depth === 0) { start++; break; }
      depth--;
    } else if (c === ";" && depth === 0) { start++; break; }
    start--;
  }
  let end = pos;
  depth = 0;
  while (end < masked.length) {
    const c = masked[end];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth <= 0) break;
    end++;
  }
  return { start, end: Math.min(end + 1, masked.length) };
}

function violationsIn(file) {
  const src = fs.readFileSync(file, "utf8");
  const masked = mask(src);
  const found = [];
  const seen = new Set();

  let idx = 0;
  while ((idx = masked.indexOf(".from(", idx)) !== -1) {
    const here = idx;
    idx += 6;
    const { start, end } = statementAround(masked, here);
    if (seen.has(start)) continue;
    const stmtMasked = masked.slice(start, end);
    if (!WRITE_METHODS.some(m => stmtMasked.includes("." + m + "("))) continue;
    seen.add(start);

    // Report where the write is, not where its statement began: a multi-line
    // chain that starts on an `if` line points the reader at the wrong thing.
    const lineNo = src.slice(0, here).split("\n").length;
    const stmtReal = src.slice(start, end);
    // The write's own line, not the statement's first line, which is often a
    // comment or an `if` the chain hangs off.
    const writeLine = (src.split("\n")[lineNo - 1] || "").trim().slice(0, 100);

    // `.then(...).catch(...)` is an explicit decision to handle it elsewhere.
    const handledAsPromise = /\.catch\s*\(/.test(stmtMasked);
    if (handledAsPromise) continue;

    // Is the result captured at all? A bare `await supabase.from(...)` has
    // nothing to inspect, so no amount of lookahead can redeem it. Checking
    // this first is what stops a nearby unrelated `error` from excusing it,
    // which is precisely the false negative a naive lookahead produces.
    const assigned = /(const|let|var)\s*(\{[^}]*\}|\w+)\s*=/.test(stmtReal) ||
                     /\breturn\b/.test(stmtReal.slice(0, stmtReal.indexOf(".from(")));
    if (!assigned) {
      found.push({ line: lineNo, text: writeLine });
      continue;
    }

    // Captured: the error counts as inspected if it is named in the statement
    // or within a couple of lines of the statement's END.
    const endLine = src.slice(0, end).split("\n").length;
    const after = src.split("\n").slice(endLine - 1, endLine - 1 + LOOKAHEAD_LINES).join("\n");
    const mentionsError = /\berror\b/.test(stmtReal) || /\berror\b/.test(after);
    if (!mentionsError) {
      found.push({ line: lineNo, text: writeLine });
    }
  }
  return found;
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "data") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

function scan() {
  const counts = {};
  const details = {};
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    const v = violationsIn(file);
    if (v.length) { counts[rel] = v.length; details[rel] = v; }
  }
  return { counts, details };
}

function main() {
  const mode = process.argv[2] || "";
  const { counts, details } = scan();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (mode === "--list") {
    for (const f of Object.keys(details).sort()) {
      console.log(`\n${f} (${details[f].length})`);
      for (const v of details[f]) console.log(`  ${v.line}: ${v.text}`);
    }
    console.log(`\ntotal: ${total}`);
    return;
  }
  if (mode === "--update") {
    fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
    console.log(`baseline recorded: ${total} unchecked writes across ${Object.keys(counts).length} files`);
    return;
  }

  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")); }
  catch (_) {
    console.error("No baseline found. Run: node scripts/check-unchecked-writes.js --update");
    process.exit(1);
  }

  const regressions = [];
  const improvements = [];
  for (const f of Object.keys(counts)) {
    const was = baseline[f] || 0;
    if (counts[f] > was) regressions.push({ file: f, was, now: counts[f], sites: details[f] });
  }
  for (const f of Object.keys(baseline)) {
    const now = counts[f] || 0;
    if (now < baseline[f]) improvements.push(`${f}: ${baseline[f]} -> ${now}`);
  }

  if (improvements.length) {
    console.log("Fewer unchecked writes than the baseline, nice. Re-record with --update:");
    for (const i of improvements) console.log(`  ${i}`);
    console.log();
  }

  if (!regressions.length) {
    console.log(`OK: ${total} unchecked writes, none new.`);
    return;
  }

  console.error("NEW database writes whose error is never inspected:\n");
  for (const r of regressions) {
    console.error(`${r.file}  (was ${r.was}, now ${r.now})`);
    for (const s of r.sites) console.error(`  ${s.line}: ${s.text}`);
  }
  console.error(`
The supabase client resolves with { data, error } instead of throwing, so an
unchecked write that fails is indistinguishable from one that succeeded.

  const { error } = await supabase.from("t").upsert(row);
  if (error) console.error("[thing] write failed:", error.message);

If it is genuinely fire-and-forget, say so with .catch() and this check will
accept it.`);
  process.exit(1);
}

main();
