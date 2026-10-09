// webapp/google-app.js -- Closedhand's own Google app, and which app renews each Google sign-in.
//
// Official builds carry the ID and secret of Closedhand's Google app, a
// "Desktop app" client, added when the Docker images and the Mac app are
// built. They are not in the source: Google's API terms keep developer
// credentials out of open-source projects, so a build from source has no
// Closedhand app and connects through the person's own Google project, as
// before. Google treats a desktop app's secret as public by design (it ships
// inside the software), and hands each sign-in straight back to the computer
// that asked for it, so mail, calendar and Drive travel from Google to that
// computer and nowhere else.

function app() {
  const clientId = String(process.env.CLOSEDHAND_GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.CLOSEDHAND_GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) return null;
  return { clientId, clientSecret };
}

// Google sends a desktop app's sign-in back only to this computer's own
// address, so the quick route works only where Closedhand's address is local.
function canReturnTo(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch (_) { return false; }
}

// What renews a Google sign-in: the app that made it. Each sign-in through
// Closedhand's app, or through an app of the person's own picked at sign-in,
// keeps that app's ID and secret with it; older sign-ins use the app saved
// during setup.
function clientFor(tokens, ownId, ownSecret) {
  if (tokens?.client_id && tokens?.client_secret) return { client_id: tokens.client_id, client_secret: tokens.client_secret };
  if (ownId && ownSecret) return { client_id: ownId, client_secret: ownSecret };
  return null;
}

module.exports = { app, canReturnTo, clientFor };
