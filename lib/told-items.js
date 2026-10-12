// What the person has already been told about, item by item, whichever part
// of Closedhand told them. A watch that sends the tracking link and a Pulse
// nudge about the same email used to have no way of knowing about each
// other; each records here what it told, and each leaves alone what is here.
// An item is a synced email, bank transaction or message: its source and id
// in data_cache.

const key = (source, externalId) => `${source}:${externalId}`;

// items: [{ source, external_id }]. by: who told them ("pulse",
// "watch:<name>"). The first teller is kept.
async function recordTold(db, userId, items, by) {
  const rows = (items || []).filter((i) => i && i.source && i.external_id)
    .map((i) => ({ user_id: userId, source: i.source, external_id: String(i.external_id), told_by: by }));
  if (!rows.length) return;
  const { error } = await db.from("told_items").upsert(rows, { onConflict: "user_id,source,external_id", ignoreDuplicates: true });
  if (error) console.error("[told] could not record what was told:", error.message);
}

// The keys ("source:id") of the items in this list already told about.
async function toldAlready(db, userId, items) {
  const ids = [...new Set((items || []).map((i) => i && String(i.external_id)).filter(Boolean))];
  const told = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from("told_items").select("source, external_id")
      .eq("user_id", userId).in("external_id", ids.slice(i, i + 200));
    if (error) { console.error("[told] could not read what was told:", error.message); continue; }
    for (const row of data || []) told.add(key(row.source, row.external_id));
  }
  return told;
}

module.exports = { recordTold, toldAlready, key };
