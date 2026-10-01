// Bug reports a person chose to send from their copy of ClosedHand. The copy
// keeps a receipt that can check this report's outcome and nothing else.
const crypto = require('node:crypto');

const SELF_HOST_REPORTER_ID = '00000000-0000-0000-0000-00000000ffff';
const hexKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const MAX_SCREENSHOTS = 4;
const MAX_SCREENSHOT_BASE64 = 2800000;
// Per report and for the whole service, so reports cannot fill the database.
const MAX_REPORT_BASE64 = 4000000;
const MAX_REPORTS_PER_HOUR = 100;

// One IPv6 connection hands out a whole /64 of addresses, so a /64 counts as
// one sender.
function sender(ip) {
  const text = String(ip || '?').replace(/^::ffff:/, '');
  return text.includes(':') ? text.split(':').slice(0, 4).join(':') + '::/64' : text;
}

// A retried send carries the same key, so it lands on the same report.
function submissionId(key) {
  if (!hexKey(key)) return crypto.randomUUID();
  const h = crypto.createHash('sha256').update('closedhand-bug:' + key).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), 'a' + h.slice(17, 20), h.slice(20, 32)].join('-');
}
function receiptFor(id, secret) {
  return crypto.createHmac('sha256', secret).update('closedhand-bug-status:' + id).digest('hex');
}
function validReceipt(id, receipt, secret) {
  return uuid(id) && hexKey(receipt) &&
    crypto.timingSafeEqual(Buffer.from(receipt, 'hex'), Buffer.from(receiptFor(id, secret), 'hex'));
}

function register(app, { db, secret }) {
  const hits = new Map();
  let hour = { at: Date.now(), reports: 0 };
  setInterval(() => {
    const now = Date.now();
    for (const [k, item] of hits) if (now - item.at >= 3600000) hits.delete(k);
    if (now - hour.at >= 3600000) hour = { at: now, reports: 0 };
  }, 60000).unref();
  function allowed(req, kind, max) {
    const key = kind + ':' + sender(req.ip);
    const item = hits.get(key) || { at: Date.now(), count: 0 };
    if (item.count >= max) return false;
    item.count++;
    hits.set(key, item);
    return true;
  }

  app.post('/api/bug-intake/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!allowed(req, 'status', 120)) return res.status(429).json({ error: 'Try again later.' });
    const { id, receipt } = req.body || {};
    if (!validReceipt(id, receipt, secret)) return res.status(404).json({ error: 'Report not found.' });
    try {
      const row = (await db.query("SELECT status, resolution_note, resolved_at FROM bug_reports WHERE id = $1 AND source = 'self-host'", [id])).rows[0];
      return row ? res.json(row) : res.status(404).json({ error: 'Report not found.' });
    } catch (e) {
      console.error('[bugs] status failed:', e.message);
      return res.status(503).json({ error: 'Could not check the report.' });
    }
  });

  app.post('/api/bug-intake', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!allowed(req, 'send', 10) || hour.reports >= MAX_REPORTS_PER_HOUR) return res.status(429).json({ error: 'Too many reports right now. Try again later.' });
      const b = req.body || {};
      if (b.submission_key !== undefined && !hexKey(b.submission_key)) return res.status(400).json({ error: 'Invalid submission key.' });
      const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : null;
      const transcript = Array.isArray(b.transcript)
        ? b.transcript.slice(-5).map(m => ({ role: str(m?.role, 20) || 'user', content: str(m?.content, 1500) || '' })) : [];
      if (!transcript.length && !str(b.comment, 1)) return res.status(400).json({ error: 'Empty report' });
      const id = submissionId(b.submission_key);
      const screenshots = [];
      let bytes = 0;
      (Array.isArray(b.screenshots) ? b.screenshots.slice(0, MAX_SCREENSHOTS) : []).forEach((sh, i) => {
        if (!sh || typeof sh.base64 !== 'string' || sh.base64.length > MAX_SCREENSHOT_BASE64 || !/^image\/(jpeg|png|webp|gif)$/.test(sh.mediaType)) return;
        if (bytes + sh.base64.length > MAX_REPORT_BASE64) return;
        bytes += sh.base64.length;
        screenshots.push({ path: `selfhost/bug/${id}_${i}.${sh.mediaType.split('/')[1].replace('jpeg', 'jpg')}`, mediaType: sh.mediaType, base64: sh.base64 });
      });
      // A retry of a report that timed out finds the first copy and keeps it.
      await db.query(
        `INSERT INTO bug_reports (id, user_id, platform, comment, transcript, screenshots, source, install_id, app_version)
         VALUES ($1, $2, $3, $4, $5, $6, 'self-host', $7, $8) ON CONFLICT (id) DO NOTHING`,
        [id, SELF_HOST_REPORTER_ID, str(b.platform, 40), str(b.comment, 2000), JSON.stringify(transcript), JSON.stringify(screenshots),
          str(b.install_id, 32), str(b.app_version, 40)]);
      hour.reports++;
      const row = (await db.query("SELECT jsonb_array_length(screenshots) AS shots FROM bug_reports WHERE id = $1 AND source = 'self-host'", [id])).rows[0];
      if (!row) throw new Error('report missing after save');
      console.log(`[bugs] saved ${id} (${row.shots} screenshots)`);
      return res.json({ ok: true, id, receipt: receiptFor(id, secret), screenshots: row.shots });
    } catch (e) {
      console.error('[bugs] intake failed:', e.message);
      return res.status(500).json({ error: 'Could not save the report.' });
    }
  });
}

module.exports = { register, submissionId, receiptFor, validReceipt, sender };
