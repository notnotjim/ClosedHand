// Explicit dashboard requests only. No model call and no unsolicited send.
const { getConf, setConf } = require('./config');
const { supabase } = require('./db');
const { getAdminUserId } = require('./admin');
let busy = false;
async function deliver() {
  if (busy) return;
  busy = true;
  try {
    const job = await getConf('PHONE_LINK_DELIVERY');
    if (!job || job.state !== 'pending' || !['whatsapp_linked', 'telegram'].includes(job.platform)) return;
    if (await getConf('PHONE_ACCESS_MODE') !== 'managed' || String(await getConf('PHONE_ACCESS')) !== '1' || await getConf('PHONE_PERMANENT_URL') !== job.url) throw new Error('Phone access changed. Open your dashboard to send the current link.');
    const { data, error } = await supabase.from('chat_links').select('platform_user_id').eq('user_id', getAdminUserId()).eq('platform', job.platform).eq('platform_user_id', job.chatId);
    if (error) throw error;
    if (!data?.length) throw new Error('The chat is no longer connected.');
    const text = `Here is your dashboard: ${job.url}/dashboard\n\nYou can pin this message or bookmark the link and keep using it. To add ClosedHand to your phone’s home screen, open ${job.url}/keep\n\nYour computer needs to be awake and online.`;
    // Mark before Telegram delivery: its API has no client idempotency key.
    // A crash may need a user retry, but must not repeatedly send on every boot.
    await setConf({ PHONE_LINK_DELIVERY: { ...job, state: 'sending' } });
    if (job.platform === 'whatsapp_linked') await require('./platforms/whatsapp-linked').sendLinkedMessage(job.chatId, text, job.id);
    else await require('./messaging').sendToPlatform(job.platform, job.chatId, text);
    await setConf({ PHONE_LINK_DELIVERY: { ...job, state: 'sent', sentAt: new Date().toISOString() } });
  } catch (_) {
    const job = await getConf('PHONE_LINK_DELIVERY');
    if (job) await setConf({ PHONE_LINK_DELIVERY: { ...job, state: 'error' } }).catch(() => {});
    console.warn('[Phone] Could not deliver dashboard link. Retry from the dashboard.');
  } finally { busy = false; }
}
function setup() { const timer = setInterval(deliver, 5000); timer.unref(); }
module.exports = { setup, deliver };
