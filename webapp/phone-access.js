// Optional phone access. The dashboard remains on this computer; cloudflared
// forwards HTTPS traffic to it. A quick tunnel gets a new address on restart.
const { spawn } = require("child_process");
const { getConf, setConf } = require("./config");
const BIN = process.env.CLOUDFLARED_BIN || "cloudflared";
const PORT = process.env.PORT || 3000;
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
let proc = null, url = null, wanted = false, state = "off", lastError = null;
let retryTimer = null, upgradeTimer = null, generation = 0, upgradeGeneration = 0, mode = "quick", pairingUrl = null;
// Keep an old publication from landing after a disable or restart clears it.
let writes = Promise.resolve();
function save(patch) {
  writes = writes.catch(() => {}).then(() => setConf(patch));
  return writes;
}
async function requirePassword() {
  if (!process.env.ADMIN_PASSWORD && !(await getConf("DASHBOARD_PASSWORD_HASH"))) {
    throw new Error("Choose a dashboard password on the setup page before turning on phone access.");
  }
}
async function start() {
  if (proc || state === "starting") return;
  const run = ++generation;
  state = "starting"; url = null; lastError = null;
  try {
    await save({ PHONE_ACCESS_URL: null });
    await requirePassword();
    let permanent = null;
    if (mode === "managed") {
      permanent = await require("./phone-registration").connection();
      if (run !== generation || !wanted) return;
      if (!permanent) {
        state = "pairing";
        const nextPairingUrl = pairingUrl || await require("./phone-registration").begin();
        if (run !== generation || !wanted) return;
        pairingUrl = nextPairingUrl;
        retryTimer = setTimeout(() => { if (wanted) void start(); }, 5000);
        return;
      }
      pairingUrl = null;
    }
    if (run !== generation || !wanted) return;
    const args = permanent ? ["tunnel", "--no-autoupdate", "run"] : ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"];
    const options = { stdio: ["ignore", "pipe", "pipe"] };
    if (permanent) options.env = { ...process.env, TUNNEL_TOKEN: permanent.token };
    const child = spawn(BIN, args, options);
    proc = child;
    let assigned = permanent?.url || null, registered = false, publishing = false;
    // A quick tunnel can lose its public address while cloudflared stays alive,
    // for example across a long network interruption. Process liveness alone
    // must not leave a dead address advertised as phone access.
    let checking = false, failures = 0;
    const healthTimer = setInterval(async () => {
      if (proc !== child || !wanted) { clearInterval(healthTimer); return; }
      if (!url || checking) return;
      checking = true;
      try {
        const response = await fetch(url + "/health", { signal: AbortSignal.timeout(10000) });
        const health = response.ok ? await response.json() : null;
        if (health?.status !== "ok" || health?.service !== "closedhand-webapp") throw new Error("Phone address is unreachable");
        failures = 0;
      } catch (_) {
        if (proc !== child || !wanted) return;
        if (++failures >= 3) {
          clearInterval(healthTimer);
          failed(new Error("Phone address stopped responding. Reconnecting."));
          child.kill();
        }
      } finally { checking = false; }
    }, 60000);
    healthTimer.unref();
    const publish = async () => {
      if (proc !== child || !wanted || !assigned || !registered || publishing) return;
      publishing = true;
      try {
        if (permanent?.verify) await require('./phone-registration').confirm(permanent);
        await save({ PHONE_ACCESS_URL: assigned });
        if (proc !== child || !wanted) return;
        url = assigned; state = "on"; lastError = null;
        console.log(`[Phone] dashboard reachable at ${url}`);
      } catch (e) {
        if (proc !== child) return;
        publishing = false;
        state = "starting"; lastError = "Waiting to verify this computer’s address.";
        setTimeout(() => { if (proc === child && wanted) void publish(); }, 5000);
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = "";
      stream.on("data", chunk => {
        if (proc !== child) return;
        buffer = (buffer + String(chunk)).slice(-8192);
        const match = buffer.match(URL_RE);
        if (match && !permanent) assigned = match[0];
        if (buffer.includes("Registered tunnel connection")) registered = true;
        void publish();
      });
    }
    const failed = (error) => {
      clearInterval(healthTimer);
      if (proc !== child) return;
      proc = null; url = null;
      state = error.code === "ENOENT" ? "unavailable" : "error";
      lastError = error.code === "ENOENT" ? "Update ClosedHand to enable phone access." : error.message;
      save({ PHONE_ACCESS_URL: null }).catch(e => console.error("[Phone] Could not clear address:", e.message));
      if (wanted && state !== "unavailable") {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { if (wanted) void start(); }, 5000);
      }
    };
    child.on("error", failed);
    child.on("exit", code => failed(new Error(`Phone connection stopped (${code}).`)));
  } catch (e) {
    if (run !== generation) return;
    state = "error"; lastError = e.message;
    console.error("[Phone]", lastError);
    // A failure before the tunnel even started used to be final: one
    // database hiccup ("the database system is in recovery mode", a few
    // seconds long) left phone access dead for hours, until a restart.
    // While it is wanted, keep trying.
    if (wanted && proc === null) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { if (wanted && !proc) void start(); }, 15000);
    }
  }
}
async function enable(nextMode = "quick", addressName) {
  await requirePassword();
  if (!["quick", "managed"].includes(nextMode)) throw new Error("Unknown phone access option.");
  let requestedPairing = null;
  if (nextMode === 'managed' && addressName) requestedPairing = await require('./phone-registration').begin(addressName);
  if (nextMode === "managed" && mode === "quick" && wanted) {
    // A person may be using the temporary address right now. Keep it alive
    // while they approve the lasting one on the provider's separate page.
    const registration = require("./phone-registration");
    if (!await registration.connection()) {
      pairingUrl = requestedPairing || await registration.begin(); state = "pairing"; lastError = null;
      const run = ++upgradeGeneration;
      clearTimeout(upgradeTimer);
      const check = async () => {
        try {
          const ready = await registration.connection();
          if (!wanted || run !== upgradeGeneration) return;
          if (ready) { await disable(); await enable("managed"); }
          else upgradeTimer = setTimeout(check, 5000);
        } catch (_) { if (run === upgradeGeneration) lastError = "Could not finish setup. Try again from your computer."; }
      };
      upgradeTimer = setTimeout(check, 5000);
      return;
    }
  }
  if (nextMode !== mode && wanted) await disable();
  mode = nextMode;
  pairingUrl = requestedPairing;
  await save({ PHONE_ACCESS: "1", PHONE_ACCESS_MODE: mode });
  wanted = true;
  await start();
}
async function disable() {
  wanted = false; ++generation; ++upgradeGeneration;
  clearTimeout(retryTimer); clearTimeout(upgradeTimer);
  const child = proc;
  proc = null; url = null; state = "off"; lastError = null; pairingUrl = null;
  if (child) child.kill();
  await save({ PHONE_ACCESS: null, PHONE_ACCESS_URL: null });
}
function status() { return { enabled: wanted, state, url, error: lastError, mode, permanent: mode === "managed", pairingUrl }; }
async function boot() {
  try {
    mode = (await getConf("PHONE_ACCESS_MODE")) === "managed" ? "managed" : "quick";
    wanted = String(await getConf("PHONE_ACCESS")) === "1";
    if (wanted) await start();
    else await save({ PHONE_ACCESS_URL: null });
  } catch (e) { console.error("[Phone] Could not restore phone access:", e.message); }
}
module.exports = { enable, disable, status, boot };
