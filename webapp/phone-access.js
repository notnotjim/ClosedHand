// Optional phone access. The dashboard remains on this computer; cloudflared
// forwards HTTPS traffic to it. A quick tunnel gets a new address on restart.
const { spawn } = require("child_process");
const { getConf, setConf } = require("./config");
const BIN = process.env.CLOUDFLARED_BIN || "cloudflared";
const PORT = process.env.PORT || 3000;
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
let proc = null, url = null, wanted = false, state = "off", lastError = null;
let retryTimer = null, generation = 0;
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
    if (run !== generation || !wanted) return;
    const child = spawn(BIN, ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
    proc = child;
    let assigned = null, registered = false, publishing = false;
    const publish = async () => {
      if (proc !== child || !wanted || !assigned || !registered || publishing) return;
      publishing = true;
      try {
        await save({ PHONE_ACCESS_URL: assigned });
        if (proc !== child || !wanted) return;
        url = assigned; state = "on";
        console.log(`[Phone] dashboard reachable at ${url}`);
      } catch (e) {
        if (proc !== child) return;
        state = "error"; lastError = "Could not save the phone address.";
        child.kill();
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = "";
      stream.on("data", chunk => {
        if (proc !== child) return;
        buffer = (buffer + String(chunk)).slice(-8192);
        const match = buffer.match(URL_RE);
        if (match) assigned = match[0];
        if (buffer.includes("Registered tunnel connection")) registered = true;
        void publish();
      });
    }
    const failed = (error) => {
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
  }
}
async function enable() {
  await requirePassword();
  await save({ PHONE_ACCESS: "1" });
  wanted = true;
  await start();
}
async function disable() {
  wanted = false; ++generation;
  clearTimeout(retryTimer);
  const child = proc;
  proc = null; url = null; state = "off"; lastError = null;
  if (child) child.kill();
  await save({ PHONE_ACCESS: null, PHONE_ACCESS_URL: null });
}
function status() { return { enabled: wanted, state, url, error: lastError }; }
async function boot() {
  try {
    wanted = String(await getConf("PHONE_ACCESS")) === "1";
    if (wanted) await start();
    else await save({ PHONE_ACCESS_URL: null });
  } catch (e) { console.error("[Phone] Could not restore phone access:", e.message); }
}
module.exports = { enable, disable, status, boot };
