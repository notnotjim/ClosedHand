// The bot's own files from a Closedhand that moved here (webapp/move.js), such
// as its WhatsApp session, so WhatsApp stays linked. They arrive in the
// database, the one place the dashboard and the bot share on every host, and
// the bot writes them into its storage folder just before it restarts.
const fs = require("fs");
const path = require("path");

const BUCKET = "_moved-bot-files"; // as webapp/move.js names it

// Where the bot keeps its files: the same folder whatsapp-linked.js uses.
function base() {
  return path.resolve(process.env.STORAGE_DIR || path.resolve(__dirname, "../storage"));
}

async function restore(pool = require("./db").supabase._pool) {
  if (!pool) return 0;
  const { rows } = await pool.query("SELECT key, data FROM storage_objects WHERE bucket = $1", [BUCKET]);
  const root = base();
  for (const { key, data } of rows) {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) continue; // never outside the folder
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
  if (rows.length) {
    await pool.query("DELETE FROM storage_objects WHERE bucket = $1", [BUCKET]);
    console.log(`[move] wrote ${rows.length} file(s) that came with the move`);
  }
  return rows.length;
}

module.exports = { restore, BUCKET };
