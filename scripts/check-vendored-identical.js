#!/usr/bin/env node
// scripts/check-vendored-identical.js — keep the copies of the retrieval
// logic in step.
//
// Each vendored module exists twice per repo (lib/services/ for the bot,
// webapp/ for the dashboard, which is a separate service and cannot import
// from lib/) and there are two repos, so four copies of every piece of code
// that decides what the model sees, and nothing stopping one from drifting.
// The webapp reranker copy was already dead for months without anyone
// noticing, which is what drift looks like when it is silent.
//
// Within a repo the two copies are compared directly, after normalising the
// require paths that must differ. Across repos they are compared through a
// recorded hash in vendored-manifest.json: both repos carry the same manifest,
// so changing the logic in one repo fails its own check until the manifest is
// updated, and then fails the OTHER repo's check until the change is ported.
// That is the part a single-repo check cannot do.
//
//   node scripts/check-vendored-identical.js           verify
//   node scripts/check-vendored-identical.js --update  re-record after a change

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(__dirname, "vendored-manifest.json");

const PAIRS = [
  {
    name: "reranker",
    copies: ["lib/services/reranker.js", "webapp/reranker.js"],
  },
  {
    name: "lexical",
    copies: ["lib/services/lexical.js", "webapp/lexical.js"],
  },
  {
    name: "fact-vectors",
    copies: ["lib/services/fact-vectors.js", "webapp/fact-vectors.js"],
  },
];

function normalise(src, name) {
  // The ONLY differences the copies are allowed to have are the path in the
  // header line and where they require from. Everything else, including
  // comments, must match: a comment that drifts is usually a behaviour that
  // drifted with it.
  return src
    .replace(new RegExp("^// (?:lib/services|webapp)/" + name + "\\.js[^\\n]*", "m"), "// <header>")
    .replace(/require\(["'](?:\.\.\/|\.\/)config["']\)/g, 'require("<config>")')
    .replace(/require(?:\.resolve)?\(["'](?:\.\.\/|\.\/)local-models["']\)/g, 'require("<local-models>")')
    .replace(/\r\n/g, "\n")
    .trim();
}

function hash(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16); }

function main() {
  const update = process.argv[2] === "--update";
  const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch (_) { return {}; }
  })();

  let failed = false;
  const next = {};

  for (const pair of PAIRS) {
    const present = pair.copies.filter(c => fs.existsSync(path.join(ROOT, c)));
    if (present.length === 0) continue;
    if (present.length !== pair.copies.length) {
      console.error(`MISSING copy of "${pair.name}": expected ${pair.copies.join(", ")}, found ${present.join(", ")}`);
      failed = true;
      continue;
    }

    const hashes = present.map(c => ({ file: c, h: hash(normalise(fs.readFileSync(path.join(ROOT, c), "utf8"), pair.name)) }));
    const distinct = [...new Set(hashes.map(x => x.h))];
    if (distinct.length > 1) {
      console.error(`DRIFT within this repo for "${pair.name}":`);
      for (const x of hashes) console.error(`  ${x.file}  ${x.h}`);
      console.error("  The two copies must stay behaviourally identical. Port the change to both.");
      failed = true;
      continue;
    }

    const local = distinct[0];
    next[pair.name] = local;
    const recorded = manifest[pair.name];
    if (!update && recorded && recorded !== local) {
      console.error(`DRIFT from the recorded version for "${pair.name}": ${local}, manifest says ${recorded}.`);
      console.error("  If this change is intended, run --update HERE and apply the same change plus the");
      console.error("  same manifest to the other repo. The other repo's check will fail until you do,");
      console.error("  which is the point.");
      failed = true;
    } else if (!update && !recorded) {
      console.error(`No recorded hash for "${pair.name}". Run --update.`);
      failed = true;
    }
  }

  if (update) {
    fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + "\n");
    console.log("recorded: " + JSON.stringify(next));
    return;
  }
  if (failed) process.exit(1);
  console.log("OK: vendored copies match each other and the recorded version.");
}

main();
