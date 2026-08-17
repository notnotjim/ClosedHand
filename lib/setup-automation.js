// lib/setup-automation.js — after the Google sign-in, ClosedHand fetches its
// own credentials instead of making the user hunt for them.
//
// The user signs into Google once in ClosedHand's browser. From that session
// this collects, on their behalf:
//   1. which account is signed in,
//   2. the calendar's secret iCal URL (calendar reading, zero effort),
//   3. an app password named ClosedHand (full mailbox: read, send, drafts).
//
// Every step is best-effort and independently reported. Google challenges
// sensitive pages, and app passwords only exist for accounts with 2-Step
// Verification, so the honest outcome is sometimes "here is the one thing
// left for you to do" rather than silence or a lie. The setup page renders
// whatever comes back.
//
// The webapp cannot reach the sandbox (and must not import bot code), so it
// requests a run by writing profiles.settings.google_browser_job and reads
// progress from the same place. Same DB-as-the-wire pattern as WhatsApp
// pairing.

const { supabase } = require("../user-store");

const POLL_MS = 8000;
// How long to keep watching for a sign-in before going quiet. Long enough
// for a password manager, a 2FA prompt and a wrong guess; short enough that
// an abandoned tab stops costing anything.
const WATCH_WINDOW_MS = 6 * 60 * 1000;
const EXEC_TIMEOUT_MS = 90000;

let _timer = null;
let _running = false;

async function readJob(userId) {
  const { data } = await supabase.from("profiles").select("settings").eq("id", userId).single();
  return { settings: data?.settings || {}, job: data?.settings?.google_browser_job || null };
}

async function writeJob(userId, patch) {
  const { settings } = await readJob(userId);
  const job = { ...(settings.google_browser_job || {}), ...patch, at: new Date().toISOString() };
  settings.google_browser_job = job;
  await supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", userId);
  return job;
}

// Run one python snippet in the sandbox and give back parsed JSON. The helper
// prints a single JSON line; anything else (a stack trace, an import error)
// comes back as an error rather than being parsed into nonsense.
async function browserEval(userId, script, url) {
  const { sandboxExec } = require("./sandbox");
  const py = `
import json
from browser_helper import eval_js
try:
    res = eval_js(${JSON.stringify(script)}, ${url ? JSON.stringify(url) : "None"})
    print(json.dumps({"ok": True, "result": res}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]}))
`;
  const out = await sandboxExec(userId, "python", py, EXEC_TIMEOUT_MS);
  const text = String(out?.stdout || out?.output || out?.result || "");
  const line = text.trim().split("\n").filter(Boolean).pop() || "";
  try {
    const parsed = JSON.parse(line);
    if (!parsed.ok) return { error: parsed.error || "browser step failed" };
    // eval_js itself wraps its return; unwrap the common shapes.
    const r = parsed.result;
    return { value: r && typeof r === "object" && "result" in r ? r.result : r };
  } catch (_) {
    return { error: (text || "no output from the browser").substring(0, 200) };
  }
}

// Is that browser signed into Google? Read the profile's cookies over the CDP
// connection rather than navigating: the user may be mid-form, and moving
// their page out from under them to answer a question is unforgivable.
// Google's session cookies are the signal; no page needs to be open at all.
async function googleSessionPresent(userId) {
  const { sandboxExec } = require("./sandbox");
  const py = `
import json
from browser_helper import _get_browser
try:
    pw, browser, context = _get_browser()
    try:
        names = {c["name"] for c in context.cookies() if "google" in (c.get("domain") or "")}
        signed = bool({"SID", "SAPISID", "__Secure-1PSID"} & names)
        print(json.dumps({"ok": True, "signed_in": signed}))
    finally:
        browser.close(); pw.stop()
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:200]}))
`;
  try {
    const out = await sandboxExec(userId, "python", py, 45000);
    const text = String(out?.stdout || "");
    const line = text.trim().split("\n").filter(Boolean).pop() || "";
    const parsed = JSON.parse(line);
    return !!parsed.signed_in;
  } catch (_) {
    return false;
  }
}

// --- Step 1: who is signed in ---
async function detectAccount(userId) {
  const script = `(() => {
    const t = document.body ? document.body.innerText : "";
    const m = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
    return { email: m ? m[0] : null, url: location.href, title: document.title };
  })()`;
  const r = await browserEval(userId, script, "https://myaccount.google.com/");
  if (r.error) return { error: r.error };
  const v = r.value || {};
  if (/accounts\.google\.com|\/signin/.test(v.url || "")) return { signedOut: true };
  return { email: v.email || null };
}

