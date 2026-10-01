# Assistant email

Settings contains an optional email address for ClosedHand itself, using its existing name. This is separate from personal inboxes in Connections. Confirm the Google account you will email it from. The address stays the same when you rename ClosedHand. Managed address activation waits for the delivery service to have production approval.

Email it directly or forward a message to make a private request. Private replies go only to the verified owner. Copying it into an email does not give another participant access to your private information. In Settings, or by asking in a private email, approve the conversation's task, participants and exact details it may share. That approval lasts seven days. Guests must address the assistant directly to request replies. They receive only replies based on the shared brief; bookings, purchases and other new actions require the owner through the normal private task engine. A separate custom mailbox is not implemented.

## Delivery and privacy

The managed service uses Amazon SES on `assist.closedhand.ai`. It supplies addresses and delivery, not a paid inbox subscription per user. Incoming content is encrypted to the running installation before queuing and erased from the relay after acknowledgement, or after 14 days. The computer must be running to process mail. SMTP and the mail provider still handle plaintext; this is not end-to-end encrypted email. Outgoing content is encrypted at rest in the relay until sending. Unmatched feedback is retained for up to 14 days to reconcile delivery races.

The installation stores conversations and files locally (the hosted edition uses its normal database). Approved mail and supported attachment text use the existing cache/vector recall path. Guest-facing LLM calls receive only the approved brief and that permission's shared conversation. They never receive private recall, facts or tools. The same boundary applies to every primary LLM provider.

Sender authority uses SES authentication verdicts, not a claim inside the email. Unverified senders and unapproved tasks wait for review. Stopping a conversation cancels queued replies; a message already handed to the mail provider cannot be recalled. Pausing disables incoming processing and further sends. Wiping data pauses the address and clears queued content as well as local conversations.

## Operation

Cloud webapp runs the mail relay and consumes SES notifications through scoped SQS queues, with S3 for incoming MIME. The bot polls over authenticated HTTPS with an installation credential, so no inbound port or personal URL is required. The transport public key is paired to the verified website account; the private key stays encrypted on the installation.

Launch limits are 100 recipient deliveries per UTC day globally and 25 per installation, enforced under a database lock. Permanent bounces, complaints and opt-outs suppress further delivery. Transient send failures are visible; ambiguous sends are not automatically repeated. Processing claims have heartbeats; interrupted tasks require review because an external action may already have happened.

The relay webapp requires `ASSISTANT_EMAIL_ENABLED=1`, `AWS_REGION`, scoped AWS credentials, `ASSISTANT_EMAIL_BUCKET`, and inbound/feedback queue URLs and SNS topic ARNs under `ASSISTANT_EMAIL_INBOUND_QUEUE`, `ASSISTANT_EMAIL_INBOUND_TOPIC`, `ASSISTANT_EMAIL_FEEDBACK_QUEUE`, and `ASSISTANT_EMAIL_FEEDBACK_TOPIC`. Set `ASSISTANT_EMAIL_PRODUCTION=1` only after SES production access is approved in that region. Retain DLQs and inspect failed deliveries rather than discarding them.

## Verification

`node --test scripts/test-assistant-email.js` covers envelope tampering, pairing expiry, sender authority, scope expiry, private-context exclusion, recipient limits and both Anthropic and OpenAI-compatible HTTP transports. Transport release checks also exercise real PostgreSQL claims and concurrent limits, MIME attachments, duplicate ingress, isolated inboxes, feedback ordering and actual SES simulator delivery. A simulator does not replace checking real multi-party email threads before production activation.

Connected Google and Microsoft mailbox identities (including extra accounts) may
send owner requests. Private replies go to the authenticated From address, never
an arbitrary Reply-To or a CC recipient. Disconnected accounts and accounts marked
for reconnection no longer supply additional owner identities. The separately
verified account used to enable assistant email remains an owner address.

For delegated correspondence, ClosedHand drafts the purpose and permitted details
from the owner's request and returns the existing confirmation privately. The
owner need not manually fill in the Settings form. Shared replies currently go
to each approved sender individually; group reply-all is not yet supported.
