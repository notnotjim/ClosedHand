// "Or email it to yourself": on a phone, the link to get ClosedHand on a
// computer, sent as one fixed email. It's optional (ClosedHand downloads
// with no account and no address) and nothing is stored. To stop the form
// being used to pester someone, a keyed hash of each address is held in
// memory for a day, so an address gets at most one email a day; visitors and
// the whole day are capped too. A restart forgets all of it.
const crypto = require('node:crypto');
const { sendEmail } = require('./ses');

const DAY = 24 * 60 * 60 * 1000, HOUR = 60 * 60 * 1000;
const PER_VISITOR_HOUR = 5;
const SUBJECT = 'Your ClosedHand download link';
const TEXT = [
  'Here’s the link you asked for. Open it on your computer to get ClosedHand:',
  '',
  'https://closedhand.com',
  '',
  'The Mac app downloads from there, and Docker runs ClosedHand on Windows, Linux or a Mac.',
  '',
  'You asked for this on closedhand.com. It’s the only email we’ll send, and we haven’t kept your address.',
].join('\n');
const HTML = `<!doctype html><html><body style="margin:0;padding:32px 20px;background:#100E0D;color:#EFE6D6;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:480px;margin:0 auto">
<p style="margin:0 0 20px;font:500 22px/1.3 Georgia,serif">Here’s the link you asked for.</p>
<p style="margin:0 0 24px;color:#B6AFA4">Open it on your computer to get ClosedHand. The Mac app downloads from there, and Docker runs ClosedHand on Windows, Linux or a Mac.</p>
<p style="margin:0 0 28px"><a href="https://closedhand.com" style="display:inline-block;padding:12px 22px;border-radius:12px;background:#EFE6D6;color:#100E0D;text-decoration:none;font-weight:600">Open closedhand.com</a></p>
<p style="margin:0;font-size:13px;color:#8C857B">You asked for this on closedhand.com. It’s the only email we’ll send, and we haven’t kept your address.</p>
</div></body></html>`;

// A plain address: one @, a dotted domain, no spaces or line breaks.
function address(value) {
  const text = String(value || '').trim();
  if (text.length > 254 || !/^[^\s@<>()",;:\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(text)) return null;
  return text;
}

function register(app, { env = process.env, request = fetch, now = () => Date.now() }) {
  const mail = {
    region: env.MAIL_SES_REGION, from: env.MAIL_FROM,
    key: env.MAIL_AWS_ACCESS_KEY_ID, secret: env.MAIL_AWS_SECRET_ACCESS_KEY,
  };
  const enabled = !!(mail.region && mail.from && mail.key && mail.secret);
  const dailyLimit = Number.parseInt(env.MAIL_DAILY_LIMIT || '300', 10);
  const pepper = env.TOKEN_ENCRYPTION_KEY;
  const recent = new Map(), visitors = new Map();
  let day = { at: now(), sent: 0 };
  setInterval(() => {
    const t = now();
    for (const [k, at] of recent) if (t - at >= DAY) recent.delete(k);
    for (const [k, v] of visitors) if (t - v.at >= HOUR) visitors.delete(k);
  }, 10 * 60 * 1000).unref();

  app.get('/api/download-link/availability', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ available: enabled });
  });

  app.post('/api/download-link', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const unavailable = 'Emailing the link isn’t available right now. Send link or Copy link still work.';
    if (!enabled) return res.status(503).json({ error: unavailable });
    const { email, website } = req.body || {};
    // A hidden field people never see: anything in it is a bot, told it worked.
    if (website) return res.json({ sent: true });
    const to = address(email);
    if (!to) return res.status(400).json({ error: 'That doesn’t look like an email address.' });

    const t = now();
    const visitor = visitors.get(req.ip || '?');
    if (visitor && t - visitor.at < HOUR && visitor.count >= PER_VISITOR_HOUR) {
      return res.status(429).json({ error: 'That’s a few emails already. Try again in an hour, or use Send link.' });
    }
    if (t - day.at >= DAY) day = { at: t, sent: 0 };
    if (day.sent >= dailyLimit) return res.status(429).json({ error: unavailable });

    // Already sent to this address today: the same answer, and no second
    // email, so the form can't be used to find out who asked.
    const key = crypto.createHmac('sha256', pepper).update('download-link:' + to.toLowerCase()).digest('hex');
    if (recent.has(key) && t - recent.get(key) < DAY) return res.json({ sent: true });
    recent.set(key, t);
    visitors.set(req.ip || '?', visitor && t - visitor.at < HOUR ? { at: visitor.at, count: visitor.count + 1 } : { at: t, count: 1 });
    day.sent++;
    try {
      await sendEmail(mail, { to, subject: SUBJECT, text: TEXT, html: HTML }, request);
      res.json({ sent: true });
    } catch (e) {
      recent.delete(key); day.sent--;
      console.error('[download-link] send failed:', e.message);
      res.status(502).json({ error: 'That didn’t send just now. Send link or Copy link still work.' });
    }
  });
}

module.exports = { register, address };
