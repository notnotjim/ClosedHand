// Whether a newer Closedhand is out, and how to get it on this computer.
//
// Once a day it asks GitHub which commit the newest release was built from,
// and whether that is ahead of the one running here: public facts, asked with
// nothing about the person. Docker gets new images with every change that
// passes its checks; the Mac app gets a new release now and then. A Closedhand
// on a host (SETUP_CODE) takes new images by itself overnight, and a build
// from source (no CLOSEDHAND_SHA) has nothing to compare, so neither asks.
const REPO = "notnotjim/Closedhand";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const INSTALL_LINE = "curl -fsSL https://closedhand.com/install | sh";

let cached = null; // { until, status }

function kind(env = process.env) {
  if (env.SETUP_CODE || !env.CLOSEDHAND_SHA) return null;
  return env.CLOSEDHAND_DESKTOP ? "mac" : "docker";
}

async function getJson(path, fetchImpl) {
  const r = await fetchImpl("https://api.github.com" + path, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Closedhand" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return r.json();
}

// { newer: true|false, kind: "docker"|"mac"|null }. Never throws: a failed
// check says nothing new and tries again in an hour.
async function status({ env = process.env, now = Date.now(), fetchImpl = fetch } = {}) {
  const k = kind(env);
  if (!k) return { newer: false, kind: null };
  if (cached && cached.until > now) return cached.status;
  let result, until = now + DAY_MS;
  try {
    const latest = k === "mac"
      ? (await getJson(`/repos/${REPO}/releases/latest`, fetchImpl)).tag_name
      : (await getJson(`/repos/${REPO}/actions/workflows/build-selfhost-images.yml/runs?branch=main&status=success&per_page=1`, fetchImpl)).workflow_runs?.[0]?.head_sha;
    if (!latest) throw new Error("no release found");
    const compared = await getJson(`/repos/${REPO}/compare/${encodeURIComponent(env.CLOSEDHAND_SHA)}...${encodeURIComponent(latest)}`, fetchImpl);
    result = { newer: compared.status === "ahead", kind: k };
  } catch (e) {
    console.log(`[update] couldn't check for a newer Closedhand: ${e.message}`);
    result = { newer: false, kind: k };
    until = now + RETRY_MS;
  }
  cached = { until, status: result };
  return result;
}

// The one step that updates Closedhand where it runs.
function howToUpdate(k) {
  if (k === "mac") return "To update, download the new Closedhand from closedhand.com and drag it into Applications to replace this one.";
  if (k === "docker") return `To update, open Terminal on the computer running Closedhand and run: ${INSTALL_LINE}`;
  return "";
}

function _reset() { cached = null; }

module.exports = { status, howToUpdate, kind, INSTALL_LINE, _reset };
