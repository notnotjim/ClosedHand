// sandbox-image/agent/server.js — Sandbox agent running inside each user's container
// Exposes HTTP endpoints for code execution, file operations, and package management.

const express = require("express");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const app = express();
app.use(express.json({ limit: "500mb" }));

const PORT = process.env.PORT || 8080;
const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN;
// Inside the container the workspace is /workspace and every tool is on PATH.
// The desktop app runs this same agent on the Mac and says where things are:
// a workspace folder in its data directory, a Python it sets up with uv, a
// Chrome of the user's own launched with Closedhand's profile.
const DESKTOP = process.env.SANDBOX_MODE === "desktop";
const VM = process.env.SANDBOX_MODE === "vm";
const WORKSPACE = process.env.WORKSPACE || "/workspace";
const EXEC_HOME = process.env.EXEC_HOME || "/home/sandbox";
const PYTHON = process.env.PYTHON || "python3";
const UV = process.env.UV || "";
const CDP_PORT = process.env.CDP_PORT || "9222";
const BROWSER_CMD = process.env.BROWSER_CMD || "";
// On the desktop, code the model runs is confined with the system sandbox: a
// profile (written by the app) that lets it read the system, the app bundle
// and the workspace, write only the workspace and the temporary folder, and
// use the network. Without it the Workspace would be an open door onto the
// Mac; the container needs nothing, it is the fence.
const SANDBOX_PROFILE = process.env.SANDBOX_PROFILE || "";
const BROWSER_PROFILE = path.join(WORKSPACE, ".chromium-profile");
// The hidden browser: a second Chrome with no window, which Closedhand uses
// wherever it is the better choice (lib/tools/handlers.js decides). It keeps
// no profile of its own; the logins come from the visible one's cookies.
const HEADLESS_PORT = process.env.HEADLESS_CDP_PORT || "9223";
const HEADLESS_PROFILE = path.join(os.tmpdir(), "closedhand-headless");
const HEADLESS_IDLE_MS = 10 * 60 * 1000;
// What the container image pre-installs, so code written for one runs on the other.
const PY_PACKAGES = ["pandas", "numpy", "requests", "matplotlib", "beautifulsoup4", "pillow", "openpyxl", "playwright", "lxml", "scipy", "scikit-learn", "seaborn", "tabulate", "python-dateutil", "pytz", "httpx", "pydantic", "chardet", "plotly", "yt-dlp", "av"];
const MAX_TIMEOUT = 120000; // 120s absolute max
const DEFAULT_TIMEOUT = 30000; // 30s default
const MAX_OUTPUT = 8000; // chars

// --- Auth middleware ---
// Compared in the same time whatever the guess, so timing can't spell out a secret.
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a || "")).digest(), crypto.createHash("sha256").update(String(b || "")).digest());
// Without a token nothing is answered: an agent started without one once
// took every request from anything on its network. SANDBOX_DEV=1 lets a
// developer run it bare on their own computer.
function auth(req, res, next) {
  if (!SANDBOX_TOKEN) {
    if (process.env.SANDBOX_DEV === "1") return next();
    return res.status(503).json({ error: "The sandbox computer has no token set, so it answers nothing." });
  }
  const token = req.headers["x-sandbox-token"];
  if (!token || !sameSecret(token, SANDBOX_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
app.use("/exec", auth);
app.use("/browse", auth);
app.use("/files", auth);
app.use("/packages", auth);

// --- Path safety ---
function safePath(userPath) {
  const root = fs.realpathSync(WORKSPACE);
  const resolved = path.resolve(WORKSPACE, userPath || ".");
  const within = value => value === root || value.startsWith(root + path.sep);
  if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) throw new Error("Path traversal blocked");
  let ancestor = resolved;
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      if (!within(fs.realpathSync(ancestor))) throw new Error("Path traversal blocked");
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink is not a safe parent for a future write.
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error("Path traversal blocked"); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("Path traversal blocked");
      ancestor = parent;
    }
  }
  return resolved;
}

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.substring(0, max) + `\n... (truncated, ${str.length} chars total)`;
}

