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
const WORKSPACE = "/workspace";
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
app.get("/desktop/status", auth, (_req, res) => {
  try {
    const xvfb = require("child_process").execSync("pgrep -c Xvfb", { timeout: 2000 }).toString().trim();
    const vnc = require("child_process").execSync("pgrep -c x11vnc", { timeout: 2000 }).toString().trim();
    const ws = require("child_process").execSync("pgrep -cf websockify", { timeout: 2000 }).toString().trim();
    res.json({ status: "running", display: ":99", vnc_ws_port: 6080, resolution: "1920x1080", desktop: "browser", procs: { xvfb, vnc, ws } });
  } catch (e) {
    res.json({ status: "degraded", error: e.message });
  }
});

app.post("/desktop/screenshot", auth, (_req, res) => {
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

app.post("/desktop/browser", auth, (req, res) => {
  const { url } = req.body || {};
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
      cmd = "python3";
      args = [tmpFile];
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
    env: { ...process.env, HOME: "/home/sandbox" },
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
  if (manager === "pip") {
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
    execFile("pip", ["list", "--format=json"], { timeout: 10000 }, (err, stdout) => {
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
