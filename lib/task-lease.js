const { randomUUID } = require("crypto");
const owner = () => require("./task-model").currentTask()?.leaseOwner;
const LEASE_MS = 5 * 60 * 1000;
const allowed = new Set(["agent_tasks", "automation_runs"]);
async function claim(db, table, id, userId) {
  if (!allowed.has(table)) throw new Error("Unknown task table");
  const now = new Date().toISOString();
  const { data, error } = await db.from(table).update({ lease_owner: randomUUID(),
    lease_until: new Date(Date.now() + LEASE_MS).toISOString(), status: "running" })
    .eq("id", id).eq("user_id", userId).in("status", ["pending", "running"])
    .or("lease_until.is.null,lease_until.lt." + now).select();
  if (error) throw new Error("Task claim failed: " + error.message);
  return data?.[0] || null;
}
async function renew(db, table, id, token = owner()) {
  const { data, error } = await db.from(table).update({ lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
    .eq("id", id).eq("lease_owner", token).eq("status", "running").select("id");
  if (error) throw new Error("Could not check task lease: " + error.message);
  if (!data?.length) throw stopped();
}
async function release(db, table, id, token = owner()) {
  const { error } = await db.from(table).update({ lease_owner: null, lease_until: null }).eq("id", id).eq("lease_owner", token);
  if (error) console.error("Task lease release failed:", error.message);
}
function stopped() { const e = new Error("Task stopped or its execution lease was lost"); e.code = "TASK_STOPPED"; return e; }
async function update(db, table, id, updates) {
  const active = require("./task-model").currentTask();
  let query = db.from(table);
  query = query.update(updates).eq("id", id);
  const owned = active?.taskId === id && active?.leaseOwner;
  if (owned) query = query.eq("lease_owner", active.leaseOwner).eq("status", "running");
  const { data, error } = await query.select();
  if (error) throw new Error("Could not save task: " + error.message);
  if (owned && !data?.length) throw stopped();
  return data?.[0];
}
async function recoverable(db, table) {
  const { data, error } = await db.from(table).select("*").in("status", ["pending", "running"])
    .or("lease_until.is.null,lease_until.lt." + new Date().toISOString())
    .order(table === "agent_tasks" ? "created_at" : "started_at", { ascending: true }).limit(10);
  if (error) throw new Error("Could not discover unfinished tasks: " + error.message);
  return data || [];
}
module.exports = { claim, renew, release, update, recoverable, stopped };
