// Slack, Meta and LINE make the secrets that sign their webhooks, and how they
// make them is theirs. What Closedhand holds them to is a floor: a secret
// shorter than 32 characters (16 random bytes written as hex, 128 bits) is
// not used, and every webhook is refused until the full secret is saved.
const MIN_LENGTH = 32;
const warned = new Set();

function usableSecret(name, secret) {
  if (!secret) return null;
  if (String(secret).length >= MIN_LENGTH) return String(secret);
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[webhooks] ${name} is shorter than ${MIN_LENGTH} characters, so its webhooks are refused. Copy the whole secret from the app's settings.`);
  }
  return null;
}

module.exports = { usableSecret, MIN_LENGTH };
