// Owners are found by the permanent ID their sign-in provider gives them.
// Two sign-ins are the same owner only when they are the same provider
// account; an email address never joins accounts together, because a work
// account's email is whatever its organisation typed in.

// identity: { provider, subject, email, emailVerified, name }
async function ownerFor(db, identity) {
  const { provider, subject, email = null, name = null } = identity;
  if (!['google', 'microsoft'].includes(provider) || typeof subject !== 'string' || !subject) throw new Error('Unknown identity');
  const known = await db.query(
    'UPDATE owners SET email = $3, name = COALESCE($4, name), updated_at = now() WHERE provider = $1 AND subject = $2 RETURNING id',
    [provider, subject, email, name]);
  if (known.rows[0]) return known.rows[0].id;
  // Owners carried over from the old service are known only by the Google
  // address they used there. A verified sign-in with that same Google address
  // claims the row once; after that the Google ID alone finds it.
  if (provider === 'google' && identity.emailVerified === true && email) {
    const claimed = await db.query(
      `UPDATE owners SET subject = $1, name = COALESCE($3, name), updated_at = now()
       WHERE id = (SELECT id FROM owners WHERE provider = 'google' AND subject IS NULL AND lower(email) = lower($2)
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [subject, email, name]);
    if (claimed.rows[0]) return claimed.rows[0].id;
  }
  const created = await db.query(
    `INSERT INTO owners (provider, subject, email, name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, subject) WHERE subject IS NOT NULL DO UPDATE SET updated_at = now()
     RETURNING id`,
    [provider, subject, email, name]);
  return created.rows[0].id;
}

async function describe(db, ownerId) {
  if (!ownerId) return null;
  const { rows } = await db.query('SELECT id, provider, email, name FROM owners WHERE id = $1', [ownerId]);
  return rows[0] || null;
}

module.exports = { ownerFor, describe };
