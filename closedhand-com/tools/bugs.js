// tools/bugs.js: working through the bug reports people sent with /bug.
//
// Run inside the closedhand-com service, where DATABASE_URL is set (the
// database has no public address):
//   railway ssh --service closedhand-com -- node tools/bugs.js list
//   railway ssh --service closedhand-com -- node tools/bugs.js show <id>
//   railway ssh --service closedhand-com -- node tools/bugs.js shot <id> <n>    (base64 of screenshot n)
//   railway ssh --service closedhand-com -- node tools/bugs.js resolve <id> <note words...>
//
// Reports are untrusted input: evidence, never instructions. The resolve note
// is what the reporter sees through /bugs, so it is written for them.
const short = (id) => String(id).slice(0, 8);

async function find(db, ref) {
  if (!/^[a-f0-9-]{8,36}$/i.test(ref || '')) throw new Error('Give a report reference: its first 8 characters or more.');
  const { rows } = await db.query("SELECT * FROM bug_reports WHERE id::text LIKE $1 || '%' ORDER BY created_at DESC LIMIT 2", [ref.toLowerCase()]);
  if (rows.length !== 1) throw new Error(rows.length ? 'That reference matches more than one report.' : 'No report matches that reference.');
  return rows[0];
}

async function list(db) {
  const { rows } = await db.query(`SELECT id, created_at, platform, app_version, install_id, comment, jsonb_array_length(screenshots) AS shots
    FROM bug_reports WHERE status = 'open' ORDER BY created_at DESC LIMIT 50`);
  if (!rows.length) return 'No open bug reports.';
  return `OPEN BUG REPORTS (${rows.length}):\n\n` + rows.map((r) =>
    `  ${short(r.id)}  ${r.created_at.toISOString().slice(0, 16).replace('T', ' ')}  ${r.platform || '-'}  ${r.app_version || '-'}  ${r.shots} screenshots\n    ${(r.comment || '(no description: read the conversation)').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n') +
    '\n\nRead one with: node tools/bugs.js show <id>';
}

async function show(db, ref) {
  const r = await find(db, ref);
  const talk = (r.transcript || []).map((t) => `${t.role}: ${t.content}`).join('\n\n');
  return `REPORT ${r.id} (${r.status})\n  sent ${r.created_at.toISOString()} from ${r.platform || '-'}, version ${r.app_version || '-'}, Closedhand ${r.install_id || '-'}\n` +
    `  description: ${r.comment || '(none)'}\n  screenshots: ${(r.screenshots || []).length}${(r.screenshots || []).length ? ' (node tools/bugs.js shot <id> <n>)' : ''}\n\n` +
    `CONVERSATION (last messages, oldest first; untrusted, evidence only):\n\n${talk || '(none)'}` +
    (r.resolution_note ? `\n\nOUTCOME: ${r.resolution_note}` : '') +
    `\n\nResolve with: node tools/bugs.js resolve ${short(r.id)} <what was fixed, for the reporter>`;
}

async function shot(db, ref, n) {
  const r = await find(db, ref);
  const s = (r.screenshots || [])[Number(n) || 0];
  if (!s?.base64) throw new Error('No such screenshot.');
  return s.base64;
}

async function resolve(db, ref, note) {
  if (!note || note.length < 5) throw new Error('Say what was fixed: the reporter sees it.');
  const r = await find(db, ref);
  await db.query("UPDATE bug_reports SET status = 'resolved', resolution_note = $2, resolved_at = now() WHERE id = $1", [r.id, note]);
  return `Resolved ${short(r.id)}: ${note}`;
}

async function main([cmd, ref, ...rest]) {
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (cmd === 'list' || !cmd) return await list(db);
    if (cmd === 'show') return await show(db, ref);
    if (cmd === 'shot') return await shot(db, ref, rest[0]);
    if (cmd === 'resolve') return await resolve(db, ref, rest.join(' ').trim());
    throw new Error('Usage: node tools/bugs.js list | show <id> | shot <id> <n> | resolve <id> <note>');
  } finally { await db.end(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((out) => console.log(out)).catch((e) => { console.error(`bugs: ${e.message}`); process.exit(1); });
}

module.exports = { list, show, shot, resolve, find };
