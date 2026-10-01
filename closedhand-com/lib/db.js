// Postgres for the closedhand.com service, and the migrations that shape it.
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: url, max: 10 });
  pool.on('error', e => console.error('[db] idle client error:', e.message));
  return pool;
}

// Each file in migrations/ runs once, in name order, inside a transaction.
async function migrate(pool, dir = path.join(__dirname, '..', 'migrations')) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7310042)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log('[db] applied', name);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error('Migration ' + name + ' failed: ' + e.message);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7310042)').catch(() => {});
    client.release();
  }
}

module.exports = { connect, migrate };
