// webapp/microsoft-app.js -- ClosedHand's own Microsoft app, and how sign-ins through any Microsoft app renew.
//
// A copy of ClosedHand without a Microsoft app of its own signs in through
// this one. It is a public app: there is no secret to keep, which is how
// Microsoft intends an app that ships inside software people run themselves.
// Microsoft hands each sign-in straight to the computer that asked for it, so
// mail and calendar travel from Microsoft to that computer and nowhere else.

const CLOSEDHAND_MICROSOFT_APP_ID = "4f57d28c-dabb-4369-9874-f7c72262859b";

// Every personal Microsoft account (Outlook.com, Hotmail, Live) sits in this
// one directory; work and school accounts each have their own.
const PERSONAL_ACCOUNTS_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

const GRAPH_SCOPES = "openid profile email offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.Read.All";

// The environment wins so a fork can ship its own public app.
function appId() {
  return process.env.CLOSEDHAND_MICROSOFT_APP_ID || CLOSEDHAND_MICROSOFT_APP_ID;
}

// Where an account's sign-in renews. The first sign-in can go through
// "common", but a personal account renews reliably only at "consumers", so
// the directory is read once from the sign-in and kept with it.
function authorityFor(idToken) {
  try {
    const tid = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8")).tid;
    if (tid === PERSONAL_ACCOUNTS_TENANT) return "consumers";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid || "")) return tid;
  } catch (_) { /* no readable directory: fall back to common */ }
  return "common";
}

// What to send to renew a Microsoft sign-in, or null when nothing can.
// Sign-ins through the public app never send a secret (Microsoft refuses one
// from a public app); sign-ins through the person's own app carry its ID and
// secret; older ones fall back to the app in the environment.
function refreshRequest(tokens, scope) {
  const body = { grant_type: "refresh_token", refresh_token: tokens.refresh_token };
  if (scope) body.scope = scope;
  if (tokens.public_client) {
    body.client_id = tokens.client_id;
    return { authority: tokens.authority || "common", body };
  }
  body.client_id = tokens.client_id || process.env.MICROSOFT_CLIENT_ID;
  body.client_secret = tokens.client_secret || process.env.MICROSOFT_CLIENT_SECRET;
  if (!body.client_id || !body.client_secret) return null;
  return { authority: "common", body };
}

module.exports = { appId, authorityFor, refreshRequest, GRAPH_SCOPES, PERSONAL_ACCOUNTS_TENANT };
