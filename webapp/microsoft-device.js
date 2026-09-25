// webapp/microsoft-device.js -- Microsoft sign-in by code, through ClosedHand's own Microsoft app.
//
// The setup page shows a short code; the person enters it on Microsoft's own
// page and picks an account. This computer asks Microsoft every few seconds
// whether that has happened, and Microsoft hands the sign-in straight back
// here. No web address has to be registered with Microsoft, so the same
// sign-in works on localhost, a personal URL or a phone.

const { appId, authorityFor, GRAPH_SCOPES } = require("./microsoft-app");

const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0";

async function post(path, body) {
  const res = await fetch(LOGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

function failure(data) {
  if (data.error === "authorization_declined") return "The Microsoft sign-in was cancelled. Start again when you are ready.";
  if (data.error === "expired_token") return "That code ran out. Get a new one.";
  return "Microsoft sign-in could not finish. Get a new code and try again.";
}

// connect(tokens) saves the account and resolves to { email }.
function register(app, { requireAccess, connect }) {
  // One owner per install, so one sign-in in progress at a time.
  let pending = null;

  app.post("/api/setup/microsoft/start", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await requireAccess(req, res))) return;
    if (!appId()) return res.status(400).json({ error: "Connect Microsoft with your own app from the dashboard." });
    try {
      // Asking again while a code is still good shows the same code, so a
      // reload or a second click never strands one already typed in.
      if (pending && pending.expiresAt > Date.now() + 60000) return res.json({ code: pending.code, url: pending.url });
      const data = await post("/devicecode", { client_id: appId(), scope: GRAPH_SCOPES });
      if (!data.device_code) throw new Error(data.error_description || data.error || "no code returned");
      pending = {
        deviceCode: data.device_code,
        code: data.user_code,
        url: data.verification_uri,
        interval: (data.interval || 5) * 1000,
        expiresAt: Date.now() + (data.expires_in || 900) * 1000,
        nextAt: 0,
        busy: false,
      };
      res.json({ code: pending.code, url: pending.url });
    } catch (e) {
      console.error("[microsoft-device] Could not start sign-in:", e.message);
      res.status(503).json({ error: "Microsoft did not answer. Try again in a moment." });
    }
  });

  app.post("/api/setup/microsoft/check", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await requireAccess(req, res))) return;
    const current = pending;
    if (!current) return res.json({ idle: true });
    if (current.expiresAt < Date.now()) {
      pending = null;
      return res.status(410).json({ error: failure({ error: "expired_token" }) });
    }
    // Microsoft sets the pace; a check before it is due, or while another is
    // in flight, just reports that the sign-in is still waiting.
    if (current.busy || Date.now() < current.nextAt) return res.json({ pending: true });
    current.busy = true;
    try {
      let data;
      try {
        data = await post("/token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: appId(),
          device_code: current.deviceCode,
        });
      } catch (e) {
        // Microsoft out of reach for a moment: the code is still good, so
        // keep waiting rather than make the person start again.
        console.error("[microsoft-device] Check failed, will retry:", e.message);
        current.nextAt = Date.now() + current.interval;
        return res.json({ pending: true });
      }
      current.nextAt = Date.now() + current.interval;
      if (data.error === "authorization_pending") return res.json({ pending: true });
      if (data.error === "slow_down") { current.interval += 5000; return res.json({ pending: true }); }
      if (pending === current) pending = null;
      if (data.error || !data.access_token) {
        console.error("[microsoft-device] Sign-in failed:", data.error, (data.error_description || "").split("\n")[0]);
        return res.status(400).json({ error: failure(data) });
      }
      const account = await connect({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expiry: Date.now() + (data.expires_in || 3600) * 1000,
        client_id: appId(),
        public_client: true,
        authority: authorityFor(data.id_token),
      });
      res.json({ connected: true, email: account.email });
    } catch (e) {
      if (pending === current) pending = null;
      console.error("[microsoft-device] Could not finish sign-in:", e.message);
      res.status(503).json({ error: e.userMessage || "Microsoft sign-in could not finish. Get a new code and try again." });
    } finally {
      current.busy = false;
    }
  });
}

module.exports = { register };
