// Emails to whoever runs closedhand.com, about the service itself. The
// address comes from ALERT_EMAIL and is never stored here. Each alert is sent
// once when its condition starts, and again only after it has cleared.
const { sendEmail } = require('./ses');

// Personal URLs each hold a DNS record on closedhand.ai, and the Worker stops
// creating new ones at 190. Past DNS_ALERT_AT (150) is the time to act.
async function reportDnsRecords(db, env, count, request = fetch) {
  const threshold = Number.parseInt(env.DNS_ALERT_AT || '150', 10);
  const over = count > threshold;
  const was = (await db.query("SELECT active FROM service_alerts WHERE name = 'dns-records'")).rows[0]?.active === true;
  let active = over && was;
  if (over && !was) {
    const mail = { region: env.MAIL_SES_REGION, from: env.MAIL_FROM, key: env.MAIL_AWS_ACCESS_KEY_ID, secret: env.MAIL_AWS_SECRET_ACCESS_KEY };
    if (!env.ALERT_EMAIL || !mail.region || !mail.from || !mail.key || !mail.secret) {
      console.error(`[alerts] Personal URL DNS records at ${count}, over ${threshold}, but no alert email is set up`);
    } else {
      try {
        await sendEmail(mail, {
          to: env.ALERT_EMAIL,
          subject: `Closedhand: personal URL DNS records passed ${threshold}`,
          text: [
            `Personal URLs now use ${count} DNS records on closedhand.ai, past the ${threshold} alert.`,
            '',
            'The route-building Worker stops creating new personal URLs at 190 records. Raise the zone’s record limit or the Worker’s reserve before then.',
            '',
            'This email is sent once each time the count goes past the alert.',
          ].join('\n'),
        }, request);
        active = true;
      } catch (e) {
        console.error('[alerts] Could not send the DNS records alert:', e.message);
      }
    }
  }
  await db.query(
    `INSERT INTO service_alerts (name, active, value, updated_at) VALUES ('dns-records', $1, $2, now())
     ON CONFLICT (name) DO UPDATE SET active = EXCLUDED.active, value = EXCLUDED.value, updated_at = now()`,
    [active, count]);
  return { over, alerted: active && !was };
}

module.exports = { reportDnsRecords };
