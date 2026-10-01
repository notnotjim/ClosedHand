// One email through Amazon SES (the v2 SendEmail call), signed with AWS
// Signature Version 4. Small enough not to need the AWS SDK. The keys come
// from the environment and belong to a user that may only send.
const crypto = require('node:crypto');

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest();

// The Authorization header for a JSON POST, per
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
function sign({ method, host, path, body, region, service, key, secret, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers = { 'content-type': 'application/json', host, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const request = [method, path, '', names.map(n => n + ':' + headers[n] + '\n').join(''), names.join(';'), sha256(body)].join('\n');
  const scope = [date, region, service, 'aws4_request'].join('/');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(request)].join('\n');
  let signingKey = hmac('AWS4' + secret, date);
  for (const part of [region, service, 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = crypto.createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex');
  return {
    'Content-Type': headers['content-type'],
    'X-Amz-Date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

async function sendEmail({ region, key, secret, from }, { to, subject, text, html }, request = fetch) {
  const host = `email.${region}.amazonaws.com`, path = '/v2/email/outbound-emails';
  const body = JSON.stringify({
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: { Simple: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: text, Charset: 'UTF-8' }, ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}) },
    } },
  });
  const response = await request(`https://${host}${path}`, {
    method: 'POST', body, signal: AbortSignal.timeout(10000),
    headers: sign({ method: 'POST', host, path, body, region, service: 'ses', key, secret }),
  });
  if (!response.ok) throw new Error('SES answered ' + response.status);
  return true;
}

module.exports = { sign, sendEmail };
