// A Google or Microsoft sign-in its provider will never accept again is
// flagged to sign in again, so the dashboard says so instead of "connected"
// while every sync fails. Deleting the Google project a mailbox was connected
// through used to give "Project #… has been deleted" on every read, then
// deleted_client on renewal, and neither was recognised.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const google = require("../lib/services/google");
const microsoft = require("../lib/services/microsoft");

test("the refusals that never pass are recognised, and passing failures are not", () => {
  for (const msg of ["Token refresh failed: invalid_grant", "Token refresh failed: deleted_client", "Token refresh failed: invalid_client", "Token refresh failed: unauthorized_client"]) {
    assert.match(msg, google.DEAD_SIGN_IN, msg);
  }
  for (const msg of ["Token refresh failed: invalid_request", "getaddrinfo ENOTFOUND oauth2.googleapis.com", "Google API timeout", "Token refresh failed: temporarily_unavailable"]) {
    assert.doesNotMatch(msg, google.DEAD_SIGN_IN, msg);
  }
  assert.match("Microsoft token refresh failed: invalid_grant: AADSTS70000: The provided grant is not valid.", microsoft.DEAD_SIGN_IN);
  assert.match("Microsoft token refresh failed: unauthorized_client: AADSTS700016: Application not found.", microsoft.DEAD_SIGN_IN);
  assert.doesNotMatch("Microsoft token refresh failed: temporarily_unavailable", microsoft.DEAD_SIGN_IN);
});

test("a read refused because the Google project is gone flags the account", async () => {
  const deleted = new Error('Google API 403: {"error":{"code":403,"message":"Project #123456789012 has been deleted.","status":"PERMISSION_DENIED"}}');
  assert.equal(google.isDeletedAppError(deleted), true);
  assert.equal(google.isDeletedAppError(new Error("Google API 403: Rate Limit Exceeded")), false);
  const flagged = [];
  const store = { markConnectionReconnectRequired: async (service, reason) => flagged.push([service, reason]) };
  assert.equal(await google.markGoogleScopeFailure(deleted, store, "google_extra_sam"), true);
  assert.equal(await google.markGoogleScopeFailure(new Error("Google API 500: backend error"), store, "google"), false);
  assert.deepEqual(flagged, [["google_extra_sam", "its Google app is gone"]]);
});

test("a renewal refused for good flags the account, for Google and Microsoft alike", () => {
  const g = read("lib/services/google.js"), m = read("lib/services/microsoft.js");
  assert.match(g, /const dead = DEAD_SIGN_IN\.exec\(e\?\.message \|\| ""\);\n\s*if \(dead\) \{/);
  assert.match(m, /const dead = DEAD_SIGN_IN\.exec\(e\?\.message \|\| ""\);\n\s*if \(dead\) \{/);
  assert.match(m, /reject\(new Error\(`Microsoft token refresh failed: \$\{data\.error\}/, "the error code survives into the message");
});

test("a Microsoft account flagged to sign in again is not used until it is", () => {
  const conns = { microsoft: { tokens: { access_token: "a", refresh_token: "r", expiry: Date.now() + 3600000 }, metadata: { email: "sam@example.com", reconnect_required: true } } };
  const store = { connections: conns, getConnection: (k) => conns[k] };
  assert.equal(microsoft.isMicrosoftConnected(store), false);
  assert.equal(microsoft.listMicrosoftAccounts(store)[0].needsSignIn, true);
  delete conns.microsoft.metadata.reconnect_required;
  assert.equal(microsoft.isMicrosoftConnected(store), true);
});
