// Supply current task state with each chat message, independently of old chat
// messages. A finished or failed task must never be described as still running.
//
// Every recent task goes with its status. A result excerpt goes only with a
// result that has not reached the conversation yet: once a run's answer is
// delivered it sits in the chat itself, and resending days-old excerpts with
// every message cost thousands of tokens that are never cached. The rest of a
// result is one agent_report_read away. How to read this block is explained
// once, in the cached prompt (BACKGROUND TASKS in lib/engine.js).
const TITLE_CHARS = 120;
const EXCERPT_CHARS = 400;
const ERROR_CHARS = 200;

async function agentStateForPrompt(db, userId) {
  if (!userId) return "";
  try {
    const { data, error } = await db.from("agent_tasks")
      .select("id,title,goal,status,error,result,created_at,completed_at,delivery_status")
      .eq("user_id", userId).order("updated_at", { ascending: false }).limit(10);
    if (error) throw error;
    const tasks = (data || []).map(task => {
      const row = {
        id: task.id, title: String(task.title || task.goal || "").slice(0, TITLE_CHARS),
        status: task.status, created_at: task.created_at, completed_at: task.completed_at,
      };
      if (task.error) row.error = String(task.error).slice(0, ERROR_CHARS);
      // Delivery marks it sent (or uncertain) once the answer is in the chat.
      if (task.result && task.delivery_status === "pending") row.result_excerpt = String(task.result).slice(0, EXCERPT_CHARS);
      return row;
    });
    return "\nCURRENT BACKGROUND TASK STATE (checked for this message):\n" + JSON.stringify(tasks) + "\n";
  } catch (_) {
    return "\nCurrent background task state could not be checked. If asked about progress, say the current status is unavailable rather than inferring from old messages that a task is running or finished.\n";
  }
}
module.exports = { agentStateForPrompt };