// --- Python on the desktop ---
// The container has Python baked in. On a Mac the agent makes its own with uv
// on first start (a managed 3.12 in a venv beside the workspace), so nothing
// depends on what the Mac happens to have installed. Until it is ready, code
// runs say so instead of failing strangely.
let pythonState = DESKTOP ? "checking" : "ready";
let pythonError = "";
function ensurePython() {
  if (!DESKTOP) return;
  if (!UV) { pythonState = fs.existsSync(PYTHON) ? "ready" : "missing"; pythonError = "No uv bundled"; return; }
  const venv = path.dirname(path.dirname(PYTHON));
  // The package set is recorded beside the venv; when a release adds to the
  // list, an existing Workspace tops itself up (quick when nothing is missing)
  // and stays usable meanwhile.
  const marker = path.join(venv, ".closedhand-packages");
  const wanted = PY_PACKAGES.join(" ");
  const have = fs.existsSync(PYTHON);
  let recorded = ""; try { recorded = fs.readFileSync(marker, "utf8").trim(); } catch {}
  if (have && recorded === wanted) { pythonState = "ready"; return; }
  pythonState = have ? "ready" : "installing";
  const uv = (args) => new Promise((resolve) => execFile(UV, args, { cwd: WORKSPACE, timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
  (async () => {
    console.log(have ? "[python] topping up the workspace's packages" : "[python] setting up a Python for the workspace with uv");
    let r = have ? { err: null } : await uv(["venv", "--python", "3.12", "--allow-existing", venv]);
    if (!r.err) r = await uv(["pip", "install", "--python", PYTHON, ...PY_PACKAGES]);
    if (r.err) { if (!have) pythonState = "error"; pythonError = truncate(r.stderr || r.err.message, 600); console.error("[python] setup failed:", pythonError); }
    else { pythonState = "ready"; pythonError = ""; try { fs.writeFileSync(marker, wanted + "\n"); } catch {} console.log("[python] ready"); }
  })();
}
ensurePython();

// The environment code runs in. On the desktop the helper modules sit beside
// this file and the browser is wherever the app put it.
function execEnv() {
  const env = { ...process.env, HOME: EXEC_HOME, CDP_URL: `http://127.0.0.1:${CDP_PORT}`, HEADLESS_CDP_URL: `http://127.0.0.1:${HEADLESS_PORT}` };
  if (DESKTOP) env.PYTHONPATH = __dirname + (process.env.PYTHONPATH ? ":" + process.env.PYTHONPATH : "");
  return env;
}

// --- The browser on the desktop: Chrome over its debugging port ---
function httpJson(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = require("http").get(url, { timeout }, (r) => {
      let body = ""; r.on("data", (c) => body += c); r.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}
async function cdpTargets() {
  try { return await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`); } catch { return null; }
}
let browserPid = null;
function launchBrowser(url) {
  if (!BROWSER_CMD) throw new Error("No Chrome, Chromium, Brave or Edge found on this Mac.");
  fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  const child = spawn(BROWSER_CMD, [
    `--user-data-dir=${BROWSER_PROFILE}`, `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run", "--no-default-browser-check", "--new-window", url || "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  browserPid = child.pid;
  return child.pid;
}
function focusBrowser() {
  if (!browserPid) return;
  execFile("osascript", ["-e", `tell application "System Events" to set frontmost of (every process whose unix id is ${browserPid}) to true`], { timeout: 4000 }, () => {});
}
// One screenshot of the page in front, over the debugging protocol.
function cdpScreenshot() {
  return new Promise(async (resolve, reject) => {
    const targets = await cdpTargets();
    const page = (targets || []).find((t) => t.type === "page" && !/^(chrome|devtools):/.test(t.url || "")) || (targets || []).find((t) => t.type === "page");
    if (!page || !page.webSocketDebuggerUrl) return reject(new Error("no browser"));
    const WebSocket = require("ws");
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("screenshot timed out")); }, 8000);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 60 } })));
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer); ws.close();
      if (msg.error || !msg.result) return reject(new Error((msg.error && msg.error.message) || "no screenshot"));
      resolve({ screenshot: msg.result.data, format: "jpeg", title: page.title || "", url: page.url || "" });
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
// One command to a page over the debugging protocol.
function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const WebSocket = require("ws");
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`${method} timed out`)); }, 8000);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer); ws.close();
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// The bot drives one tab (browser_helper.py marks it) and leaves it wherever
// the last call did. A finished job's page kept running for hours: a booking
// site's trackers held a core and over a gigabyte. After a quiet spell the
// bot's tab goes blank, still marked so the next call reuses it. Tabs the
// person opened are never touched.
const TAB_MARKER = "closedhand-bot"; // the same as browser_helper.py's
const PARK_AFTER_MS = 10 * 60 * 1000;
let lastExecAt = Date.now();
let parked = false;
async function parkIdleTab() {
  if (parked || Date.now() - lastExecAt < PARK_AFTER_MS) return;
  parked = true;
  for (const t of (await cdpTargets()) || []) {
    if (t.type !== "page" || !t.webSocketDebuggerUrl || t.url === "about:blank") continue;
    try {
      const named = await cdpCall(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "window.name", returnByValue: true });
      if (named?.result?.value !== TAB_MARKER) continue;
      await cdpCall(t.webSocketDebuggerUrl, "Page.navigate", { url: "about:blank" });
      // Leaving a site clears window.name, so the mark goes back on.
      await new Promise((r) => setTimeout(r, 500));
      await cdpCall(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression: `window.name = ${JSON.stringify(TAB_MARKER)}` });
      console.log(`[browser] blanked the bot's tab after ${PARK_AFTER_MS / 60000} quiet minutes`);
    } catch { parked = false; /* a page mid-load or gone; the next round tries again */ }
  }
}
setInterval(() => { parkIdleTab().catch(() => {}); }, 60 * 1000).unref();

// The browser was started by this agent; it goes when the agent goes.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { if (browserPid) { try { process.kill(browserPid); } catch {} } try { browseChild && browseChild.kill(); } catch {} stopHeadless(); process.exit(0); });

