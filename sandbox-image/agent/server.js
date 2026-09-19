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
// Chrome of the user's own launched with ClosedHand's profile.
const DESKTOP = process.env.SANDBOX_MODE === "desktop";
const WORKSPACE = process.env.WORKSPACE || "/workspace";
const EXEC_HOME = process.env.EXEC_HOME || "/home/sandbox";
const PYTHON = process.env.PYTHON || "python3";
const UV = process.env.UV || "";
const CDP_PORT = process.env.CDP_PORT || "9222";
const BROWSER_CMD = process.env.BROWSER_CMD || "";
const BROWSER_PROFILE = path.join(WORKSPACE, ".chromium-profile");
// What the container image pre-installs, so code written for one runs on the other.
const PY_PACKAGES = ["pandas", "numpy", "requests", "matplotlib", "beautifulsoup4", "pillow", "openpyxl", "playwright", "lxml", "scipy", "scikit-learn", "seaborn", "tabulate", "python-dateutil", "pytz", "httpx", "pydantic", "chardet", "plotly"];
const MAX_TIMEOUT = 120000; // 120s absolute max
const DEFAULT_TIMEOUT = 30000; // 30s default
const MAX_OUTPUT = 8000; // chars

// --- Auth middleware ---
function auth(req, res, next) {
  if (!SANDBOX_TOKEN) return next(); // dev mode
  const token = req.headers["x-sandbox-token"];
  if (!token || token !== SANDBOX_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
app.use("/exec", auth);
app.use("/files", auth);
app.use("/packages", auth);

// --- Path safety ---
function safePath(userPath) {
  const resolved = path.resolve(WORKSPACE, userPath || ".");
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error("Path traversal blocked");
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
  if (fs.existsSync(PYTHON)) { pythonState = "ready"; return; }
  if (!UV) { pythonState = "missing"; pythonError = "No uv bundled"; return; }
  pythonState = "installing";
  const venv = path.dirname(path.dirname(PYTHON));
  const uv = (args) => new Promise((resolve) => execFile(UV, args, { cwd: WORKSPACE, timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
  (async () => {
    console.log("[python] setting up a Python for the workspace with uv");
    let r = await uv(["venv", "--python", "3.12", "--allow-existing", venv]);
    if (!r.err) r = await uv(["pip", "install", "--python", PYTHON, ...PY_PACKAGES]);
    if (r.err) { pythonState = "error"; pythonError = truncate(r.stderr || r.err.message, 600); console.error("[python] setup failed:", pythonError); }
    else { pythonState = "ready"; console.log("[python] ready"); }
  })();
}
ensurePython();

// The environment code runs in. On the desktop the helper modules sit beside
// this file and the browser is wherever the app put it.
function execEnv() {
  const env = { ...process.env, HOME: EXEC_HOME, CDP_URL: `http://127.0.0.1:${CDP_PORT}` };
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
// The browser was started by this agent; it goes when the agent goes.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { if (browserPid) { try { process.kill(browserPid); } catch {} } process.exit(0); });

// --- Health ---
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    workspace: WORKSPACE,
    user: os.userInfo().username,
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
    res.json({ status: "running", display: ":99", vnc_ws_port: 6080, resolution: "1920x1080", desktop: "browser", procs: { xvfb, vnc, ws } });
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
  spawn("bash", ["-c",
    `DISPLAY=:99 /usr/local/bin/chromium-launcher --start-maximized "${url || "about:blank"}" &`
  ], { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: ":99" } }).unref();
  res.json({ status: "launched", url: url || "about:blank" });
});

// --- Code execution ---
app.post("/exec", (req, res) => {
  const { language, code, timeout_ms } = req.body;
  if (!language || !code) {
    return res.status(400).json({ error: "language and code are required" });
  }

  const timeout = Math.min(timeout_ms || DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const startTime = Date.now();

  let cmd, args, tmpFile;

  switch (language) {
    case "python": {
      tmpFile = path.join(os.tmpdir(), `exec_${crypto.randomBytes(4).toString("hex")}.py`);
      fs.writeFileSync(tmpFile, code);
      // Unbuffered, so a run stopped at the time cap still shows what it had
      // printed; buffered output died with the process and every timeout read
      // as "no output".
      if (pythonState !== "ready") {
        return res.json({ stdout: "", exit_code: -1, duration_ms: 0,
          stderr: pythonState === "installing" || pythonState === "checking"
            ? "Python is still being set up on this Mac (a one-time download). Try again in a minute or two."
            : `Python is not available here: ${pythonError || pythonState}.` });
      }
      cmd = PYTHON;
      args = ["-u", tmpFile];
      break;
    }
    case "node": {
      tmpFile = path.join(os.tmpdir(), `exec_${crypto.randomBytes(4).toString("hex")}.js`);
      fs.writeFileSync(tmpFile, code);
      cmd = "node";
      args = [tmpFile];
      break;
    }
    case "bash": {
      tmpFile = path.join(os.tmpdir(), `exec_${crypto.randomBytes(4).toString("hex")}.sh`);
      fs.writeFileSync(tmpFile, code);
      cmd = "bash";
      args = [tmpFile];
      break;
    }
    default:
      return res.status(400).json({ error: `Unsupported language: ${language}` });
  }

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
  console.log(`Auth: ${SANDBOX_TOKEN ? "enabled" : "disabled (dev mode)"}`);
});
