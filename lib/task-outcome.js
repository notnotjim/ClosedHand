const { textOf, evidenceFrom } = require("./task-evidence");
async function saveInterrupted(table, id, error) {
  const { supabase } = require("./db");
  const { data: row, error: readError } = await supabase.from(table).select("*").eq("id", id).single();
  if (readError) throw readError;
  const messages = row?.messages || [];
  const evidence = evidenceFrom(messages, 12000);
  const answer = [...messages].reverse().find(m => m.role === "assistant" && textOf(m.content).trim());
  const report = evidence.length && answer ? "This task stopped before completion. These written findings have not been fully checked.\n\n" + textOf(answer.content) : null;
  const runtime = { ...(row.runtime || {}), budget: require("./task-model").budgetSnapshot() };
  const status = report ? "partial" : "failed";
  const updates = { status, error: String(error.message).slice(0, 1000), runtime, completed_at: new Date().toISOString(), delivery_status: "pending" };
  updates[table === "agent_tasks" ? "result" : "full_report"] = report;
  await require("./task-lease").update(supabase, table, id, updates);
  return { status, result: report, error: error.message };
}
module.exports = { saveInterrupted };
