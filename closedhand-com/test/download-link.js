// "Email it to yourself": one email per request, nothing stored, and the
// limits that stop the form being used to pester someone. Amazon SES is a
// stand-in; nothing leaves this machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { register } = require('../lib/download-link');

const MAIL = {
  MAIL_SES_REGION: 'ap-southeast-2', MAIL_FROM: 'ClosedHand <download@assist.closedhand.ai>',
  MAIL_AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', MAIL_AWS_SECRET_ACCESS_KEY: 'secret-example', TOKEN_ENCRYPTION_KEY: 'k'.repeat(44),
};

async function start(env, { fail = false } = {}) {
  const sent = [];
  const request = async (url, opts) => {
    sent.push({ url, opts, body: JSON.parse(opts.body) });
    return new Response('{}', { status: fail ? 500 : 200 });
  };
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  register(app, { env, request });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body, ip = '203.0.113.1') => fetch(base + '/api/download-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body),
  });
  return { sent, post, base, close: () => server.close() };
}

test('stays hidden and refuses until it can send', async () => {
  const s = await start({ TOKEN_ENCRYPTION_KEY: 'k'.repeat(44) });
  assert.deepEqual(await (await fetch(s.base + '/api/download-link/availability')).json(), { available: false });
  assert.equal((await s.post({ email: 'a@example.com' })).status, 503);
  assert.equal(s.sent.length, 0);
  s.close();
});

test('sends one signed email with the link, to that address only', async () => {
  const s = await start(MAIL);
  assert.deepEqual(await (await fetch(s.base + '/api/download-link/availability')).json(), { available: true });
  const res = await s.post({ email: ' Someone@Example.com ' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true });
  assert.equal(s.sent.length, 1);
  const { url, opts, body } = s.sent[0];
  assert.equal(url, 'https://email.ap-southeast-2.amazonaws.com/v2/email/outbound-emails');
  assert.match(opts.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-southeast-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.deepEqual(body.Destination, { ToAddresses: ['Someone@Example.com'] });
  assert.equal(body.FromEmailAddress, MAIL.MAIL_FROM);
  assert.match(body.Content.Simple.Body.Text.Data, /https:\/\/closedhand\.com/);
  s.close();
});

test('turns away anything that is not one plain address', async () => {
  const s = await start(MAIL);
  for (const email of ['', 'nope', 'a@b', 'a@b.co\nBcc: x@y.co', 'a b@c.co', '<a@b.co>', 'x'.repeat(250) + '@b.co', 'a@b.co,c@d.co']) {
    assert.equal((await s.post({ email })).status, 400, JSON.stringify(email));
  }
  assert.equal(s.sent.length, 0);
  s.close();
});

test('a bot filling the hidden field is told it worked, and nothing is sent', async () => {
  const s = await start(MAIL);
  const res = await s.post({ email: 'a@example.com', website: 'http://spam' });
  assert.deepEqual(await res.json(), { sent: true });
  assert.equal(s.sent.length, 0);
  s.close();
});

test('one email per address per day, with the same answer either way', async () => {
  const s = await start(MAIL);
  assert.equal((await s.post({ email: 'a@example.com' }, '203.0.113.2')).status, 200);
  const again = await s.post({ email: 'A@EXAMPLE.COM' }, '203.0.113.3');
  assert.deepEqual(await again.json(), { sent: true });
  assert.equal(s.sent.length, 1);
  s.close();
});

test('a visitor can send a few, then waits an hour', async () => {
  const s = await start(MAIL);
  for (let i = 0; i < 5; i++) assert.equal((await s.post({ email: `p${i}@example.com` })).status, 200);
  assert.equal((await s.post({ email: 'p5@example.com' })).status, 429);
  assert.equal((await s.post({ email: 'p5@example.com' }, '203.0.113.9')).status, 200);
  s.close();
});

test('the whole day is capped', async () => {
  const s = await start({ ...MAIL, MAIL_DAILY_LIMIT: '2' });
  assert.equal((await s.post({ email: 'd1@example.com' }, '198.51.100.1')).status, 200);
  assert.equal((await s.post({ email: 'd2@example.com' }, '198.51.100.2')).status, 200);
  assert.equal((await s.post({ email: 'd3@example.com' }, '198.51.100.3')).status, 429);
  s.close();
});

test('a failed send says so, and the address can try again', async () => {
  const s = await start(MAIL, { fail: true });
  const res = await s.post({ email: 'f@example.com' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Send link or Copy link/);
  assert.equal((await s.post({ email: 'f@example.com' })).status, 502);
  assert.equal(s.sent.length, 2);
  s.close();
});
