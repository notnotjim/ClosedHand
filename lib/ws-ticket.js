// The tickets the dashboard signs for the bot (webapp/bot-call.js and the web
// chat's): "<userId>.<expiry>.<hmac>" with WS_AUTH_SECRET. On its own so the
// bot can check one without loading the rest of the web chat, as it does
// while it sits still during a move (lib/move-idle.js).
const crypto = require("crypto");

// Required at boot (index.js, required-secrets.js); never a known fallback.
const WS_AUTH_SECRET = process.env.WS_AUTH_SECRET || "";

function verifyToken(token) {
  if (!token || !WS_AUTH_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const userId = parts[0];
  const exp = parseInt(parts[1], 10);
  const sig = parts[2];

  // Check expiry
  if (Date.now() > exp) return null;

  // Verify HMAC
  const payload = `${userId}.${exp}`;
  const hmac = crypto.createHmac("sha256", WS_AUTH_SECRET);
  hmac.update(payload);
  const expected = hmac.digest("hex");

  if (expected.length !== sig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) return null;
  } catch {
    return null;
  }

  return userId;
}

module.exports = { verifyToken };
