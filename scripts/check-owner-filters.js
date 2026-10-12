// Every database query in the dashboard that picks a person's record by its
// id also names its owner, so no route can read, change or delete someone
// else's record by guessing or swapping an id (insecure direct object
// reference). The tables that hold a person's records are the ones with a
// user_id column in migrations/, read fresh on each run. A query that picks
// by id (or by a record's own external id) without .eq("user_id", ...) fails
// this check unless it is listed below with the reason it is safe.
//
// Run: node scripts/check-owner-filters.js   (exit 1 lists each offender)
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

function ownedTables() {
  const owned = new Set();
  for (const f of fs.readdirSync(path.join(root, "migrations")).filter((n) => n.endsWith(".sql"))) {
    const sql = fs.readFileSync(path.join(root, "migrations", f), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) if (/\buser_id\b/.test(m[2])) owned.add(m[1]);
    for (const m of sql.matchAll(/ALTER TABLE\s+(?:public\.)?(\w+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+user_id/gi)) owned.add(m[1]);
  }
  return owned;
}

// Every webapp file that answers a route.
const FILES = fs.readdirSync(path.join(root, "webapp")).filter((n) => n.endsWith(".js") && /\bapp\.(get|post|put|patch|delete)\(/.test(fs.readFileSync(path.join(root, "webapp", n), "utf8"))).map((n) => "webapp/" + n);

// Queries that pick by id without the owner, and why each is safe. Matched on
// the file and a piece of the query's own text.
const ALLOWED = [
  { file: "webapp/server.js", match: '.from("user_mcps").update(mcpClient.sealRow(patch)).eq("id", row.id)', why: "saves sign-in details to the tool server row the owner's own query loaded moments before" },
  { file: "webapp/server.js", match: '.from("user_mcps").update(patch).eq("id", id)', why: "start-up job that seals every stored credential once; no request supplies the id" },
];

function check() {
  const owned = ownedTables();
  const offenders = [];
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of src.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)/g)) {
      const table = m[1];
      if (!owned.has(table)) continue;
      // The query runs from .from( to the end of its statement.
      const end = src.indexOf(";", m.index);
      const chain = src.slice(m.index, end === -1 ? undefined : end);
      const byId = /\.(eq|in)\(\s*["'](id|external_id|token_hash)["']/.test(chain);
      if (!byId || /\.(eq|in)\(\s*["']user_id["']/.test(chain)) continue;
      if (/\.insert\(/.test(chain)) continue; // a new row carries its owner in the row itself
      const line = src.slice(0, m.index).split("\n").length;
      if (ALLOWED.some((a) => a.file === file && chain.includes(a.match))) continue;
      offenders.push(`${file}:${line} ${table}: ${chain.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  return { owned, offenders };
}

if (require.main === module) {
  const { owned, offenders } = check();
  if (offenders.length) {
    console.error(`Picked by id without its owner (${offenders.length}):\n  ` + offenders.join("\n  "));
    process.exit(1);
  }
  console.log(`OK: every query that picks a person's record by id also names its owner (${owned.size} tables).`);
}

module.exports = { check, ownedTables };
