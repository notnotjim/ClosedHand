#!/usr/bin/env node
// scripts/bug-queue.js — the triage side of /bug.
//
//   node scripts/bug-queue.js list                     open reports, grouped
//   node scripts/bug-queue.js show <id>                full snapshot + screenshots
//   node scripts/bug-queue.js resolve <id> --note "…"  close one out
//
// `list` is what the SessionStart hook runs, so it stays quiet when there is
// nothing open and never takes long enough to be felt.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// No credentials means there is no queue to read: this branch's .env is the
// self-host Postgres stack, which has no bug_reports table. `list` already
// treats an unreachable queue as silence, but createClient throws on an empty
// URL at require time, before any of that logic is reachable, so an
// unconfigured checkout opened every session with a stack trace about its own
// bug tracker. Same rule as an empty queue: say nothing and exit clean.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) process.exit(0);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SHOT_DIR = path.join(os.tmpdir(), "closedhand-bug-screenshots");

function ago(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Railway keeps 7 days of logs on this plan, so a report older than that has a
// transcript and a screenshot but no logs. Worth knowing before digging.
function logsGone(iso) {
  return Date.now() - new Date(iso).getTime() > 7 * 24 * 3600 * 1000;
}

async function list() {
  // Hard bound: this runs on every session start, so a slow or unreachable
  // Supabase costs a moment of silence rather than a stalled session.
  const query = supabase
    .from("bug_reports")
    .select("id, user_id, platform, comment, screenshots, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(25);

  // Generous: a normal round trip to Supabase is already ~2s from outside its
  // region, and silently showing an empty queue is far worse than waiting.
  const { data, error } = await Promise.race([
    query,
    new Promise(resolve => setTimeout(() => resolve({ data: null, error: { message: "timeout" } }), 8000)),
  ]);

  if (error) {
    // Before the migration is applied, and on a blip, say nothing: a session
    // must not open with a scary error about its own bug tracker.
    if (/does not exist|schema cache|timeout/i.test(error.message)) return;
    console.error(`bug-queue: ${error.message}`);
    return;
  }
  if (!data || data.length === 0) return; // silence is the empty state

  console.log(`OPEN BUG REPORTS (${data.length}):`);
  const byUser = {};
  for (const r of data) {
    const key = `${r.user_id.substring(0, 8)} on ${r.platform || "unknown"}`;
    (byUser[key] = byUser[key] || []).push(r);
  }
  for (const [who, rows] of Object.entries(byUser)) {
    console.log(`\n  ${who}`);
    for (const r of rows) {
      const shots = (r.screenshots || []).length;
      const flags = [
        shots ? `${shots} screenshot${shots > 1 ? "s" : ""}` : null,
        logsGone(r.created_at) ? "logs expired" : null,
      ].filter(Boolean);
      console.log(`    ${r.id.substring(0, 8)}  ${ago(r.created_at)}  ${r.comment || "(no comment)"}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
    }
  }
  console.log(`\n  Triage with: node scripts/bug-queue.js show <id>`);
}

// Short ids are a prefix of a uuid, and Postgres will not pattern-match a uuid
// column, so the prefix is matched here rather than in the query.
async function resolveId(short) {
  if (/^[0-9a-f-]{36}$/i.test(short)) return short;

  const { data, error } = await supabase
    .from("bug_reports")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.error(`bug-queue: ${error.message}`);
    return null;
  }

  const matches = (data || []).filter(r => r.id.startsWith(short.toLowerCase()));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.error(`Ambiguous id "${short}", matches ${matches.length} reports:`);
    for (const m of matches) console.error(`  ${m.id}`);
    process.exit(1);
  }
  return matches[0].id;
}

async function show(short) {
  const id = await resolveId(short);
  if (!id) return console.error(`No report matching "${short}".`);

  const { data: r, error } = await supabase.from("bug_reports").select("*").eq("id", id).single();
  if (error) return console.error(error.message);

  console.log(`REPORT ${r.id}`);
  console.log(`  user      ${r.user_id}`);
  console.log(`  platform  ${r.platform || "unknown"}${r.chat_id ? ` (chat ${r.chat_id})` : ""}`);
  console.log(`  reported  ${r.created_at}  (${ago(r.created_at)})`);
  console.log(`  status    ${r.status}${r.resolution_note ? ` — ${r.resolution_note}` : ""}`);
  console.log(`  comment   ${r.comment || "(none)"}`);
  if (logsGone(r.created_at)) {
    console.log(`  NOTE      older than Railway's 7 day log retention, logs for this window are gone`);
  } else {
    console.log(`  logs      pull Railway logs around ${r.created_at}`);
  }

  console.log(`\nTRANSCRIPT (last ${(r.transcript || []).length} turns, oldest first):`);
  for (const t of r.transcript || []) {
    console.log(`\n  ${t.role.toUpperCase()}: ${t.content}`);
  }

  const shots = r.screenshots || [];
  if (shots.length > 0) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    console.log(`\nSCREENSHOTS (${shots.length}), read these files to view them:`);
    for (const s of shots) {
      const local = path.join(SHOT_DIR, path.basename(s.path));
      const { data: blob, error: dlErr } = await supabase.storage.from("attachments").download(s.path);
      if (dlErr) {
        console.log(`  download failed for ${s.path}: ${dlErr.message}`);
        continue;
      }
      fs.writeFileSync(local, Buffer.from(await blob.arrayBuffer()));
      console.log(`  ${local}`);
    }
  }

  console.log(`\nResolve with: node scripts/bug-queue.js resolve ${r.id.substring(0, 8)} --note "what was fixed"`);
}

async function resolve(short, note) {
  const id = await resolveId(short);
  if (!id) return console.error(`No report matching "${short}".`);

  const { error } = await supabase
    .from("bug_reports")
    .update({ status: "resolved", resolution_note: note || null, resolved_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return console.error(error.message);
  console.log(`Resolved ${id.substring(0, 8)}${note ? `: ${note}` : ""}`);
}

// Hook mode: exit 2 (and print) only when there is something NOT yet announced,
// otherwise exit 0 silently. Paired with an asyncRewake hook this runs off the
// critical path, so it costs the user no latency, and it cannot nag: a report
// already surfaced this session stays quiet until it is resolved.
async function hookMode() {
  // Announce-once was designed against nagging, but a week-long session plus
  // context compaction turned "once" into "possibly never": an announcement
  // that got compacted away was gone for good, and a report filed days into a
  // session had no second chance. Open reports now re-surface every couple of
  // hours until resolved: rare enough not to nag, regular enough that nothing
  // can be lost.
  const REANNOUNCE_MS = 2 * 3600 * 1000;
  const seenPath = path.join(os.tmpdir(), "closedhand-bug-announced.json");
  let seen = {};
  try {
    const raw = JSON.parse(fs.readFileSync(seenPath, "utf8"));
    // migrate the old array shape (ids only) to id -> lastAnnounced
    seen = Array.isArray(raw) ? Object.fromEntries(raw.map(id => [id, Date.now()])) : raw;
  } catch (_) {}

  const { data, error } = await Promise.race([
    supabase.from("bug_reports").select("id, platform, comment, created_at")
      .eq("status", "open").order("created_at", { ascending: false }).limit(10),
    new Promise(resolve => setTimeout(() => resolve({ data: null, error: { message: "timeout" } }), 5000)),
  ]);
  if (error || !data) process.exit(0);

  const now = Date.now();
  const due = data.filter(r => !seen[r.id] || now - seen[r.id] > REANNOUNCE_MS);
  if (due.length === 0) process.exit(0);

  for (const r of due) seen[r.id] = now;
  // keep only entries for reports still open, so the file cannot grow forever
  const openIds = new Set(data.map(r => r.id));
  const pruned = Object.fromEntries(Object.entries(seen).filter(([id]) => openIds.has(id)));
  fs.writeFileSync(seenPath, JSON.stringify(pruned));

  const newOnes = due.filter(r => now - new Date(r.created_at).getTime() < REANNOUNCE_MS);
  const label = newOnes.length === due.length ? "just came in" : "open (some re-surfaced; still unresolved)";
  console.log(`${due.length} bug report${due.length > 1 ? "s" : ""} ${label}:`);
  for (const r of due) {
    console.log(`  ${r.id.substring(0, 8)}  ${r.platform || "unknown"}  ${r.comment || "(no comment)"}`);
  }
  console.log(`\nTriage with: node scripts/bug-queue.js show <id>`);
  process.exit(2); // wakes the model with the above as context
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "hook") return hookMode();
  const noteIdx = process.argv.indexOf("--note");
  const note = noteIdx > -1 ? process.argv[noteIdx + 1] : null;

  if (cmd === "show" && arg) await show(arg);
  else if (cmd === "resolve" && arg) await resolve(arg, note);
  else await list();
})().catch(e => {
  console.error(`bug-queue: ${e.message}`);
  process.exit(0); // never fail a session start
});
