const { textOf, evidenceFrom } = require("./task-evidence");

// A task that ran out of time with nothing written yet still has its evidence:
// one small call, outside the exhausted budget and with no tools, turns that
// into the answer. Before this, a run that had gathered 81 sale records and
// never got to write them up failed with an empty result.
async function writeUpFromEvidence(row, evidence, error) {
  if (!evidence.length) return null;
  try {
    const { getInternalClient } = require("./llm");
    const { UserStore } = require("../user-store");
    const userStore = await UserStore.load(row.user_id);
    const { client, model } = getInternalClient(row.user_id, userStore);
    if (!client) return null;
    // The evidence is a list of tool calls and results; it goes in as JSON,
    // not as a template string, which turned every entry into "[object Object]".
    const shown = JSON.stringify(evidence, null, 1).slice(0, 60000);
    // A reply's goal is only the reply; the message it answered rides in the
    // request context, and without it the question itself is missing.
    const context = (row.runtime?.request?.context || []).map(m => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n").slice(0, 6000);
    const prompt = `The task below stopped early (${error.message}). Write the final answer for the user now, from the evidence gathered and nothing else: what was found, with the figures and where they came from; what could not be obtained and why. Plain sentences, no headings, no offers to continue. If the evidence does not answer the question, say what it does show.\n\nTASK:\n${row.goal}${context ? "\n\nWHAT THE USER WAS REPLYING TO AND SAID BEFORE:\n" + context : ""}\n\nEVIDENCE GATHERED (tool calls and their results, JSON):\n${shown}`;
    const response = await Promise.race([
      client.messages.create({ model, max_tokens: 2000, effort: "fast", messages: [{ role: "user", content: prompt }] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("write-up timed out")), 60000)),
    ]);
    const text = (response.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return text || null;
  } catch (e) {
    console.warn(`[task-outcome] could not write up ${row.id}: ${e.message}`);
    return null;
  }
}

async function saveInterrupted(table, id, error) {
  const { supabase } = require("./db");
  const { data: row, error: readError } = await supabase.from(table).select("*").eq("id", id).single();
  if (readError) throw readError;
  const messages = row?.messages || [];
  const evidence = evidenceFrom(messages, 12000);
  const answer = [...messages].reverse().find(m => m.role === "assistant" && textOf(m.content).trim());
  let report = evidence.length && answer ? "This task stopped before completion. These written findings have not been fully checked.\n\n" + textOf(answer.content) : null;
  if (!report) {
    const written = await writeUpFromEvidence(row, evidence, error);
    if (written) report = "This task ran out of time before finishing. What it found:\n\n" + written;
  }
  const runtime = { ...(row.runtime || {}), budget: require("./task-model").budgetSnapshot() };
  const status = report ? "partial" : "failed";
  const updates = { status, error: String(error.message).slice(0, 1000), runtime, completed_at: new Date().toISOString(), delivery_status: "pending" };
  updates[table === "agent_tasks" ? "result" : "full_report"] = report;
  await require("./task-lease").update(supabase, table, id, updates);
  return { status, result: report, error: error.message };
}
module.exports = { saveInterrupted };
