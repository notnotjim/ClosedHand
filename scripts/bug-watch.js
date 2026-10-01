#!/usr/bin/env node
// scripts/bug-watch.js — block until a new bug report arrives, then exit.
//
// Run this in the background from a session. Claude Code re-invokes the model
// when a background process exits, so this turns "a user flagged something"
// into an interrupt instead of something noticed at the next session start.
//
// It costs no tokens while waiting: one small indexed query every 30s, no LLM
// anywhere in the loop. Tokens are spent only once there is something real to
// look at.
//
//   node scripts/bug-watch.js            watch from now
//   node scripts/bug-watch.js --since <iso>
//
// Runs until a report arrives or the session ends. Exits 0 either way, so a
// session never sees this as a failure. Re-arm it after handling a report.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const POLL_MS = Number(process.env.BUG_WATCH_POLL_MS) || 30_000;
const sinceArg = process.argv.indexOf("--since");

async function poll(since) {
  const { data, error } = await supabase
    .from("bug_reports")
    .select("id, user_id, platform, comment, screenshots, created_at")
    .eq("status", "open")
    .gt("created_at", since)
    .order("created_at", { ascending: true })
    .limit(10);

  // Blips and a missing table are both "keep waiting", not "give up": this
  // process is the only thing standing between a report and being noticed.
  if (error) return null;
  return data && data.length > 0 ? data : null;
}

(async () => {
  // Baseline so pre-existing open reports do not fire immediately: those are
  // already listed at session start.
  let since = sinceArg > -1 ? process.argv[sinceArg + 1] : null;
  if (!since) {
    const { data } = await supabase
      .from("bug_reports")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    since = data?.[0]?.created_at || new Date().toISOString();
  }

  // Watches for as long as the session lives. There is no expiry: the process
  // dies with the session anyway, so a cutoff would only create a stretch where
  // a long session had quietly stopped watching.
  for (;;) {
    await new Promise(r => setTimeout(r, POLL_MS));

    const found = await poll(since);
    if (!found) continue;

    console.log(`NEW BUG REPORT${found.length > 1 ? "S" : ""} (${found.length}), flagged just now:`);
    for (const r of found) {
      const shots = (r.screenshots || []).length;
      console.log(`  ${r.id.substring(0, 8)}  ${r.platform || "unknown"}  ${r.comment || "(no comment)"}${shots ? `  [${shots} screenshot${shots > 1 ? "s" : ""}]` : ""}`);
    }
    console.log(`\nTriage in the background so foreground work is not disturbed, then re-arm:`);
    console.log(`  node scripts/bug-watch.js --since ${found[found.length - 1].created_at}`);
    process.exit(0);
  }

})().catch(e => {
  console.log(`bug-watch stopped: ${e.message}. Re-arm to keep watching.`);
  process.exit(0);
});
