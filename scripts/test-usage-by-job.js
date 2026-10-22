// Where the LLM's tokens go: once an hour the log says, for each part of
// Closedhand that called it, the calls, tokens read, the share the provider
// had cached, and tokens written (lib/usage.js). Names and counts only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const usage = require("../lib/usage");

test("the job is the first file outside the LLM plumbing", () => {
  const stack = [
    "Error",
    "    at Object.create (/app/lib/usage.js:120:23)",
    "    at Object.create (/app/lib/model-capabilities.js:40:10)",
    "    at callModel (/app/lib/llm.js:300:5)",
    "    at runComposer (/app/lib/pulse.js:330:18)",
    "    at async tick (/app/lib/scheduler.js:12:3)",
  ].join("\n");
  assert.equal(usage.jobOf(stack), "pulse");
  assert.equal(usage.jobOf("Error\n    at x (/app/lib/services/usi.js:1:1)\n    at y (/app/lib/services/wa-digest.js:2:2)"), "services/wa-digest");
  assert.equal(usage.jobOf("Error\n    at x (node:internal/timers:1:1)"), "other");
});

test("each call counts towards its job, with the cached share, and the hour's line clears", async () => {
  const fake = (u) => ({ messages: { create: async () => ({ usage: u }) } });
  const tracked = usage.withUsageTracking(fake({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 900 }), "machinery", "m");
  await tracked.messages.create({});
  await tracked.messages.create({});
  const line = usage.logJobs();
  assert.match(line, /^\[usage\] last hour by job: machinery \S+ 2 calls, 2000 in \(90% cached\), 100 out$/);
  assert.equal(usage.logJobs(), "", "nothing new, nothing said");
});
