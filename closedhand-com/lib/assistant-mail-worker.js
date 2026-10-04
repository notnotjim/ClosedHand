// The assistant email worker: moves mail between the relay and Amazon SES.
// Incoming mail arrives through an SQS queue as an S3 object, is sealed to the
// receiving copy's own key and waits in mail_relay_inbound; replies waiting in
// mail_relay_outbox are sent through SES, one at a time, never resent when the
// outcome is unknown. Bounces and complaints come back on a second queue and
// stop further mail to that address.
const p = require('./assistant-email-protocol');
const usage = require('./assistant-mail-usage');
const { mustWrite } = require('./assistant-mail-relay');
const { decryptString } = require('./crypto-tokens');
const terminal = new Set(['bounced', 'complained', 'suppressed', 'cancelled', 'failed']);
async function receive(db, event, raw, parse) {
  if (event.notificationType !== 'Received' || !event.mail?.messageId || !Array.isArray(event.receipt?.recipients)) throw new Error('Invalid SES receipt.');
  const recipients = event.receipt.recipients.map(p.address).filter(Boolean).map(a => a.replace(/\+[a-f0-9-]{36}(?=@)/i, ''));
  const accounts = mustWrite(await db.from('mail_relay_accounts').select('*').in('address', recipients).eq('enabled', true));
  if (!accounts.length) { await usage.reserve(db, 'in:' + event.mail.messageId, null, 'in', 1, raw.length); return; }
  const admitted = [];
  for (const account of accounts) {
    const result = await usage.reserve(db, 'in:' + event.mail.messageId + ':' + account.id, account.id, 'in', 1, raw.length);
    if (result.allowed) admitted.push(account);
    else await receiveFailure(db, { ...event, receipt: { ...event.receipt, recipients: [account.address] } }, result.reason);
  }
  if (!admitted.length) return;
  const mail = await parse(raw, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: p.LIMITS.text });
  const from = mail.from?.value || [];
  if (from.length !== 1 || !p.address(from[0].address) || p.isAutomated(mail.headers)) return;
  const sender = p.address(from[0].address);
  if (sender.endsWith('@' + p.DOMAIN)) return;
  const authenticated = p.authenticated(event.receipt);
  const to = (mail.to?.value || []).map(x => p.address(x.address)).filter(Boolean);
  const cc = (mail.cc?.value || []).map(x => p.address(x.address)).filter(Boolean);
  const text = String(mail.text || '').slice(0, p.LIMITS.text);
  const refs = p.references(mail.references);
  const reply = p.messageId(mail.inReplyTo); if (reply && !refs.includes(reply)) refs.push(reply);
  let bytes = 0, omitted = 0;
  const files = [];
  for (const file of mail.attachments || []) {
    if (files.length >= 10 || bytes + file.size > p.LIMITS.attachmentBytes) { omitted++; continue; }
    bytes += file.size;
    files.push({ filename: p.header(file.filename || 'attachment', 150).replace(/[\\/]/g, '_'), contentType: p.header(file.contentType), content: file.content.toString('base64') });
  }
  for (const account of admitted) {
    // Opt-out is terminal, independent of the language model or delegated task.
    if (authenticated && /^\s*(?:please\s+)?(?:unsubscribe(?: me)?|stop(?: (?:emailing|contacting) me)?|do not (?:email|contact) me)(?:[.!\s]|thank you|thanks)*$/i.test(text.split(/\n(?:On .+wrote:|>)/)[0])) {
      mustWrite(await db.from('mail_relay_suppression').upsert({ address_hash: p.digest(sender), reason: 'opt-out' }, { onConflict: 'address_hash' }));
    } else if (authenticated && [...to, ...cc].some(a => a.replace(/\+[a-f0-9-]{36}(?=@)/i, '') === account.address)) {
      mustWrite(await db.from('mail_relay_consent').upsert({ account_id: account.id, address: sender, expires_at: new Date(Date.now() + 90 * 86400000).toISOString() }, { onConflict: 'account_id,address' }));
    }
    const routed = event.receipt.recipients.find(a => a.toLowerCase().replace(/\+[a-f0-9-]{36}(?=@)/i, '') === account.address);
    const replyRoute = routed?.match(/\+([a-f0-9-]{36})@/i)?.[1] || null;
    const envelope = { from: sender, to, cc, authenticated, replyRoute, subject: p.header(mail.subject), text, messageId: p.messageId(mail.messageId), references: refs, attachments: files, omittedAttachments: omitted, receivedAt: event.mail.timestamp || new Date().toISOString() };
    // ON CONFLICT DO NOTHING preserves acknowledgements on duplicate SNS/SQS delivery.
    mustWrite(await db.from('mail_relay_inbound').upsert({ account_id: account.id, provider_id: event.mail.messageId, sender, authenticated, message_id: envelope.messageId, sealed: p.seal(envelope, account.public_key, account.id) }, { onConflict: 'account_id,provider_id', ignoreDuplicates: true }));
  }
}
async function receiveFailure(db, event, reason, messageBytes) {
  const recipients = (event.receipt?.recipients || []).map(p.address).filter(Boolean).map(a => a.replace(/\+[a-f0-9-]{36}(?=@)/i, ''));
  const accounts = mustWrite(await db.from('mail_relay_accounts').select('*').in('address', recipients).eq('enabled', true));
  if (messageBytes !== undefined && !accounts.length) await usage.reserve(db, 'in:' + event.mail.messageId, null, 'in', 1, messageBytes);
  for (const account of accounts) {
    if (messageBytes !== undefined) await usage.reserve(db, 'in:' + event.mail.messageId + ':' + account.id, account.id, 'in', 1, messageBytes);
    const from = p.address(event.mail?.source) || 'unknown@example.invalid';
    const envelope = { from, to: [account.address], cc: [], subject: 'Email could not be received', text: '', attachments: [], authenticated: false, deliveryError: reason, receivedAt: event.mail.timestamp };
    mustWrite(await db.from('mail_relay_inbound').upsert({ account_id: account.id, provider_id: event.mail.messageId, sender: from, authenticated: false, sealed: p.seal(envelope, account.public_key, account.id) }, { onConflict: 'account_id,provider_id', ignoreDuplicates: true }));
  }
}
async function feedback(db, event, replay = false) {
  const type = event.notificationType || event.eventType;
  const state = type === 'Bounce' ? (event.bounce?.bounceType === 'Permanent' ? 'bounced' : 'failed') : type === 'Complaint' ? 'complained' : type === 'Delivery' ? 'delivered' : null;
  if (!state || !event.mail?.messageId) return;
  const eventId = p.digest(event.mail.messageId + ':' + state);
  if (!replay) mustWrite(await db.from('mail_relay_feedback').upsert({ event_id: eventId, provider_id: event.mail.messageId, event: { notificationType: type, mail: { messageId: event.mail.messageId, tags: event.mail.tags }, bounce: event.bounce, complaint: event.complaint } }, { onConflict: 'event_id', ignoreDuplicates: true }));
  if (state === 'bounced' || state === 'complained') {
    const recipients = state === 'bounced' ? event.bounce.bouncedRecipients : event.complaint.complainedRecipients;
    for (const r of recipients || []) {
      const address = p.address(r.emailAddress); if (!address) continue;
      mustWrite(await db.from('mail_relay_suppression').upsert({ address_hash: p.digest(address), reason: state }, { onConflict: 'address_hash' }));
    }
  }
  const tagId = event.mail.tags?.closedhand_job?.[0];
  let query = db.from('mail_relay_outbox').select('id,state');
  query = p.uuid(tagId) ? query.eq('id', tagId) : query.eq('provider_id', event.mail.messageId);
  const job = mustWrite(await query.maybeSingle());
  if (!job) return;
  if (terminal.has(job.state) && !['bounced', 'complained'].includes(state)) { mustWrite(await db.from('mail_relay_feedback').delete().eq('event_id', eventId)); return; }
  mustWrite(await db.from('mail_relay_outbox').update({ state, payload: null, provider_id: event.mail.messageId, updated_at: new Date().toISOString(), error: state === 'bounced' ? 'The recipient’s mail service rejected delivery.' : state === 'complained' ? 'The recipient reported this email. Further delivery is blocked.' : state === 'failed' ? 'Delivery failed temporarily. No automatic retry was sent.' : null }).eq('id', job.id));
  mustWrite(await db.from('mail_relay_feedback').delete().eq('event_id', eventId));
}
function start(db, env = process.env) {
  if (env.ASSISTANT_EMAIL_ENABLED !== '1' || env.ASSISTANT_EMAIL_RELEASED !== '1') return;
  for (const key of ['AWS_REGION', 'ASSISTANT_EMAIL_INBOUND_QUEUE', 'ASSISTANT_EMAIL_INBOUND_TOPIC', 'ASSISTANT_EMAIL_BUCKET', 'ASSISTANT_EMAIL_FEEDBACK_QUEUE', 'ASSISTANT_EMAIL_FEEDBACK_TOPIC']) {
    if (!env[key]) throw new Error('Assistant email requires ' + key);
  }
  const sq = require('@aws-sdk/client-sqs'), s3 = require('@aws-sdk/client-s3'), ses = require('@aws-sdk/client-sesv2');
  const config = { region: env.AWS_REGION };
  const queue = new sq.SQSClient(config), bucket = new s3.S3Client(config);
  // SES has no idempotency key. SDK retries are disabled, including throttling.
  const sender = new ses.SESv2Client({ ...config, maxAttempts: 1 });
  const guard = require('./assistant-mail-guard').createGuard(db, env, sender);
  const parse = require('mailparser').simpleParser, MailComposer = require('nodemailer/lib/mail-composer');
  let stopped = false;
  async function pump(queueUrl, topic, inbound) {
    while (!stopped) {
      try {
        const batch = await queue.send(new sq.ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 20, VisibilityTimeout: 120, MaxNumberOfMessages: 5 }));
        for (const message of batch.Messages || []) {
          const wrapper = JSON.parse(message.Body);
          if (wrapper.Type !== 'Notification' || wrapper.TopicArn !== topic) throw new Error('Unexpected email queue origin.');
          const event = JSON.parse(wrapper.Message);
          if (inbound) {
            const action = event.receipt?.action;
            if (action?.type !== 'S3' || action.bucketName !== env.ASSISTANT_EMAIL_BUCKET || !action.objectKey?.startsWith('incoming/')) throw new Error('Unexpected mail object.');
            let object;
            try { object = await bucket.send(new s3.GetObjectCommand({ Bucket: action.bucketName, Key: action.objectKey })); }
            catch (e) { if (e.name !== 'NoSuchKey') throw e; }
            if (object) {
              if (object.ContentLength > p.LIMITS.messageBytes) {
                object.Body.destroy();
                await receiveFailure(db, event, 'This email exceeded 8 MB. Ask the sender to send a smaller message.', object.ContentLength);
                await bucket.send(new s3.DeleteObjectCommand({ Bucket: action.bucketName, Key: action.objectKey }));
              } else {
                const chunks = []; let length = 0;
                for await (const chunk of object.Body) { length += chunk.length; if (length > p.LIMITS.messageBytes) throw new Error('Incoming mail exceeded the limit.'); chunks.push(chunk); }
                await receive(db, event, Buffer.concat(chunks), parse);
                await bucket.send(new s3.DeleteObjectCommand({ Bucket: action.bucketName, Key: action.objectKey }));
              }
            }
          } else await feedback(db, event);
          await queue.send(new sq.DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        }
      } catch (e) { console.error('[Assistant email] Queue:', e.name || 'Error', e.name === 'AccessDenied' ? String(e.message).slice(0, 800) : ''); await new Promise(r => setTimeout(r, 5000)); }
    }
  }
  let sending = false;
  async function flush() {
    if (sending || stopped) return; sending = true;
    try {
      await usage.monitor(db, guard.notify, guard.cutoff);
      const events = mustWrite(await db.from('mail_relay_feedback').select('event').order('received_at').limit(100));
      for (const item of events) await feedback(db, item.event, true);
      mustWrite(await db.from('mail_relay_feedback').delete().lt('received_at', new Date(Date.now() - 14 * 86400000).toISOString()));
      // Unknown sends are visible and are never automatically resubmitted.
      mustWrite(await db.from('mail_relay_outbox').update({ state: 'uncertain', error: 'Delivery was interrupted. Check the recipient before sending again.' }).eq('state', 'sending').lt('updated_at', new Date(Date.now() - 300000).toISOString()));
      mustWrite(await db.from('mail_relay_inbound').update({ sealed: null }).lt('expires_at', new Date().toISOString()).not('sealed', 'is', null));
      mustWrite(await db.from('mail_relay_outbox').update({ state: 'failed', payload: null, error: 'Delivery expired after 14 days. No email was sent.' }).eq('state', 'pending').lt('created_at', new Date(Date.now() - 14 * 86400000).toISOString()));
      mustWrite(await db.from('mail_relay_outbox').update({ payload: null }).lt('created_at', new Date(Date.now() - 14 * 86400000).toISOString()).neq('state', 'pending'));
      const jobs = mustWrite(await db.from('mail_relay_outbox').select('id').eq('state', 'pending').order('created_at').limit(10));
      for (const job of jobs) {
        const row = mustWrite(await db.rpc('claim_mail_relay_outbox', { job: job.id }))[0]; if (!row) continue;
        try {
          const account = mustWrite(await db.from('mail_relay_accounts').select('address,enabled').eq('id', row.account_id).single());
          if (!account.enabled) { mustWrite(await db.from('mail_relay_outbox').update({ state: 'cancelled', payload: null }).eq('id', row.id)); continue; }
          const mail = p.outgoing(JSON.parse(decryptString(row.payload)));
          const raw = await new MailComposer({ from: { name: mail.displayName, address: account.address }, replyTo: account.address.replace('@', '+' + row.id + '@'), to: mail.to, subject: mail.subject, text: mail.text, inReplyTo: mail.inReplyTo || undefined, references: mail.references, messageId: '<' + row.id + '@' + p.DOMAIN + '>', headers: { 'Auto-Submitted': mail.inReplyTo ? 'auto-replied' : 'auto-generated', 'X-Auto-Response-Suppress': 'All' }, attachments: mail.attachments.map(f => ({ filename: f.filename, contentType: f.contentType, content: Buffer.from(f.content, 'base64') })) }).compile().build();
          const result = await sender.send(new ses.SendEmailCommand({ Destination: { ToAddresses: mail.to }, Content: { Raw: { Data: raw } }, EmailTags: [{ Name: 'closedhand_job', Value: row.id }] }));
          mustWrite(await db.from('mail_relay_outbox').update({ state: 'sent', provider_id: result.MessageId, payload: null, updated_at: new Date().toISOString() }).eq('id', row.id).eq('state', 'sending'));
        } catch (e) {
          const rejected = e.$metadata?.httpStatusCode >= 400 && e.$metadata?.httpStatusCode < 500;
          mustWrite(await db.from('mail_relay_outbox').update({ state: rejected ? 'failed' : 'uncertain', error: rejected ? 'The email provider rejected delivery. Check email status in Settings.' : 'Delivery could not be confirmed. Check the recipient before sending again.', updated_at: new Date().toISOString() }).eq('id', row.id).eq('state', 'sending'));
          console.error('[Assistant email] Send:', e.name || 'Error');
        }
        await new Promise(r => setTimeout(r, 1100));
      }
    } catch (e) { console.error('[Assistant email] Outbox:', e.name || 'Error'); }
    finally { sending = false; }
  }
  pump(env.ASSISTANT_EMAIL_INBOUND_QUEUE, env.ASSISTANT_EMAIL_INBOUND_TOPIC, true);
  pump(env.ASSISTANT_EMAIL_FEEDBACK_QUEUE, env.ASSISTANT_EMAIL_FEEDBACK_TOPIC, false);
  const timer = setInterval(flush, 5000); timer.unref(); flush();
  return () => { stopped = true; clearInterval(timer); queue.destroy(); bucket.destroy(); sender.destroy(); guard.close(); };
}
module.exports = { receive, receiveFailure, feedback, start };
