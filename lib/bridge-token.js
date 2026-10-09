// Mac Bridge tokens are kept only as a hash. The Bridge app holds its token
// and sends it with every connection; the server only ever compares it, so a
// copy of the database cannot be used to act as the Mac. A token stored plain
// before this still matches, and the dashboard hashes those once at start.
//
// Vendored: lib/bridge-token.js and webapp/bridge-token.js stay byte-identical
// (scripts/check-vendored-identical.js).
const crypto = require("crypto");

const PREFIX = "sha256:";
const hashBridgeToken = (token) => PREFIX + crypto.createHash("sha256").update(String(token)).digest("hex");
const isHashed = (stored) => typeof stored === "string" && stored.startsWith(PREFIX);

// The stored values a token sent by a Mac may match: its hash, and for a row
// saved before hashing, the token itself. Something shaped like a hash only
// matches the hash of itself, so a hash copied from the database is no token.
function storedForms(token) {
  const t = String(token || "");
  return isHashed(t) ? [hashBridgeToken(t)] : [hashBridgeToken(t), t];
}

// Hash the tokens saved before they were kept as hashes. Returns how many.
async function hashStoredTokens(db) {
  const { data, error } = await db.from("user_bridges").select("user_id, token");
  if (error) throw new Error(error.message);
  let hashed = 0;
  for (const row of data || []) {
    if (!row.token || isHashed(row.token)) continue;
    const { error: writeError } = await db.from("user_bridges").update({ token: hashBridgeToken(row.token) }).eq("user_id", row.user_id).eq("token", row.token);
    if (writeError) throw new Error(writeError.message);
    hashed++;
  }
  return hashed;
}

module.exports = { hashBridgeToken, isHashed, storedForms, hashStoredTokens };
