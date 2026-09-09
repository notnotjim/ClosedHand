// webapp/phone-access.js -- Reach the dashboard from your phone.
//
// A Cloudflare quick tunnel from this container to the dashboard: no account,
// no router settings, a random trycloudflare.com address that exists only
// while the toggle is on. The dashboard password stays the lock; the address
// on its own shows nothing but the login page. The choice is remembered in
// the runtime config, so a restart brings the tunnel back up (with a new
// address, which the dashboard shows).

const { spawn } = require("child_process");
const { getConf, setConf } = require("./config");

const BIN = process.env.CLOUDFLARED_BIN || "cloudflared";
const PORT = process.env.PORT || 3000;
// The assigned address; cloudflared also logs its own api.trycloudflare.com,
// which is not it.
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

let proc = null;
let url = null;
let wanted = false;
let state = "off"; // off | starting | on | unavailable | error
let lastError = null;
let retryTimer = null;

function start() {
  if (proc) return;
  state = "starting"; url = null; lastError = null;
  let child;
  try {
    child = spawn(BIN, ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    state = "unavailable"; lastError = e.message; return;
  }
  proc = child;
  const onLine = (chunk) => {
    const m = String(chunk).match(URL_RE);
    if (m && !url) {
      url = m[0]; state = "on"; console.log(`[Phone] dashboard reachable at ${url}`);
      // The bot reads this to build links a phone can open.
      setConf({ PHONE_ACCESS_URL: url }).catch(() => {});
    }
  };
  child.stdout.on("data", onLine);
  child.stderr.on("data", onLine);
  child.on("error", (e) => {
    proc = null; url = null;
    state = e.code === "ENOENT" ? "unavailable" : "error";
    lastError = e.code === "ENOENT" ? "cloudflared is not in this image" : e.message;
    console.error(`[Phone] ${lastError}`);
  });
  child.on("exit", (code) => {
    proc = null; url = null;
    setConf({ PHONE_ACCESS_URL: null }).catch(() => {});
    if (!wanted || state === "unavailable") { if (state !== "unavailable") state = "off"; return; }
    state = "error"; lastError = `tunnel exited (${code})`;
    console.error(`[Phone] ${lastError}; retrying in 5s`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (wanted) start(); }, 5000);
  });
}

function stop() {
  clearTimeout(retryTimer);
  if (proc) { try { proc.kill(); } catch (_) {} }
  proc = null; url = null; state = "off";
  setConf({ PHONE_ACCESS_URL: null }).catch(() => {});
}

async function enable() {
  wanted = true;
  await setConf({ PHONE_ACCESS: "1" });
  start();
}

async function disable() {
  wanted = false;
  await setConf({ PHONE_ACCESS: null });
  stop();
}

function status() {
  return { enabled: wanted, state, url, error: lastError };
}

// On boot: bring the tunnel back if it was on.
async function boot() {
  try {
    if (String(await getConf("PHONE_ACCESS")) === "1") { wanted = true; start(); }
  } catch (_) { /* config not ready yet: the toggle still works later */ }
}

module.exports = { enable, disable, status, boot };
