// lib/migrations.js — apply pending schema changes at boot (self-host only).
//
// The problem this exists for: docker-compose mounts 000_baseline_schema.sql
// into docker-entrypoint-initdb.d, which Postgres runs exactly once, on an
// empty data volume. Nothing else applied DDL anywhere, so any schema change
// shipped after someone installed would never reach them. Their install would
// keep running against the schema it was born with, and the first feature
// needing a new column or index would fail on every existing install while
// working perfectly on every new one.
//
// Two rules keep this simple enough to trust:
//
//   1. Files numbered below RUNNER_FLOOR are baseline-managed. They are the
//      historical migrations already folded into 000_baseline_schema.sql, so
//      re-running them would fail on "already exists". The runner ignores them
//      entirely rather than trying to guess what a given install has.
//
//   2. Runner-managed migrations MUST be idempotent (IF NOT EXISTS, OR
//      REPLACE). A fresh install gets the DDL from the baseline AND then sees
//      the migration as pending, so it will run against a schema that already
//      has the change. Idempotence is what makes that a no-op instead of a
//      crash, and it also makes a half-applied file safe to retry.
//
// Statements run one at a time and outside any explicit transaction, because
// CREATE INDEX CONCURRENTLY cannot run inside one. A file that fails leaves
// itself unrecorded and is retried next boot.

const fs = require("fs");
const path = require("path");

// Migrations numbered from here up are applied by this runner. Everything
// below predates it and lives in the baseline.
const RUNNER_FLOOR = 30;

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Split SQL into individual statements. Naive splitting on ";" corrupts
// function bodies, which are dollar-quoted and full of semicolons, so track
// the quoting state and only break at top level.
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  let dollarTag = null; // e.g. "$$" or "$body$" while inside one
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);

    if (inLineComment) {
      buf += ch;
      if (ch === "\n") inLineComment = false;
      i++; continue;
    }
    if (inBlockComment) {
      buf += ch;
      if (rest.startsWith("*/")) { buf += "/"; i += 2; inBlockComment = false; continue; }
      i++; continue;
    }
    if (dollarTag) {
      if (rest.startsWith(dollarTag)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += ch; i++; continue;
    }
    if (inSingle) {
      buf += ch;
      if (ch === "'") inSingle = false;
      i++; continue;
    }
    if (rest.startsWith("--")) { buf += ch; inLineComment = true; i++; continue; }
    if (rest.startsWith("/*")) { buf += ch; inBlockComment = true; i++; continue; }
    if (ch === "'") { buf += ch; inSingle = true; i++; continue; }

    const dollar = rest.match(/^\$[A-Za-z_]*\$/);
    if (dollar) { dollarTag = dollar[0]; buf += dollarTag; i += dollarTag.length; continue; }

    if (ch === ";") { out.push(buf.trim()); buf = ""; i++; continue; }
    buf += ch; i++;
  }
  if (buf.trim()) out.push(buf.trim());
  // Drop entries that are only comments or whitespace: a trailing comment
  // block after the last semicolon would otherwise be sent to Postgres as a
  // statement and error.
  return out.filter(s =>
    s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().length > 0);
}

function runnerManaged(filename) {
  const m = filename.match(/^(\d{3})_.*\.sql$/);
  if (!m) return false;
  return Number(m[1]) >= RUNNER_FLOOR;
}

/**
 * Apply any runner-managed migrations this database has not recorded.
 * No-ops on the hosted (Supabase) driver, which has its own migration path.
 * Never throws: a broken migration must not stop the bot from booting.
 */
async function runPendingMigrations() {
  let pool;
  try {
    const { supabase } = require("../user-store");
    pool = supabase && supabase._pool;
  } catch (_) { return; }
  // Only the vanilla-pg driver exposes a pool. On Supabase this is undefined
  // and schema changes are applied through Supabase itself.
  if (!pool) return;

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const { rows } = await pool.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map(r => r.filename));

    let files = [];
    try { files = fs.readdirSync(MIGRATIONS_DIR); } catch (_) { return; }
    const pending = files.filter(runnerManaged).filter(f => !applied.has(f)).sort();
    if (!pending.length) return;

    console.log(`[migrations] ${pending.length} pending: ${pending.join(", ")}`);
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const statements = splitStatements(sql);
      try {
        for (const stmt of statements) {
          if (!stmt.replace(/--[^\n]*/g, "").trim()) continue;
          await pool.query(stmt);
        }
        await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
        console.log(`[migrations] applied ${file}`);
      } catch (e) {
        // Left unrecorded on purpose: the next boot retries it. Migrations are
        // required to be idempotent precisely so a retry is safe.
        console.error(`[migrations] ${file} failed, will retry next boot: ${e.message}`);
        return;
      }
    }
  } catch (e) {
    console.error(`[migrations] runner error: ${e.message}`);
  }
}

module.exports = { runPendingMigrations, _internals: { splitStatements, runnerManaged, RUNNER_FLOOR } };
