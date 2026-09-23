# Optional Jev screening

In setup or Settings, open **Models → Support and image models** and select
**Use Jev for selected checks**. Enter a TypeSafe API key and connect. A funded
account and a successful synthetic decision check are required before enabling it.
Unchecking disconnects Jev and removes its saved key.

Jev is optional and off by default. It currently screens the same new email
summaries and upcoming events that Pulse already passes to the support LLM.
Those selected items and time context go to TypeSafe. Connecting Jev does not
enable Pulse, change its delivery settings, or give Jev tools.

The support LLM still writes messages, performs tool work, names conversations
and produces summaries. Primary, support, image, embedding and reranking choices
remain independent. Changing the primary model does not change Jev.

## Routing

The bot's `pulse-triage.js` uses the vendored `decision-provider.js` Choice
adapter, pinned to TypeSafe's `jev-1.13.0` and its documented endpoint.
Questions identify their item explicitly because TypeSafe does not show question
IDs to the model. Flagged items retain their original source text for the support
LLM to check.

Any uncertain answer, incomplete or malformed response, network failure, timeout,
rate limit, credit error or oversized input sends the entire batch through the
existing support LLM triage. There are no immediate provider retries. Runtime
requests have a five-second timeout; connection validation allows fifteen seconds.
Input bounds avoid silently dropping or truncating additional records.

The initial confidence gates are conservative heuristics, not a claim of measured
accuracy: flag requires probability at least 0.90 and confidence 0.80; skip
requires 0.98 and 0.90 respectively. An explicit uncertain choice always falls
back. TypeSafe confidence describes its probability distribution, not verified
correctness.

## Verification

`node --test scripts/test-decisions.js scripts/test-model-settings-ui.js scripts/test-model-routing.js`

These cover the documented HTTP contract using simulated responses, per-user
isolation, disabled routing, fallback, credential redaction, connection validation,
database conflicts, and UI state. They do not measure live Jev accuracy or latency.
A funded-account evaluation of missed important items, nuisance alerts, fallback
rate, latency and cost is still needed before making performance claims or
expanding this routing to other jobs.

Protocol references:
[API](https://docs.typesafe.ai/api),
[Choice](https://docs.typesafe.ai/primitives/choice),
[Confidence](https://docs.typesafe.ai/confidence).
