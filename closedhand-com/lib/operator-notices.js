// Notices for the maintainer, never for the people using Closedhand: how many
// first months of Closedhand Managed Models have started, a burst of them, and
// this month's OpenRouter spend (lib/capacity.js). They go to the maintainer's
// own Closedhand: the account signed in with OPERATOR_EMAIL collects them with
// its next check for the models (lib/addresses.js), and Closedhand says them
// in its chat. One its computer has not collected within a day (asleep,
// offline) is emailed to ASSISTANT_EMAIL_OPERATOR instead, when sending email
// is set up (MAIL_*, as for the download link).
const { sendEmail } = require('./ses');

const DAY = 24 * 3600 * 1000;

function create({ db, env = process.env, request = fetch }) {
  const operator = String(env.OPERATOR_EMAIL || '').trim().toLowerCase();

  async function queue(text) {
    await db.query('INSERT INTO operator_notices (text) VALUES ($1)', [text]);
  }

  // The notices waiting for this account, when it is the maintainer's; each
  // is handed over once, and only one request at a time can take it. One
  // already emailed is not said again.
  async function collect(ownerId) {
    if (!operator || !ownerId) return [];
    // Only a sign-in whose provider vouches for the address: Microsoft can
    // carry an address nobody checked, and these are the maintainer's figures.
    const who = (await db.query('SELECT email, email_verified FROM owners WHERE id = $1', [ownerId])).rows[0];
    if (!who?.email || who.email_verified !== true || who.email.trim().toLowerCase() !== operator) return [];
    const taken = await db.query(
      `UPDATE operator_notices SET delivered_at = now() WHERE id IN (
         SELECT id FROM operator_notices WHERE delivered_at IS NULL AND emailed_at IS NULL ORDER BY seq LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING id, text, seq`);
    return taken.rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map(({ id, text }) => ({ id, text }));
  }

  // Run hourly: a notice waiting a day goes by email instead, once.
  async function emailStale(now = Date.now()) {
    const to = String(env.ASSISTANT_EMAIL_OPERATOR || '').trim();
    const mail = { region: env.MAIL_SES_REGION, from: env.MAIL_FROM, key: env.MAIL_AWS_ACCESS_KEY_ID, secret: env.MAIL_AWS_SECRET_ACCESS_KEY };
    if (!to || !mail.region || !mail.from || !mail.key || !mail.secret) return 0;
    const stale = (await db.query(
      'SELECT id, text FROM operator_notices WHERE delivered_at IS NULL AND emailed_at IS NULL AND created_at < $1 ORDER BY seq LIMIT 20',
      [new Date(now - DAY)])).rows;
    let sent = 0;
    for (const notice of stale) {
      try {
        await sendEmail(mail, { to, subject: notice.text.slice(0, 120), text: notice.text }, request);
        await db.query('UPDATE operator_notices SET emailed_at = now() WHERE id = $1', [notice.id]);
        sent++;
      } catch (e) { console.error('[operator] notice not emailed:', e.message); }
    }
    return sent;
  }

  return { queue, collect, emailStale };
}

module.exports = { create };
