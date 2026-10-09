// lib/services/gws.js -- Google Workspace CLI wrapper
// Uses the user's existing OAuth token from getGoogleToken().
// Falls back gracefully if gws binary is not available.

const path = require("path");
const { execFileSync } = require("child_process");
const { getGoogleToken } = require("./google");

// Find gws binary: check node_modules/.bin first, then global
const localBin = path.resolve(__dirname, "../../node_modules/.bin/gws");
let gwsBin = null;
let gwsAvailable = false;

try {
  execFileSync(localBin, ["--version"], { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
  gwsBin = localBin;
  gwsAvailable = true;
  console.log("[gws] Google Workspace CLI available (local)");
} catch {
  try {
    execFileSync("gws", ["--version"], { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
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
// Returns parsed JSON. Throws on failure. The arguments are a list and no
// shell runs them: a search can hold quotes written by the model or taken
// from mail, and a shell would treat them as commands.
async function gwsCommand(args, timeoutMs = 15000) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new Error("gws arguments must be a list of strings");
  if (!gwsBin) throw new Error("gws not available");
  const token = await getGoogleToken();
  if (!token) throw new Error("Google not connected");

  let result;
  try {
    result = execFileSync(gwsBin, args, {
      env: { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token },
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    // Node's message repeats every argument, the search included, and
    // callers log it. Say how it ended, never what was asked.
    throw new Error(`gws ${args.slice(0, 3).join(" ")} failed (${e.signal || `exit ${e.status ?? "?"}`})`);
  }

  return JSON.parse(result);
}

module.exports = { isGwsAvailable, gwsCommand };
