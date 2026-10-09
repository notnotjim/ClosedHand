# closedhand.com

The small service behind closedhand.com. It serves the public website and
the three things a copy of Closedhand asks it for:

- **Personal URLs** (`name.closedhand.ai`): a copy asks for a name, its owner
  claims it here by signing in with Google (or Microsoft), the Cloudflare
  Worker in `workers/provisioner` builds the route, and the copy proves it
  answers at the new address before the address is marked ready.
- **Bug reports** that a person chose to send, with a receipt that can check
  only that report's outcome.
- **Assistant email relay**: a copy that turns on its own email address
  (`name-xxxxxxxx@assist.closedhand.ai`) collects its mail here and hands over
  its replies (`lib/assistant-mail-relay.js`). The owner confirms the address
  at `/assistant-email/confirm`, signed in with Google or a personal Microsoft
  account, since replies go to that address. `lib/assistant-mail-worker.js`
  moves mail through Amazon SES: incoming mail arrives on an SQS queue as an
  S3 object and is sealed to the copy's own key; replies are sent one at a
  time and never resent when the outcome is unknown. A new email (not a
  reply) may only go to the owner. Allowances are per owner (migration 008),
  and a spending guard pauses everything at the monthly reserve.

It holds no one's calendar, files or conversations, and mail only on its
way: sealed to a copy's own key, and deleted once collected or after 14 days. Owners are known by
the permanent ID Google or Microsoft gives them, never by email address.

## Running it

```
npm ci
DATABASE_URL=postgres://... SESSION_SECRET=... TOKEN_ENCRYPTION_KEY=... node server.js
```

Migrations in `migrations/` apply on start.

| Setting | What it is |
|---|---|
| `DATABASE_URL` | Postgres for owners, personal URLs and bug reports |
| `SESSION_SECRET` | 32+ random characters; signs sessions and personal URL tickets |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64; encrypts connection credentials at rest |
| `BASE_URL` | `https://closedhand.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in, asking only for the email |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft sign-in, same |
| `MICROSOFT_ASSOCIATED_APP_IDS` | Microsoft app IDs published at `/.well-known/microsoft-identity-association.json`, so their permission screens name closedhand.com (defaults to `MICROSOFT_CLIENT_ID`) |
| `PHONE_ENROLLMENT_ENABLED` | `1` to accept new personal URLs |
| `PHONE_PROVISIONER_SECRET` | Shared with the provisioner Worker |
| `BUG_RECEIPT_SECRET` | Signs bug report receipts (defaults to `SESSION_SECRET`) |
| `ADDRESS_LIMIT` | How many personal URLs may exist (default 100) |
| `TRUSTED_PROXY_HOPS` | Proxies in front that add X-Forwarded-For (default 2: Cloudflare, then Railway) |
| `ASSISTANT_EMAIL_ENABLED`, `ASSISTANT_EMAIL_RELEASED`, `ASSISTANT_EMAIL_PRODUCTION` | All `1` to offer assistant email; any other value keeps it off |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The mail transport's AWS user: send through SES, read the mail queues and bucket, invoke the guard |
| `ASSISTANT_EMAIL_INBOUND_QUEUE`, `ASSISTANT_EMAIL_INBOUND_TOPIC` | Where SES announces incoming mail |
| `ASSISTANT_EMAIL_FEEDBACK_QUEUE`, `ASSISTANT_EMAIL_FEEDBACK_TOPIC` | Where bounces and complaints arrive |
| `ASSISTANT_EMAIL_BUCKET` | Where SES stores incoming mail until it is collected |
| `ASSISTANT_EMAIL_GUARD_FUNCTION`, `ASSISTANT_EMAIL_OPERATOR` | The stop-only AWS function the spending guard calls, and who gets its alerts |

Sign-in callbacks are `BASE_URL/auth/google/callback` and
`BASE_URL/auth/microsoft/callback`.

## Workers

`workers/provisioner` builds each personal URL's Cloudflare tunnel and DNS
record; it receives routing jobs only, never owners. `workers/edge` shows a
"Closedhand is offline" page when a personal URL's computer is asleep. Copy
each `wrangler.example.jsonc` to `wrangler.jsonc` (ignored by git), fill in
the IDs, and deploy with Wrangler.

## Tests

`node --test test/e2e.js` with `DATABASE_URL` pointing at an empty Postgres
(it resets the schema). `scripts/test-closedhand-com.js` in the repo root
covers the rules that need no database.
