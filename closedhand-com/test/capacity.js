// The maintainer's notices (lib/capacity.js, lib/operator-notices.js), where an
// account stands with Closedhand Managed Models (lib/plan.js), and Closedhand+'s
// email allowances (migration 014), against a real Postgres, in a database of
// its own so it can run beside e2e.js, which empties its own as it starts.
// Invented people only.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/capacity.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../lib/db');
const capacity = require('../lib/capacity');
const notices = require('../lib/operator-notices');
const { planFor } = require('../lib/plan');

const NAME = 'closedhand_capacity_test';
let admin, db;
before(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + NAME;
  db = new Pool({ connectionString: url.toString() });
  await migrate(db);
});
after(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin?.end();
});

let people = 0;
async function person(email = `person${++people}@example.com`, verified = true) {
  return (await db.query("INSERT INTO owners (provider, subject, email, email_verified) VALUES ($3, $1, $2, $4) RETURNING id",
    ['cap-' + (++people), email, verified ? 'google' : 'microsoft', verified])).rows[0].id;
}
const started = (n, at = new Date()) => Promise.all(Array.from({ length: n }, () =>
  db.query('INSERT INTO starter_grants (person_hash, granted_usd, granted_at) VALUES ($1, 20, $2)', [crypto.randomBytes(16).toString('hex'), at])));
const fresh = async () => { await db.query('TRUNCATE starter_grants, operator_alerts, operator_notices'); };

test('first months past the expected number are told at 75%, 90%, 100%, then every 25%, and never stop anyone', async () => {
  await fresh();
  const queued = notices.create({ db, env: {} });
  const watch = capacity.create({ db, env: { INCLUDED_AI_MONTHLY_PEOPLE: '8', INCLUDED_AI_DAILY_PEOPLE: '1000' }, notices: queued });
  await started(5);
  assert.deepEqual(await watch.check(), [], 'under 75%');
  await started(1);
  assert.deepEqual(await watch.check(), ["Closedhand: 6 of this month's 8 first months of Managed Models are taken. Raise INCLUDED_AI_MONTHLY_PEOPLE on Railway if more people are coming."]);
  assert.deepEqual(await watch.check(), [], 'told once');
  await started(4);
  assert.deepEqual(await watch.check(), ["Closedhand: 10 of this month's 8 first months of Managed Models are taken. Raise INCLUDED_AI_MONTHLY_PEOPLE on Railway if more people are coming."], 'one notice for 90%, 100% and 125% passed at once');
  assert.equal((await db.query("SELECT count(*) AS n FROM operator_alerts WHERE kind = 'first-months'")).rows[0].n, '4');
  await started(1, new Date(Date.UTC(2020, 0, 15)));
  assert.deepEqual(await watch.check(), [], 'another month counts apart');
  assert.equal((await db.query('SELECT count(*) AS n FROM operator_notices')).rows[0].n, '2');
});

test('a burst of first months in a day is told once that day', async () => {
  await fresh();
  const watch = capacity.create({ db, env: { INCLUDED_AI_MONTHLY_PEOPLE: '1000', INCLUDED_AI_DAILY_PEOPLE: '3' }, notices: notices.create({ db, env: {} }) });
  await started(2);
  assert.deepEqual(await watch.check(), []);
  await started(1);
  assert.deepEqual(await watch.check(), ['Closedhand: 3 first months of Managed Models started in the last 24 hours, more than usual. Worth a look for account farming.']);
  await started(5);
  assert.deepEqual(await watch.check(), [], 'once a day');
});

test('this month\'s OpenRouter spend is told against the budget, only when the budget is set', async () => {
  await fresh();
  let spent = 120;
  const includedAi = { enabled: () => true, spentThisMonth: async () => spent };
  const queue = notices.create({ db, env: {} });
  assert.deepEqual(await capacity.create({ db, env: {}, includedAi, notices: queue }).check(), [], 'no budget, nothing said');
  const watch = capacity.create({ db, env: { OPENROUTER_MONTHLY_BUDGET_USD: '200' }, includedAi, notices: queue });
  assert.deepEqual(await watch.check(), []);
  spent = 150.5;
  assert.deepEqual(await watch.check(), ['Closedhand: OpenRouter spend this month is $150.50 of your $200 budget. Raise the budget in OpenRouter before it is reached, or every Managed Models key stops.']);
  assert.deepEqual(await watch.check(), []);
  spent = 181;
  assert.equal((await watch.check()).length, 1, '90%');
});

