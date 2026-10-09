// The shared secrets ClosedHand's parts trust each other with. A missing,
// short or placeholder one is refused at boot: with "change-me-dev-secret",
// say, anyone who reaches the dashboard could forge a web chat ticket. Both
// installers (install.sh, the Mac app) generate long random values.
//
// Vendored duplicate: lib/required-secrets.js and webapp/required-secrets.js
// must stay byte-identical.
const PLACEHOLDERS = new Set([
  "fallback-dev-secret", "change-me-dev-secret", "change-me-sandbox-token",
  "change-me-to-a-long-random-string", "postgres",
]);
const MIN_LENGTH = 24;

function problem(name, value) {
  if (!value) return `${name} is not set`;
  if (PLACEHOLDERS.has(value) || /^change-?me/i.test(value)) return `${name} is still the example value`;
  if (value.length < MIN_LENGTH) return `${name} is shorter than ${MIN_LENGTH} characters`;
  return null;
}

// The value, or a stop at boot naming what to fix.
function requireSecret(name) {
  const value = process.env[name] || "";
  const why = problem(name, value);
  if (why) {
    throw new Error(`[secrets] ${why}. Refusing to start. Set it in .env to a long random value (openssl rand -hex 24); install.sh does this.`);
  }
  return value;
}

module.exports = { requireSecret, problem };
