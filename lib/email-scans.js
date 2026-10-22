// Which emails each mail scanner (flights, bookings) has already read, word
// for word. The scanners sent the LLM the same recent confirmations every
// six hours and after every restart, to find nothing new each time: about
// 14,000 tokens a pass, answered with an empty list. Mail read as it arrives
// is read twice (the next pass, a few hours on, is a second chance at one the
// LLM misread); mail over a week old, like the year of it read back at
// setup, once. Either is read again whenever the text sent changes or the
// scanner's instructions do (its version). A scan the person asks for reads
// everything, as before.
const crypto = require("crypto");

const MAX_READS = 2;
const OLD_MS = 7 * 24 * 60 * 60 * 1000;

// How many reads an email gets: one when it was sent over a week ago.
function readsFor(email, now = Date.now()) {
  const sent = Date.parse(email.date || "");
  return Number.isFinite(sent) && sent < now - OLD_MS ? 1 : MAX_READS;
}

// What the scanner sends for an email, as one hash.
function hashOf(version, email) {
  const sent = JSON.stringify([version, email.subject || "", email.from || "", email.date || "", email.body || ""]);
  return crypto.createHash("sha256").update(sent).digest("hex");
}

async function readRows(db, userId, scanner, emails) {
  const ids = [...new Set((emails || []).map((e) => String(e.id)))];
  const rows = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from("email_scans").select("email_id, text_hash, reads")
      .eq("user_id", userId).eq("scanner", scanner).in("email_id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const row of data || []) rows.set(row.email_id, row);
  }
  return rows;
}

// The emails still worth sending: new, changed, or not yet read as often as
// they get. When the record can't be read, all of them, as before.
async function unread(db, userId, scanner, version, emails, now = Date.now()) {
  if (!emails || !emails.length) return [];
  let rows;
  try { rows = await readRows(db, userId, scanner, emails); } catch (e) {
    console.error(`[scans] could not read what ${scanner} has read:`, e.message);
    return emails;
  }
  return emails.filter((e) => {
    const row = rows.get(String(e.id));
    return !row || row.text_hash !== hashOf(version, e) || row.reads < readsFor(e, now);
  });
}

// After the LLM's answer was read: these emails count as read once more.
async function markRead(db, userId, scanner, version, emails) {
  if (!emails || !emails.length) return;
  let rows;
  try { rows = await readRows(db, userId, scanner, emails); } catch (e) {
    console.error(`[scans] could not read what ${scanner} has read:`, e.message);
    return;
  }
  const now = new Date().toISOString();
  const updates = emails.map((e) => {
    const hash = hashOf(version, e), row = rows.get(String(e.id));
    return { user_id: userId, scanner, email_id: String(e.id), text_hash: hash, reads: row && row.text_hash === hash ? row.reads + 1 : 1, read_at: now };
  });
  const { error } = await db.from("email_scans").upsert(updates, { onConflict: "user_id,scanner,email_id" });
  if (error) console.error(`[scans] could not record what ${scanner} read:`, error.message);
}

module.exports = { unread, markRead, hashOf, readsFor, MAX_READS };
