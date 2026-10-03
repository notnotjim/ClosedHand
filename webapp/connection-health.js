// A saved connection is connected only while its provider still accepts it.
// When Google or Microsoft refuses the sign-in (revoked, expired, or missing
// permissions), the bot flags the row reconnect_required and stops using it.
// Setup and the dashboard then ask the person to sign in again instead of
// showing it as connected.

function needsSignIn(row) {
  return !!(row && row.metadata && row.metadata.reconnect_required);
}

// Service keys, split into the ones that work and the ones to sign in to again.
function split(rows) {
  const working = [], signInAgain = [];
  for (const row of rows || []) {
    if (!row || !row.service) continue;
    (needsSignIn(row) ? signInAgain : working).push(row.service);
  }
  return { working, signInAgain };
}

// Signing in again clears the flag, even when the account's details could
// not be fetched and the old ones are kept.
function cleared(metadata) {
  if (!metadata) return metadata;
  const { reconnect_required, reconnect_reason, ...rest } = metadata;
  return rest;
}

module.exports = { needsSignIn, split, cleared };