async function openGoogleSignin(userId) {
  await writeJob(userId, { status: "opening", message: "Opening Google's sign-in page on ClosedHand's computer…" });
  const script = `(() => ({ url: location.href, signedIn: !/accounts\\.google\\.com/.test(location.href) }))()`;
  const r = await browserEval(userId, script, "https://accounts.google.com/");
  if (r.error) {
    return writeJob(userId, { status: "error", message: `Could not reach ClosedHand's browser: ${r.error}` });
  }
  // Google sends an already-signed-in visitor to myaccount instead of a login
  // form, which is the difference between "sign in" and "you already did".
  const alreadyIn = !!(r.value && r.value.signedIn);
  if (alreadyIn) {
    // Nothing to wait for: get straight on with it.
    return runGoogleAutoSetup(userId);
  }
  // Watch for the sign-in instead of asking the user to come back and tell us.
  // Bounded, because polling a browser nobody is using is pure waste.
  return writeJob(userId, {
    status: "awaiting_signin",
    watch_until: new Date(Date.now() + WATCH_WINDOW_MS).toISOString(),
    message: "Google's sign-in page is open below. Sign in there and ClosedHand carries on by itself.",
  });
}

async function runGoogleAutoSetup(userId) {
  await writeJob(userId, { status: "running", message: "Checking which account is signed in…", results: {} });

  const acct = await detectAccount(userId);
  if (acct.signedOut) {
    return writeJob(userId, { status: "error", message: "That browser is not signed into Google yet." });
  }
  if (acct.error) {
    return writeJob(userId, { status: "error", message: `Could not reach ClosedHand's browser: ${acct.error}` });
  }
  // Deliberately no credential harvesting here. Both routes were tried
  // against a real account on 2026-08-16 and neither can be made reliable:
  // Calendar renders its secret iCal address as bullets with a copy-only
  // button and keeps the value off the page entirely, and repeated automated
  // visits to the app-password page make Google demand re-authentication.
  // Mail and calendar come from one app password the user creates in thirty
  // seconds; this session is what lets ClosedHand act in a browser as them.
  return writeJob(userId, {
    status: "done",
    message: "Signed in. ClosedHand can now act in a browser as you on this account.",
    results: { email: acct.email || null },
  });
}

// Watch for requested runs. One user, one job at a time; a crash mid-run
// leaves status "running", which the page reports rather than hanging.
function setup() {
  if (_timer) return;
  const tick = async () => {
    if (_running) return;
    try {
      const { data } = await supabase.from("profiles").select("id, settings").not("settings", "is", null).limit(50);
      for (const p of data || []) {
        const pending = p.settings?.google_browser_job;

        // Waiting for the user to finish signing in: check, then either carry
        // on automatically or stop watching once the window has passed.
        if (pending?.status === "awaiting_signin") {
          const expired = !pending.watch_until || Date.now() > new Date(pending.watch_until).getTime();
          _running = true;
          try {
            if (await googleSessionPresent(p.id)) {
              console.log(`[setup-auto] sign-in detected for ${String(p.id).substring(0, 8)}, continuing`);
              await runGoogleAutoSetup(p.id);
            } else if (expired) {
              await writeJob(p.id, {
                status: "ready",
                message: "Still not signed in, so ClosedHand stopped watching. Sign in on the screen below and press the button.",
              });
            }
          } catch (e) {
            console.error(`[setup-auto] watch failed: ${e.message}`);
          } finally {
            _running = false;
          }
          break;
        }

        if (pending?.status === "requested") {
          _running = true;
          try {
            if (pending.action === "open_signin") {
              console.log(`[setup-auto] opening Google sign-in for ${String(p.id).substring(0, 8)}`);
              await openGoogleSignin(p.id);
            } else {
              console.log(`[setup-auto] running Google browser setup for ${String(p.id).substring(0, 8)}`);
              await runGoogleAutoSetup(p.id);
            }
          } catch (e) {
            console.error(`[setup-auto] failed: ${e.message}`);
            await writeJob(p.id, { status: "error", message: `Something went wrong: ${String(e.message).substring(0, 140)}` }).catch(() => {});
          } finally {
            _running = false;
          }
          break;
        }
      }
    } catch (_) { /* next tick retries */ }
  };
  _timer = setInterval(tick, POLL_MS);
  tick();
}

module.exports = { setup, runGoogleAutoSetup };
