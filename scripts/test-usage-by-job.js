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
  assert.equal(usage.jobOf("Error\n    at x (/app/lib/model-jobs.js:9:9)\n    at y (/app/lib/pulse-triage.js:36:3)"), "pulse-triage", "the job runner is plumbing too");
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

test("with USAGE_EACH_CALL=1 each call is said as it happens", () => {
  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  try {
    usage.recordJob("machinery", "pulse", { input_tokens: 4000, cache_read_input_tokens: 3000, output_tokens: 20 }, { USAGE_EACH_CALL: "1" });
    usage.recordJob("machinery", "pulse", { input_tokens: 4000, output_tokens: 20 }, {});
  } finally { console.log = log; }
  assert.deepEqual(said, ["[usage] machinery pulse: 4000 in (75% cached), 20 out"]);
  usage.logJobs();
});
