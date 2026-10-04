// Owners are found by the permanent ID their sign-in provider gives them.
// Two sign-ins are the same owner only when they are the same provider
// account; an email address never joins accounts together, because a work
// account's email is whatever its organisation typed in.

// identity: { provider, subject, email, emailVerified, personal }. Only the
// email is kept about the person, and whether the provider vouches for it: no
// name, picture or anything else the sign-in gives. Google says when it
// verified the address; a personal Microsoft account's address is its own
// sign-in. Only a vouched-for address may receive the assistant's email.
async function ownerFor(db, identity) {
  const { provider, subject, email = null } = identity;
  if (!['google', 'microsoft'].includes(provider) || typeof subject !== 'string' || !subject) throw new Error('Unknown identity');
  const verified = !!email && (identity.emailVerified === true || (provider === 'microsoft' && identity.personal === true));
  const known = await db.query(
    'UPDATE owners SET email = $3, email_verified = $4, updated_at = now() WHERE provider = $1 AND subject = $2 RETURNING id',
    [provider, subject, email, verified]);
  if (known.rows[0]) return known.rows[0].id;
  // Owners carried over from the old service are known only by the Google
  // address they used there. A verified sign-in with that same Google address
  // claims the row once; after that the Google ID alone finds it.
  if (provider === 'google' && identity.emailVerified === true && email) {
    const claimed = await db.query(
      `UPDATE owners SET subject = $1, email_verified = true, updated_at = now()
       WHERE id = (SELECT id FROM owners WHERE provider = 'google' AND subject IS NULL AND lower(email) = lower($2)
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [subject, email]);
    if (claimed.rows[0]) return claimed.rows[0].id;
  }
  const created = await db.query(
    `INSERT INTO owners (provider, subject, email, email_verified) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, subject) WHERE subject IS NOT NULL DO UPDATE SET updated_at = now()
     RETURNING id`,
    [provider, subject, email, verified]);
  return created.rows[0].id;
}

async function describe(db, ownerId) {
  if (!ownerId) return null;
  const { rows } = await db.query('SELECT id, provider, email FROM owners WHERE id = $1', [ownerId]);
  return rows[0] || null;
}

module.exports = { ownerFor, describe };
