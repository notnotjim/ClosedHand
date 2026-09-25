# closedhand.com

The small service behind closedhand.com. It serves the public website and
the three things a copy of ClosedHand asks it for:

- **Personal URLs** (`name.closedhand.ai`): a copy asks for a name, its owner
  confirms it here by signing in with Google (or Microsoft), the Cloudflare
  Worker in `workers/provisioner` builds the route, and the copy proves it
  answers at the new address before the address is marked ready.
- **Bug reports** that a person chose to send, with a receipt that can check
  only that report's outcome.
- **Assistant email relay**: not offered yet. `/api/assistant-mail-relay/availability`
  answers `{ "available": false }`.

It holds no one's mail, calendar, files or conversations. Owners are known by
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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in, asking only for name and email |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft sign-in, same |
| `PHONE_ENROLLMENT_ENABLED` | `1` to accept new personal URLs |
| `PHONE_PROVISIONER_SECRET` | Shared with the provisioner Worker |
| `BUG_RECEIPT_SECRET` | Signs bug report receipts (defaults to `SESSION_SECRET`) |
| `ADDRESS_LIMIT` | How many personal URLs may exist (default 100) |
| `TRUSTED_PROXY_HOPS` | Proxies in front that add X-Forwarded-For (default 2: Cloudflare, then Railway) |

Sign-in callbacks are `BASE_URL/auth/google/callback` and
`BASE_URL/auth/microsoft/callback`.

## Workers

`workers/provisioner` builds each personal URL's Cloudflare tunnel and DNS
record; it receives routing jobs only, never owners. `workers/edge` shows a
"ClosedHand is offline" page when a personal URL's computer is asleep. Copy
each `wrangler.example.jsonc` to `wrangler.jsonc` (ignored by git), fill in
the IDs, and deploy with Wrangler.

## Tests

`node --test test/e2e.js` with `DATABASE_URL` pointing at an empty Postgres
(it resets the schema). `scripts/test-closedhand-com.js` in the repo root
covers the rules that need no database.
