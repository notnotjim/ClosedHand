// Assistant email allowances, kept per verified owner across every copy they
// run: the counting itself happens in reserve_mail_relay_usage (migration
// 008) under one lock, so replicas and retries never double-count.
const crypto = require('node:crypto');
function mustWrite(result) { if (result.error) throw new Error('Email usage accounting is unavailable.'); return result.data; }
async function reserve(db, event, account, direction, deliveries, bytes) {
  const rows = mustWrite(await db.rpc('reserve_mail_relay_usage', { event_key: event, account, direction_text: direction, deliveries, message_bytes: bytes }));
  if (!rows?.length) throw new Error('Email usage accounting is unavailable.');
  return rows[0];
}
async function usage(db, account) {
  const month = new Date().toISOString().slice(0,7) + '-01';
  const owner = crypto.createHash('sha256').update(account.owner_email.toLowerCase()).digest('hex');
  const row = mustWrite(await db.from('mail_relay_usage').select('sent,received,bytes').eq('owner_key', owner).eq('period', month).maybeSingle());
  const daily = mustWrite(await db.from('mail_relay_usage').select('sent,received').eq('owner_key', owner + ':daily').eq('period', new Date().toISOString().slice(0,10)).maybeSingle());
  return { dailySent: daily?.sent || 0, dailyReceived: daily?.received || 0, sent: row?.sent || 0, received: row?.received || 0, bytes: Number(row?.bytes || 0), sentLimit: 1000, receivedLimit: 2000, bytesLimit: 262144000, resets: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString() };
}
async function monitor(db, notify, cutoff) {
  const month = new Date().toISOString().slice(0,7) + '-01';
  const control = mustWrite(await db.from('mail_relay_controls').select('monthly_usd,paused').eq('id', true).single());
  const global = mustWrite(await db.from('mail_relay_usage').select('estimated_usd').eq('owner_key', 'global').eq('period', month).maybeSingle());
  const used = Number(global?.estimated_usd || 0), budget = Number(control.monthly_usd);
  if (control.paused || used >= budget) await cutoff();
  for (const threshold of [50,75,90,100]) {
    if (used < budget * threshold / 100) continue;
    const claim = await db.from('mail_relay_alerts').insert({ month, threshold }).select('threshold');
    if (claim.error?.code === '23505') continue;
    mustWrite(claim);
    try {
      await notify({ threshold, used, budget, month });
      mustWrite(await db.from('mail_relay_alerts').update({ sent_at: new Date().toISOString() }).eq('month', month).eq('threshold', threshold));
    } catch (e) {
      mustWrite(await db.from('mail_relay_alerts').delete().eq('month', month).eq('threshold', threshold));
      throw e;
    }
  }
}
module.exports = { reserve, usage, monitor };
