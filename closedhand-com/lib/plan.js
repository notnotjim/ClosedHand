// Where an account stands with Closedhand Managed Models, as its computer and
// its account page are told (lib/addresses.js): its first month, Closedhand+,
// ended (it had one or the other and neither runs now), or none (it never
// had Managed Models; its own LLM provider is all it uses). Whether
// Closedhand's own email is offered here rides along, so the computer can say
// what Closedhand+ includes.
const LIVE = ['active', 'trialing', 'past_due'];

async function planFor(db, env, ownerId, now = new Date()) {
  const email = env.ASSISTANT_EMAIL_ENABLED === '1' && env.ASSISTANT_EMAIL_RELEASED === '1';
  if (!ownerId) return { name: 'none', email };
  const sub = (await db.query(
    'SELECT status, current_period_end, cancel_at_period_end, extended_month, started_at FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0];
  if (sub && LIVE.includes(sub.status)) {
    const until = sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null;
    return {
      name: 'plus',
      ...(until ? (sub.cancel_at_period_end ? { ends_at: until } : { renews_at: until }) : {}),
      extended: sub.extended_month === now.toISOString().slice(0, 7),
      email,
    };
  }
  const key = (await db.query('SELECT ends_at, stopped_at FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
  if (key && key.ends_at && !key.stopped_at && new Date(key.ends_at) > now) {
    return { name: 'first-month', ends_at: new Date(key.ends_at).toISOString(), email };
  }
  if (key || sub?.started_at) return { name: 'ended', email };
  return { name: 'none', email };
}

module.exports = { planFor, LIVE };
