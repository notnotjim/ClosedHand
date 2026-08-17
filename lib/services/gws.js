// lib/services/gws.js -- Google Workspace CLI wrapper
// Uses the user's existing OAuth token from getGoogleToken().
// Falls back gracefully if gws binary is not available.

const path = require("path");
const { execSync } = require("child_process");
const { getGoogleToken } = require("./google");

// Find gws binary: check node_modules/.bin first, then global
const localBin = path.resolve(__dirname, "../../node_modules/.bin/gws");
let gwsBin = null;
let gwsAvailable = false;

try {
  execSync(`"${localBin}" --version`, { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
  gwsBin = localBin;
  gwsAvailable = true;
  console.log("[gws] Google Workspace CLI available (local)");
} catch {
  try {
    execSync("gws --version", { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
    gwsBin = "gws";
    gwsAvailable = true;
    console.log("[gws] Google Workspace CLI available (global)");
  } catch {
    console.log("[gws] Not available, using raw HTTP fallback");
  }
}

function isGwsAvailable() {
  return gwsAvailable;
}

// Run a gws command with the user's OAuth token injected via env var.
// Returns parsed JSON. Throws on failure.
async function gwsCommand(args, timeoutMs = 15000) {
  if (!gwsBin) throw new Error("gws not available");
  const token = await getGoogleToken();
  if (!token) throw new Error("Google not connected");

  const result = execSync(`"${gwsBin}" ${args}`, {
    env: { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token },
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });

  return JSON.parse(result);
}

module.exports = { isGwsAvailable, gwsCommand };