// --- Health ---
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    workspace: WORKSPACE,
    user: os.userInfo().username,
    confined: !DESKTOP,
    isolation: VM ? "virtual-machine" : DESKTOP ? "process-policy" : "container",
  });
});

// The Mac controller may stop an unused VM, but never a running command,
// package install, background program or unfinished browser download.
app.get("/runtime/activity", auth, (_req, res) => {
  if (!VM) return res.json({ busy: true });
  try {
    const services = new Set(["chromium", "chrome_crashpad", "Xvfb", "openbox", "x11vnc", "websockify", "socat"]);
    const busy = fs.readdirSync("/proc").some(pid => {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
      try {
        if (fs.statSync("/proc/" + pid).uid !== process.getuid()) return false;
        return !services.has(fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim());
      } catch (error) { return error.code !== "ENOENT" && error.code !== "ESRCH"; }
    }) || fs.readdirSync(WORKSPACE).some(name => name.endsWith(".crdownload"));
    res.json({ busy });
  } catch { res.json({ busy: true }); }
});

// Stream an upgrade's existing Workspace files into Linux. Never overwrite a
// file already present after an interrupted import, and never execute it.
app.put("/runtime/import-file", auth, (req, res) => {
  if (!VM) return res.sendStatus(404);
  let destination, temporary;
  try {
    destination = safePath(String(req.query.path || ""));
    if (destination === WORKSPACE) throw new Error("A file path is required");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    destination = safePath(String(req.query.path));
    temporary = path.join(path.dirname(destination), ".import-" + crypto.randomBytes(12).toString("hex"));
  } catch (error) { req.resume(); return res.status(400).json({ error: error.message }); }
  const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  require("stream").pipeline(req, output, error => {
    if (error) { try { fs.unlinkSync(temporary); } catch {} return res.destroy(); }
    try {
      try { fs.linkSync(temporary, destination); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      res.json({ imported: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  });
});

// --- Desktop environment ---
app.get("/desktop/status", auth, async (_req, res) => {
  if (DESKTOP) {
    const targets = await cdpTargets();
    return res.json({ status: targets ? "running" : "no-browser", desktop: "browser", cdp_port: Number(CDP_PORT),
      browser: BROWSER_CMD ? "available" : "missing", python: pythonState, python_error: pythonError || undefined });
  }
  try {
    const xvfb = require("child_process").execSync("pgrep -c Xvfb", { timeout: 2000 }).toString().trim();
    const vnc = require("child_process").execSync("pgrep -c x11vnc", { timeout: 2000 }).toString().trim();
    const ws = require("child_process").execSync("pgrep -cf websockify", { timeout: 2000 }).toString().trim();
    res.json({ status: "running", display: ":99", vnc_ws_port: 6080, resolution: "1280x800", desktop: "browser", procs: { xvfb, vnc, ws } });
  } catch (e) {
    res.json({ status: "degraded", error: e.message });
  }
});

app.post("/desktop/screenshot", auth, async (_req, res) => {
  if (DESKTOP) {
    try { return res.json(await cdpScreenshot()); }
    catch (e) { return res.status(503).json({ error: e.message }); }
  }
  const tmpPath = `/tmp/screen_${crypto.randomBytes(4).toString("hex")}.png`;
  execFile("scrot", [tmpPath], { timeout: 5000, env: { ...process.env, DISPLAY: ":99" } }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      const data = fs.readFileSync(tmpPath).toString("base64");
      fs.unlinkSync(tmpPath);
      res.json({ screenshot: data, format: "png" });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

app.post("/desktop/browser", auth, async (req, res) => {
  const { url, focus } = req.body || {};
  if (DESKTOP) {
    try {
      const running = !!(await cdpTargets());
      let status = "already_running";
      if (!running) { launchBrowser(url); status = "launched"; }
      if (focus) setTimeout(focusBrowser, running ? 0 : 1500);
      return res.json({ status, url: url || undefined });
    } catch (e) { return res.status(409).json({ error: e.message }); }
  }
  // Check if already running
  try {
    require("child_process").execSync("pgrep -f 'chromium.*user-data-dir'", { timeout: 2000 });
    res.json({ status: "already_running" });
    return;
  } catch { /* not running, launch */ }
  spawn("/usr/local/bin/chromium-launcher", ["--start-maximized", url || "about:blank"],
    { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: ":99" } }).unref();
  res.json({ status: "launched", url: url || "about:blank" });
});

// The screen's shape. The screen is taller than it looks (entrypoint.sh):
// a laptop-shaped part of it, 1280x800, is shown and sent, unless someone is
// using the browser full screen on a phone. Then a phone-shaped part is, at
// least 508 wide, Chrome's narrowest window, so sites send their phone
// layouts and taps land where they look. openbox keeps every window inside
// the part shown (its margins) and x11vnc sends only that part (its clip).
// The phone asks again every half minute while it looks; when it stops, the
// laptop shape comes back by itself. Closedhand's own browsing
// (browser_helper.py) always gets the laptop shape.
const SCREEN = { width: 1280, height: 1280 }, LAPTOP = { width: 1280, height: 800 }, NARROWEST = 508;
const PHONE_FOR_MS = 90 * 1000;
const OPENBOX_RC = path.join(os.homedir(), ".config", "openbox", "rc.xml");
let shape = LAPTOP, shapeTimer = null;
function onScreen(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 8000, env: { ...process.env, DISPLAY: ":99" } }, (e) => (e ? reject(e) : resolve())));
}
// Closedhand is browsing while a step runs, and for a moment after, while its
// LLM decides the next one.
function botBrowsing() {
  return browseBusy > 0 || Date.now() - lastBrowseAt < 20000;
}
async function setShape(next) {
  const laptop = next.width === LAPTOP.width && next.height === LAPTOP.height;
  if (next.width !== shape.width || next.height !== shape.height) {
    if (laptop) {
      fs.rmSync(OPENBOX_RC, { force: true });
      await onScreen("openbox", ["--reconfigure"]);
      await onScreen("x11vnc", ["-display", ":99", "-sync", "-remote", "clip:1280x800+0+0"]);
      await fitWindows(null);
      shape = { ...LAPTOP };
    } else {
      // Chrome's own bars sit above the part shown: the phone's own bar
      // (web chat) stands in for them, as a phone browser's does. Their
      // height is measured, the window grown by it, and the part shown
      // starts below them.
      await placeWindows(next.width, SCREEN.height);
      await fitWindows(next);
      const { bars, frame } = await chromeAround();
      // The page is the phone's shape exactly, without the frame's width.
      const width = next.width - 2 * frame, height = Math.round(width * next.height / next.width);
      await placeWindows(next.width + 2, height + bars + 2);
      await fitWindows({ width: next.width, height: height + bars });
      const at = await chromeAround();
      const top = at.top + bars - frame, left = at.left + frame;
      await onScreen("x11vnc", ["-display", ":99", "-sync", "-remote", `clip:${width}x${height}+${left}+${top}`]);
      shape = { width, height, top };
    }
  }
  await phoneMode(!laptop).catch((e) => console.error("[shape] phone mode:", e.message));
  clearTimeout(shapeTimer);
  if (!laptop) shapeTimer = setTimeout(() => queueShape(LAPTOP).catch((e) => console.error("[shape]", e.message)), PHONE_FOR_MS);
  return shape;
}
// One change of shape at a time: two overlapping left the part shown at one
// size and Chrome's window at the other.
let shaping = Promise.resolve();
function queueShape(next) {
  const run = shaping.then(() => setShape(next));
  shaping = run.catch(() => {});
  return run;
}
// openbox places and maximizes windows only inside width x height, top left.
async function placeWindows(width, height) {
  const rc = fs.readFileSync("/etc/xdg/openbox/rc.xml", "utf8").replace(/<margins>[\s\S]*?<\/margins>/,
    `<margins><top>0</top><bottom>${SCREEN.height - height}</bottom><left>0</left><right>${SCREEN.width - width}</right></margins>`);
  fs.mkdirSync(path.dirname(OPENBOX_RC), { recursive: true });
  fs.writeFileSync(OPENBOX_RC, rc);
  await onScreen("openbox", ["--reconfigure"]);
}
// The tab in front, and the window height its page doesn't get: Chrome's
// tab strip and toolbar.
const BROWSER_UI = /^(devtools|chrome-untrusted|chrome-extension):|^chrome:\/\/[^/]*top-chrome/;
async function frontTab() {
  for (const t of (await cdpTargets()) || []) {
    if (t.type !== "page" || !t.webSocketDebuggerUrl || BROWSER_UI.test(t.url || "")) continue;
    const seen = await cdpCall(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "[document.visibilityState, outerHeight - innerHeight, outerWidth - innerWidth].join(' ')", returnByValue: true }).catch(() => null);
    const [state, bars, sides] = String(seen?.result?.value || "").split(" ");
    if (state === "visible") return { ...t, bars: Number(bars), frame: Number(sides) / 2 };
  }
  return null;
}
// Asked of the page itself: what the window has besides the page is
// Chrome's bars above it and, not maximized, a thin frame all round, as
// thick at the bottom as at the sides. Straight after a resize a page can
// answer 0 for a moment, so it is asked again until it settles; the last
// good answer stands in if it never does.
let chromeSeen = { bars: 0, frame: 0, left: 0, top: 0 };
async function chromeAround() {
  for (let tries = 0; tries < 10; tries++) {
    const tab = await frontTab().catch(() => null);
    if (tab && tab.bars > 0 && tab.bars < 200 && tab.frame >= 0 && tab.frame <= 12) {
      // Where the window is too: openbox can put it a pixel off the corner.
      const at = await cdpCall(tab.webSocketDebuggerUrl, "Browser.getWindowForTarget").catch(() => null);
      return (chromeSeen = { bars: tab.bars, frame: tab.frame, left: at?.bounds?.left || 0, top: at?.bounds?.top || 0 });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return chromeSeen;
}
// Chrome's windows fill the part shown. Maximized, Chrome stays at least 640
// wide, so for a phone they are sized instead, which goes down to 508.
async function fitWindows(size) {
  const windows = new Map();
  for (const t of (await cdpTargets()) || []) {
    if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
    const found = await cdpCall(t.webSocketDebuggerUrl, "Browser.getWindowForTarget").catch(() => null);
    if (found && !windows.has(found.windowId)) windows.set(found.windowId, t.webSocketDebuggerUrl);
  }
  for (const [windowId, wsUrl] of windows) {
    if (!size) { await cdpCall(wsUrl, "Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } }).catch(() => {}); continue; }
    await cdpCall(wsUrl, "Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
    await cdpCall(wsUrl, "Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: size.width, height: size.height } }).catch(() => {});
  }
}
// In the phone shape Chrome also says it is a phone: many sites pick their
// phone version by the device, not the width. Its pages get a phone's user
// agent and touch, mouse presses arrive as touches (so a drag scrolls), and
// the open pages reload as their phone versions. Pages keep the window's
// real width: a phone's 980-wide layout for pages made only for computers
// shrinks them to unreadable here, with no pinch to zoom out of it. The
// overrides last as long as this one connection, which the laptop shape
// closes; pages change back on their next load.
let phoneSession = null;
function phoneAgent(desktop) {
  const major = (String(desktop).match(/Chrome\/(\d+)/) || [])[1] || "140";
  return {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    userAgentMetadata: { brands: [{ brand: "Chromium", version: major }, { brand: "Not.A/Brand", version: "99" }],
      platform: "Android", platformVersion: "10.0.0", architecture: "", model: "K", mobile: true },
  };
}
async function phoneMode(on) {
  if (!on) { if (phoneSession) phoneSession.close(); phoneSession = null; return; }
  if (phoneSession) return;
  const version = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const agent = phoneAgent(version["User-Agent"]);
  const WebSocket = require("ws");
  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  phoneSession = ws;
  let id = 0;
  const send = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }));
  ws.on("open", () => send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.method !== "Target.attachedToTarget") return;
    const { sessionId, targetInfo, waitingForDebugger } = msg.params;
    if (targetInfo.type === "page") {
      send("Emulation.setUserAgentOverride", { userAgent: agent.userAgent, platform: "Linux armv8l", userAgentMetadata: agent.userAgentMetadata }, sessionId);
      send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
      send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" }, sessionId);
    }
    if (waitingForDebugger) send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    // A page already loading or loaded (one open before, or one Chrome
    // starts loading before it waits) loads again as its phone version.
    if (targetInfo.type === "page" && /^https?:/.test(targetInfo.url)) send("Page.reload", {}, sessionId);
  });
  ws.on("close", () => { if (phoneSession === ws) phoneSession = null; });
  ws.on("error", () => {});
}
// The phone's own browser bar (web chat), standing in for Chrome's in the
// phone shape: the tab in front, the tabs, and going somewhere. What is
// typed is an address when it looks like one, otherwise a Google search;
// only web addresses are opened.
function goAddress(text) {
  const typed = String(text || "").trim().slice(0, 2000);
  if (!typed) return null;
  if (/^https?:\/\/\S+$/i.test(typed)) return typed;
  if (/^[^\s/:]+\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(typed)) return "https://" + typed;
  return "https://www.google.com/search?q=" + encodeURIComponent(typed);
}
async function browserState() {
  const front = await frontTab();
  const tabs = ((await cdpTargets()) || []).filter((t) => t.type === "page" && !BROWSER_UI.test(t.url || ""))
    .map((t) => ({ id: t.id, title: t.title || t.url, url: t.url, front: !!front && t.id === front.id }));
  return { url: front ? front.url : "", title: front ? front.title : "", tabs };
}
app.post("/desktop/phone-browser", auth, async (req, res) => {
  if (DESKTOP) return res.status(409).json({ error: "This browser has no screen of its own." });
  const { action, address, id } = req.body || {};
  const tab = typeof id === "string" && /^[A-F0-9]{8,64}$/i.test(id) ? id : null;
  const devtools = `http://127.0.0.1:${CDP_PORT}`;
  try {
    const front = ["go", "back", "forward", "reload"].includes(action) ? await frontTab() : null;
    if (action === "go") {
      const url = goAddress(address);
      if (!url) return res.status(400).json({ error: "Type an address or something to search for." });
      if (front) await cdpCall(front.webSocketDebuggerUrl, "Page.navigate", { url });
      else await fetch(`${devtools}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    } else if ((action === "back" || action === "forward") && front) {
      await cdpCall(front.webSocketDebuggerUrl, "Runtime.evaluate", { expression: `history.${action}()` });
    } else if (action === "reload" && front) {
      await cdpCall(front.webSocketDebuggerUrl, "Page.reload");
    } else if (action === "switch" && tab) {
      await fetch(`${devtools}/json/activate/${tab}`);
    } else if (action === "close" && tab) {
      await fetch(`${devtools}/json/close/${tab}`);
    } else if (action === "new") {
      await fetch(`${devtools}/json/new?chrome://newtab`, { method: "PUT" });
    }
    if (action && action !== "state") await new Promise((r) => setTimeout(r, 400));
    res.json(await browserState());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// { width, height }: the phone's view in CSS pixels; anything else: laptop.
app.post("/desktop/shape", auth, async (req, res) => {
  if (DESKTOP) return res.status(409).json({ error: "This browser has no screen of its own to reshape." });
  const { width, height } = req.body || {};
  const phone = Number.isInteger(width) && Number.isInteger(height) && width >= 200 && width <= 1000 && height >= 200 && height <= 2000;
  try {
    if (phone && botBrowsing()) return res.json({ ...(await queueShape(LAPTOP)), busy: true });
    const k = phone ? Math.max(1, NARROWEST / width) : 1;
    res.json(await queueShape(phone ? { width: Math.min(SCREEN.width, Math.round(width * k)), height: Math.min(SCREEN.height, Math.round(height * k)) } : LAPTOP));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Code execution ---
app.post("/exec", (req, res) => {
  const { language, code, timeout_ms } = req.body;
  lastExecAt = Date.now(); parked = false;
  if (!language || !code) {
    return res.status(400).json({ error: "language and code are required" });
  }

  const timeout = Math.min(timeout_ms || DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const startTime = Date.now();

  let cmd, args, tmpFile;

  switch (language) {
    case "python": {
      // Checked before the script is written: a script can hold a card number
      // (the wallet's checkout fill), and returning here used to leave it in
      // a temp file.
      if (pythonState !== "ready") {
        return res.json({ stdout: "", exit_code: -1, duration_ms: 0,
          stderr: pythonState === "installing" || pythonState === "checking"
            ? "Python is still being set up on this Mac (a one-time download). Try again in a minute or two."
            : `Python is not available here: ${pythonError || pythonState}.` });
      }
      tmpFile = path.join(os.tmpdir(), `exec_${crypto.randomBytes(4).toString("hex")}.py`);
      fs.writeFileSync(tmpFile, code, { mode: 0o600 });
      // Unbuffered, so a run stopped at the time cap still shows what it had
      // printed; buffered output died with the process and every timeout read
      // as "no output".
      cmd = PYTHON;
      args = ["-u", tmpFile];
      break;
    }
    case "node": {
      tmpFile = path.join(os.tmpdir(), `exec_${crypto.randomBytes(4).toString("hex")}.js`);
      fs.writeFileSync(tmpFile, code, { mode: 0o600 });
      cmd = "node";
      args = [tmpFile];
      break;
    }
    case "bash": {
      tmpFile = path.join(os.tmpdir(), `exec_${crypto.randomBytes(4).toString("hex")}.sh`);
      fs.writeFileSync(tmpFile, code, { mode: 0o600 });
      cmd = "bash";
      args = [tmpFile];
      break;
    }
    default:
      return res.status(400).json({ error: `Unsupported language: ${language}` });
  }

  if (SANDBOX_PROFILE) { args = ["-f", SANDBOX_PROFILE, cmd, ...args]; cmd = "/usr/bin/sandbox-exec"; }
  const child = spawn(cmd, args, {
    cwd: WORKSPACE,
    timeout,
    env: execEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  child.on("close", (exit_code) => {
    const duration_ms = Date.now() - startTime;
    // Clean up tmp file
    try { fs.unlinkSync(tmpFile); } catch {}

    res.json({
      stdout: truncate(stdout, MAX_OUTPUT),
      stderr: truncate(stderr, MAX_OUTPUT),
      exit_code: exit_code ?? -1,
      duration_ms,
    });
  });

  child.on("error", (err) => {
    const duration_ms = Date.now() - startTime;
    try { fs.unlinkSync(tmpFile); } catch {}
    res.json({
      stdout: "",
      stderr: err.message,
      exit_code: -1,
      duration_ms,
    });
  });
});

// --- Closedhand's browsing ---
// One Python process holds one connection to Chrome for as long as it is used
// (browser_helper.py serve). Starting Python and attaching Playwright cost
// seconds, and every step used to pay both, so a ten-step job spent most of
// its time connecting. Steps queue and run one at a time on Closedhand's tab;
// a step that hangs past its time takes the process with it, and the next
// step starts a fresh one.
let browseChild = null, browseBuf = "", browseSeq = 0, browseQueue = Promise.resolve();
let browseBusy = 0, lastBrowseAt = 0;
const browseWaiting = new Map(); // id -> { resolve, reject, timer }
function browseProcess() {
  if (browseChild && browseChild.exitCode === null && !browseChild.killed) return browseChild;
  let cmd = PYTHON, args = ["-u", "-m", "browser_helper", "serve"];
  if (SANDBOX_PROFILE) { args = ["-f", SANDBOX_PROFILE, cmd, ...args]; cmd = "/usr/bin/sandbox-exec"; }
  const child = spawn(cmd, args, { cwd: WORKSPACE, env: execEnv(), stdio: ["pipe", "pipe", "pipe"] });
  browseBuf = "";
  child.stdout.on("data", (d) => {
    browseBuf += d.toString();
    let nl;
    while ((nl = browseBuf.indexOf("\n")) >= 0) {
      const line = browseBuf.slice(0, nl); browseBuf = browseBuf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const waiting = browseWaiting.get(msg.id);
      if (!waiting) continue;
      browseWaiting.delete(msg.id); clearTimeout(waiting.timer); waiting.resolve(msg.result);
    }
  });
  child.stderr.on("data", (d) => { const t = d.toString().trim(); if (t) console.error("[browse]", truncate(t, 400)); });
  const fail = (why) => { for (const [id, w] of browseWaiting) { clearTimeout(w.timer); w.reject(new Error(why)); browseWaiting.delete(id); } };
  child.on("exit", () => { if (browseChild === child) browseChild = null; fail("The browser helper stopped. Try the step again."); });
  child.on("error", (e) => { if (browseChild === child) browseChild = null; fail(e.message); });
  browseChild = child;
  return child;
}
function browseRequest(body, timeout) {
  const run = () => new Promise((resolve, reject) => {
    const id = ++browseSeq;
    const timer = setTimeout(() => {
      browseWaiting.delete(id);
      try { browseChild && browseChild.kill("SIGKILL"); } catch {}
      reject(new Error(`The browser step was still running after ${Math.round(timeout / 1000)} seconds and was stopped.`));
    }, timeout);
    browseWaiting.set(id, { resolve, reject, timer });
    browseProcess().stdin.write(JSON.stringify({ id, ...body }) + "\n");
  });
  const next = browseQueue.then(run, run);
  browseQueue = next.catch(() => {});
  return next;
}
// Started when a step first wants it and stopped after ten quiet minutes, so
// it only takes memory while it is being used.
let headlessChild = null, headlessStarting = null, lastHeadlessAt = 0;
function chromeBinary() {
  if (BROWSER_CMD) return BROWSER_CMD;
  return ["/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((c) => fs.existsSync(c)) || null;
}
async function ensureHeadless() {
  lastHeadlessAt = Date.now();
  if (await httpJson(`http://127.0.0.1:${HEADLESS_PORT}/json/version`, 1500).catch(() => null)) return;
  if (headlessStarting) return headlessStarting;
  headlessStarting = (async () => {
    const bin = chromeBinary();
    if (!bin) throw new Error("No Chrome or Chromium to run the hidden browser with.");
    // Sites are told the same browser as the visible one, not "HeadlessChrome",
    // which many of them turn away on sight.
    const visible = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 1500).catch(() => null);
    const agent = visible && visible["User-Agent"] ? visible["User-Agent"].replace(/HeadlessChrome/g, "Chrome") : null;
    fs.rmSync(HEADLESS_PROFILE, { recursive: true, force: true });
    const args = ["--headless=new", `--remote-debugging-port=${HEADLESS_PORT}`, `--user-data-dir=${HEADLESS_PROFILE}`,
      "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", ...(agent ? [`--user-agent=${agent}`] : []),
      ...(DESKTOP ? [] : ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]), "about:blank"];
    const child = spawn(bin, args, { stdio: "ignore", detached: false });
    child.on("exit", () => { if (headlessChild === child) headlessChild = null; });
    headlessChild = child;
    for (let i = 0; i < 40; i++) {
      if (await httpJson(`http://127.0.0.1:${HEADLESS_PORT}/json/version`, 1000).catch(() => null)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("The hidden browser did not start.");
  })().finally(() => { headlessStarting = null; });
  return headlessStarting;
}
function stopHeadless() {
  if (headlessChild) { try { headlessChild.kill(); } catch {} headlessChild = null; }
}
setInterval(() => { if (headlessChild && !browseBusy && Date.now() - lastHeadlessAt > HEADLESS_IDLE_MS) { stopHeadless(); console.log("[browser] stopped the hidden browser after ten quiet minutes"); } }, 60 * 1000).unref();

app.post("/browse", async (req, res) => {
  lastExecAt = Date.now(); parked = false;
  if (pythonState !== "ready") {
    return res.json({ error: pythonState === "installing" || pythonState === "checking"
      ? "Python is still being set up on this Mac (a one-time download). Try again in a minute or two."
      : `Python is not available here: ${pythonError || pythonState}.` });
  }
  const { op, step, steps, url, urls, engine, timeout_ms } = req.body || {};
  if (!["batch", "step", "read_pages"].includes(op)) return res.status(400).json({ error: "op must be step, batch or read_pages" });
  if (engine !== undefined && engine !== "visible" && engine !== "headless") return res.status(400).json({ error: "engine must be visible or headless" });
  const timeout = Math.min(timeout_ms || 60000, MAX_TIMEOUT);
  browseBusy++;
  try {
    if (engine === "headless") await ensureHeadless();
    const body = op === "batch" ? { op, steps, url, engine } : op === "read_pages" ? { op, urls, engine } : { op, step, engine };
    const result = await browseRequest(body, timeout);
    res.json({ result });
  } catch (e) {
    res.json({ error: e.message });
  } finally {
    browseBusy--; lastBrowseAt = Date.now();
  }
});

// --- File operations ---

app.post("/files/read", (req, res) => {
  try {
    const filePath = safePath(req.body.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const stat = fs.statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) {
      // For large files, return base64
      const content = fs.readFileSync(filePath).toString("base64");
      return res.json({ content, size: stat.size, encoding: "base64" });
    }
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ content: truncate(content, MAX_OUTPUT * 2), size: stat.size, encoding: "utf-8" });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/files/write", (req, res) => {
  try {
    const filePath = safePath(req.body.path);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (req.body.encoding === "base64") {
      fs.writeFileSync(filePath, Buffer.from(req.body.content, "base64"));
    } else {
      fs.writeFileSync(filePath, req.body.content, "utf-8");
    }
    const stat = fs.statSync(filePath);
    res.json({ success: true, path: req.body.path, size: stat.size });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/files/list", (req, res) => {
  try {
    const dirPath = safePath(req.body.path || ".");
    if (!fs.existsSync(dirPath)) {
      return res.status(404).json({ error: "Directory not found" });
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = entries.map((e) => {
      const fullPath = path.join(dirPath, e.name);
      try {
        const stat = fs.statSync(fullPath);
        return {
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
          size: stat.size,
          modified: stat.mtime.toISOString(),
        };
      } catch {
        return { name: e.name, type: e.isDirectory() ? "directory" : "file", size: 0 };
      }
    });
    res.json({ files, path: req.body.path || "." });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/files/delete", (req, res) => {
  try {
    const filePath = safePath(req.body.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true });
    } else {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true, deleted: req.body.path });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/files/download", (req, res) => {
  try {
    const filePath = safePath(req.body.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const stat = fs.statSync(filePath);
    if (stat.size > 20 * 1024 * 1024) {
      return res.status(400).json({ error: "File too large (max 20MB)" });
    }
    const content = fs.readFileSync(filePath).toString("base64");
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
      ".py": "text/x-python", ".js": "text/javascript", ".html": "text/html",
      ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
      ".zip": "application/zip", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    res.json({
      content,
      filename: path.basename(filePath),
      size: stat.size,
      mime_type: mimeMap[ext] || "application/octet-stream",
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Package management ---

app.post("/packages/install", (req, res) => {
  const { manager, packages } = req.body;
  if (!manager || !packages || !packages.length) {
    return res.status(400).json({ error: "manager and packages are required" });
  }

  // Sanitize package names (basic check)
  for (const pkg of packages) {
    if (/[;&|`$(){}]/.test(pkg)) {
      return res.status(400).json({ error: `Invalid package name: ${pkg}` });
    }
  }

  let cmd, args;
  if (manager === "pip" && DESKTOP) {
    cmd = UV;
    args = ["pip", "install", "--python", PYTHON, ...packages];
  } else if (manager === "pip") {
    cmd = "pip";
    args = ["install", "--user", ...packages];
  } else if (manager === "npm") {
    cmd = "npm";
    args = ["install", "--prefix", WORKSPACE, ...packages];
  } else {
    return res.status(400).json({ error: `Unsupported manager: ${manager}` });
  }

  execFile(cmd, args, { timeout: 120000, cwd: WORKSPACE }, (err, stdout, stderr) => {
    if (err) {
      return res.json({
        installed: [],
        errors: [truncate(stderr || err.message, 2000)],
      });
    }
    res.json({
      installed: packages,
      stdout: truncate(stdout, 2000),
      errors: stderr ? [truncate(stderr, 1000)] : [],
    });
  });
});

app.post("/packages/list", (req, res) => {
  const { manager } = req.body;
  if (manager === "pip") {
    const listCmd = DESKTOP ? UV : "pip";
    const listArgs = DESKTOP ? ["pip", "list", "--python", PYTHON, "--format=json"] : ["list", "--format=json"];
    execFile(listCmd, listArgs, { timeout: 10000 }, (err, stdout) => {
      if (err) return res.json({ packages: [], error: err.message });
      try {
        const pkgs = JSON.parse(stdout);
        res.json({ packages: pkgs });
      } catch {
        res.json({ packages: [], raw: stdout });
      }
    });
  } else if (manager === "npm") {
    execFile("npm", ["list", "--prefix", WORKSPACE, "--json", "--depth=0"], { timeout: 10000 }, (err, stdout) => {
      if (err && !stdout) return res.json({ packages: [], error: err.message });
      try {
        const data = JSON.parse(stdout);
        const pkgs = Object.entries(data.dependencies || {}).map(([name, info]) => ({
          name,
          version: info.version,
        }));
        res.json({ packages: pkgs });
      } catch {
        res.json({ packages: [], raw: stdout });
      }
    });
  } else {
    res.status(400).json({ error: `Unsupported manager: ${manager}` });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Sandbox agent listening on port ${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Auth: ${SANDBOX_TOKEN ? "enabled" : process.env.SANDBOX_DEV === "1" ? "disabled (SANDBOX_DEV=1)" : "no token, so every request is refused"}`);
});