test('notices go to the maintainer\'s own Closedhand once, and by email when it has not collected them in a day', async () => {
  await fresh();
  const operator = await person('Maintainer@Example.com'), someone = await person();
  const sent = [];
  const request = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return new Response('{}'); };
  const env = { OPERATOR_EMAILS: 'someone-else@example.com, maintainer@example.com', ASSISTANT_EMAIL_OPERATOR: 'alerts@example.com',
    MAIL_SES_REGION: 'eu-west-2', MAIL_FROM: 'Closedhand <hello@example.com>', MAIL_AWS_ACCESS_KEY_ID: 'AKIAFIXTURE', MAIL_AWS_SECRET_ACCESS_KEY: 'fixture' };
  const box = notices.create({ db, env, request });
  await box.queue('First notice');
  await box.queue('Second notice');
  assert.deepEqual(await box.collect(someone), [], 'nobody else gets them');
  const lookalike = await person('maintainer@example.com', false);
  assert.deepEqual(await box.collect(lookalike), [], 'nor a sign-in carrying the address unverified');
  const got = await box.collect(operator);
  assert.deepEqual(got.map(n => n.text), ['First notice', 'Second notice']);
  assert.deepEqual(await box.collect(operator), [], 'each once');
  assert.deepEqual(await notices.create({ db, env: {} }).collect(operator), [], 'no OPERATOR_EMAILS, no notices');

  await box.queue('Waiting a day');
  await db.query("UPDATE operator_notices SET created_at = now() - interval '25 hours' WHERE text = 'Waiting a day'");
  assert.equal(await box.emailStale(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails');
  assert.deepEqual(sent[0].body.Destination, { ToAddresses: ['alerts@example.com'] });
  assert.equal(sent[0].body.Content.Simple.Body.Text.Data, 'Waiting a day');
  assert.equal(await box.emailStale(), 0, 'emailed once');
  assert.deepEqual(await box.collect(operator), [], 'not said again in chat once emailed');
  assert.equal(await notices.create({ db, env: { ...env, MAIL_FROM: '' }, request }).emailStale(), 0, 'no sender, no email');
});

test('the plan says where an account stands: first month, Closedhand+, ended or none', async () => {
  const env = { ASSISTANT_EMAIL_ENABLED: '1', ASSISTANT_EMAIL_RELEASED: '1' };
  const now = new Date('2026-11-10T12:00:00Z');
  const none = await person(), first = await person(), over = await person(), plus = await person(), leaving = await person();
  assert.deepEqual(await planFor(db, {}, none, now), { name: 'none', email: false });
  await db.query("INSERT INTO included_ai_keys (owner_id, key_hash, granted_usd, ends_at) VALUES ($1, $2, 20, '2026-11-20T00:00:00Z')", [first, crypto.randomBytes(32).toString('hex')]);
  assert.deepEqual(await planFor(db, env, first, now), { name: 'first-month', ends_at: '2026-11-20T00:00:00.000Z', email: true });
  await db.query("INSERT INTO included_ai_keys (owner_id, key_hash, granted_usd, ends_at) VALUES ($1, $2, 20, '2026-11-01T00:00:00Z')", [over, crypto.randomBytes(32).toString('hex')]);
  assert.equal((await planFor(db, env, over, now)).name, 'ended');
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, current_period_end, extended_month, started_at) VALUES ($1, 'sub_a', 'active', '2026-12-01T00:00:00Z', '2026-11', now())", [plus]);
  assert.deepEqual(await planFor(db, env, plus, now), { name: 'plus', renews_at: '2026-12-01T00:00:00.000Z', extended: true, email: true });
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, current_period_end, cancel_at_period_end, started_at) VALUES ($1, 'sub_b', 'active', '2026-12-01T00:00:00Z', true, now())", [leaving]);
  assert.deepEqual(await planFor(db, env, leaving, now), { name: 'plus', ends_at: '2026-12-01T00:00:00.000Z', extended: false, email: true });
  await db.query("UPDATE plus_subscriptions SET status = 'canceled' WHERE owner_id = $1", [leaving]);
  assert.equal((await planFor(db, env, leaving, now)).name, 'ended', 'an ended subscription without a key');
});

test('Closedhand+ lifts the monthly email allowances; a daily guard stays, ten times higher', async () => {
  const reserve = async (account, direction) => (await db.query(
    "SELECT * FROM reserve_mail_relay_usage($1, $2, $3, 1, 1000)", [crypto.randomUUID(), account, direction])).rows[0];
  const mailbox = async (ownerId, email) => {
    const id = crypto.randomUUID();
    await db.query("INSERT INTO mail_relay_accounts (id, owner_id, secret_hash, public_key, address, owner_email) VALUES ($1, $2, 'h', 'k', $3, $4)",
      [id, ownerId, `fixture-${id.slice(0, 8)}@closedhand.ai`, email]);
    return id;
  };
  // What an address has sent this month and today, as the function counts it.
  const owner = email => crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  const month = new Date().toISOString().slice(0, 7) + '-01', today = new Date().toISOString().slice(0, 10);
  const sentThisMonth = (email, sent) => db.query(
    'INSERT INTO mail_relay_usage (owner_key, period, sent) VALUES ($1, $2, $3) ON CONFLICT (owner_key, period) DO UPDATE SET sent = EXCLUDED.sent', [owner(email), month, sent]);
  const sentToday = (email, sent) => db.query(
    'INSERT INTO mail_relay_usage (owner_key, period, sent) VALUES ($1, $2, $3) ON CONFLICT (owner_key, period) DO UPDATE SET sent = EXCLUDED.sent', [owner(email) + ':daily', today, sent]);

  const freeEmail = `free${people}@example.com`, plusEmail = `plus${people}@example.com`;
  const free = await mailbox(await person(freeEmail), freeEmail);
  const subscriberOwner = await person(plusEmail);
  const subscriber = await mailbox(subscriberOwner, plusEmail);
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, started_at) VALUES ($1, 'sub_mail', 'active', now())", [subscriberOwner]);
  await sentThisMonth(freeEmail, 1000);
  await sentThisMonth(plusEmail, 1000);
  assert.deepEqual(await reserve(free, 'out'), { allowed: false, reason: 'Your monthly email allowance has been reached. It resets next month.' });
  assert.deepEqual(await reserve(subscriber, 'out'), { allowed: true, reason: null }, 'no monthly allowance with Closedhand+');
  await sentToday(plusEmail, 1000);
  assert.deepEqual(await reserve(subscriber, 'out'), { allowed: false, reason: 'Your daily email allowance has been reached. It resets at midnight UTC.' }, 'the daily guard stays');
});
