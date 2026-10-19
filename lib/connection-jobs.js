// lib/connection-jobs.js: a connected service doing one of Closedhand's jobs.
//
// When the person has connected a service that does a job Closedhand also
// does itself, such as searching the web (found when it was connected,
// webapp/connection-jobs.js), and left that job's switch on its tile on,
// Closedhand uses it first, without being asked to. Whatever goes wrong falls
// back to Closedhand's own for that request, and the tile says why. Switched
// off or disconnected, there is only Closedhand's own. The voice works the
// same way, with its own sound handling (lib/voice-connections.js).

const db = () => require("./db").supabase;
const MAX_TEXT = 12000;
// How the tile says what failed: "Kestrel couldn't search: ...".
const VERB = { search: "search" };

// The connection switched on for a job, or null.
async function connectionFor(userId, job, deps = {}) {
  if (!userId) return null;
  const { data, error } = await (deps.db || db()).from("user_mcps").select("id, name, caps, updated_at, transport").eq("user_id", userId).eq("status", "connected");
  if (error) throw new Error(error.message);
  return (data || []).filter((r) => r.caps?.jobs?.[job]?.on)
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))[0] || null;
}

// The tile shows the last time Closedhand's own stood in, and why; a working
// connection clears it. Nothing is written while nothing changes.
async function note(row, job, why, deps = {}) {
  const was = row.caps?.jobs?.[job]?.fallback?.why || null;
  const now = why ? String(why).slice(0, 200) : null;
  if (was === now) return;
  const store = deps.db || db();
  const { data, error } = await store.from("user_mcps").select("caps").eq("id", row.id).single();
  if (error || !data?.caps?.jobs?.[job]) return;
  const plan = { ...data.caps.jobs[job] };
  if (now) plan.fallback = { at: new Date().toISOString(), why: now }; else delete plan.fallback;
  // caps holds no secrets, so there is nothing to seal.
  const { error: writeError } = await store.from("user_mcps").update({ caps: { ...data.caps, jobs: { ...data.caps.jobs, [job]: plan } } }).eq("id", row.id);
  if (writeError) console.warn(`[connection-jobs] couldn't note the fallback on ${row.name}: ${writeError.message}`);
}

// The text in a tool's answer: what it wrote, and anything structured.
function textOf(result) {
  const parts = ((result && result.content) || []).filter((c) => c && c.type === "text").map((c) => String(c.text || ""));
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n").trim();
}

// Does a job through the connection switched on for it. inputs are the
// job's own (search: { query }). Returns { text, source } or null, when no
// connection is on for it or it failed.
async function run(userId, job, inputs, deps = {}) {
  const row = await connectionFor(userId, job, deps).catch(() => null);
  if (!row) return null;
  const plan = row.caps.jobs[job];
  const args = { ...(plan.fixed || {}) };
  for (const [input, arg] of Object.entries(plan.args || {})) args[arg] = inputs[input];
  try {
    const call = deps.callTool || (row.transport === "api" ? require("./api-connections").callEndpoint : require("./user-mcp").callConnectionTool);
    const result = await call(userId, row.id, plan.tool, args);
    const text = textOf(result);
    if (result?.isError) throw new Error(text.slice(0, 200) || "it said no");
    if (!text) throw new Error("it sent back nothing");
    await note(row, job, null, deps).catch(() => {});
    return { text: text.slice(0, MAX_TEXT), source: row.name };
  } catch (e) {
    console.warn(`[connection-jobs] ${row.name} couldn't ${VERB[job] || job}, so Closedhand's own did: ${e.message}`);
    await note(row, job, `${row.name} couldn't ${VERB[job] || job}: ${e.message}`, deps).catch(() => {});
    return null;
  }
}

module.exports = { run, connectionFor, textOf };
