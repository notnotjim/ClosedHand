async function readCachedRecord(db, userId, input) {
  const { data, error } = await db.from("data_cache").select("external_id,source,data,synced_at")
    .eq("user_id", userId).eq("external_id", input.id).eq("source", input.source).limit(2);
  if (error) return { error: "Could not read the saved source: " + error.message };
  if (!data?.length) return { error: "This source is no longer saved. Retrieve it from the connected service using its original id." };
  const row = data[0];
  const safe = require("./otp-guard").redactEmail(row.data, userId);
  const text = JSON.stringify(safe, null, 2);
  const offset = Math.min(text.length, Math.max(0, Math.floor(Number(input.offset) || 0)));
  const limit = Math.min(16000, Math.max(500, Math.floor(Number(input.limit) || 8000)));
  const end = Math.min(text.length, offset + limit);
  return { id: row.external_id, source: row.source, synced_at: row.synced_at,
    content: text.slice(offset, end), offset, total_characters: text.length,
    next_offset: end < text.length ? end : null, complete: offset === 0 && end === text.length };
}
module.exports = { readCachedRecord };
