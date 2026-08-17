// lib/automations-store.js — CRUD for automations and automation_runs tables

const { supabase } = require("./db");

// --- Automations CRUD ---

async function createAutomation(userId, config) {
  // config: { name, description, status, trigger_type, trigger_cron, trigger_timezone,
  //   trigger_human_schedule, trigger_event_source, trigger_event_condition,
  //   task_prompt, task_model, task_tools, task_use_cloud, task_max_duration,
  //   output_destinations, output_urgent, chain_target_id, platform, chat_id }
  const { data, error } = await supabase
    .from("automations")
    .insert({ user_id: userId, ...config })
    .select()
    .single();
  if (error) throw new Error("Failed to create automation: " + error.message);
  return data;
}

async function updateAutomation(automationId, userId, updates) {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("automations")
    .update(updates)
    .eq("id", automationId)
    .eq("user_id", userId)
    .select()
    .single();
  if (error) throw new Error("Failed to update automation: " + error.message);
  return data;
}

async function deleteAutomation(automationId, userId) {
  const { error } = await supabase
    .from("automations")
    .delete()
    .eq("id", automationId)
    .eq("user_id", userId);
  if (error) throw new Error("Failed to delete automation: " + error.message);
  return true;
}

async function getAutomation(automationId, userId) {
  const { data, error } = await supabase
    .from("automations")
    .select("*")
    .eq("id", automationId)
    .eq("user_id", userId)
    .single();
  if (error) return null;
  return data;
}

async function listAutomations(userId) {
  const { data, error } = await supabase
    .from("automations")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("Failed to list automations:", error.message);
    return [];
  }
  return data || [];
}

async function getAutomationByName(userId, name) {
  const { data, error } = await supabase
    .from("automations")
    .select("*")
    .eq("user_id", userId)
    .eq("name", name)
    .single();
  if (error) return null;
  return data;
}

async function getActiveScheduledAutomations() {
  const { data, error } = await supabase
    .from("automations")
    .select("*")
    .eq("trigger_type", "scheduled")
    .eq("status", "active")
    .not("trigger_cron", "is", null);
  if (error) {
    console.error("Failed to get scheduled automations:", error.message);
    return [];
  }
  return data || [];
}

// --- Automation Runs CRUD ---

async function createRun(automationId, userId, opts = {}) {
  const row = {
    automation_id: automationId || null,
    user_id: userId,
    status: opts.status || "pending",
    model: opts.model || "pending",
    triggered_by: opts.triggered_by || "manual",
    input_context: opts.input_context || null,
    chain_source_id: opts.chain_source_id || null,
    platform: opts.platform || "dashboard",
    chat_id: opts.chat_id || "dashboard",
    progress: [],
    messages: [],
    tools_used: [],
  };
  const { data, error } = await supabase
    .from("automation_runs")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error("Failed to create run: " + error.message);
  return data;
}

async function updateRun(runId, updates) {
  const { data, error } = await supabase
    .from("automation_runs")
    .update(updates)
    .eq("id", runId)
    .select()
    .single();
  if (error) {
    console.error("Failed to update run:", error.message);
  }
  return data;
}

async function getRun(runId) {
  const { data, error } = await supabase
    .from("automation_runs")
    .select("id, automation_id, user_id, status, model, tools_used, progress, input_context, output_summary, full_report, error, started_at, completed_at, duration_secs, triggered_by, chain_source_id")
    .eq("id", runId)
    .single();
  if (error) return null;
  return data;
}

async function listRuns(automationId, userId, limit = 20) {
  let query = supabase
    .from("automation_runs")
    .select("id, automation_id, status, model, tools_used, output_summary, error, started_at, completed_at, duration_secs, triggered_by, chain_source_id")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (automationId) {
    query = query.eq("automation_id", automationId);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Failed to list runs:", error.message);
    return [];
  }
  return data || [];
}

async function getRunningRuns(userId) {
  const { data, error } = await supabase
    .from("automation_runs")
    .select("id")
    .eq("user_id", userId)
    .in("status", ["running", "pending"]);
  if (error) return [];
  return data || [];
}

async function getPendingRuns() {
  const { data, error } = await supabase
    .from("automation_runs")
    .select("*")
    .eq("status", "pending")
    .order("started_at", { ascending: true })
    .limit(5);
  if (error) {
    console.error("Failed to get pending runs:", error.message);
    return [];
  }
  return data || [];
}

async function getAutomationStats(userId) {
  // Get run stats
  const { data: runs, error: runsErr } = await supabase
    .from("automation_runs")
    .select("status, started_at, completed_at, duration_secs")
    .eq("user_id", userId);

  // Get saved automation count
  const { data: autos, error: autosErr } = await supabase
    .from("automations")
    .select("id")
    .eq("user_id", userId);

  if (runsErr || autosErr) {
    console.error("Stats error:", runsErr?.message, autosErr?.message);
    return { running: 0, completedToday: 0, savedCount: 0, avgDuration: 0 };
  }

  const allRuns = runs || [];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  const running = allRuns.filter(r => r.status === "running" || r.status === "pending").length;
  const completedToday = allRuns.filter(r => r.status === "success" && r.completed_at && r.completed_at >= todayStart).length;
  const savedCount = (autos || []).length;

  const completed = allRuns.filter(r => r.status === "success" && r.duration_secs);
  const avgDuration = completed.length > 0
    ? Math.round(completed.reduce((sum, r) => sum + (r.duration_secs || 0), 0) / completed.length)
    : 0;

  return { running, completedToday, savedCount, avgDuration };
}

module.exports = {
  createAutomation, updateAutomation, deleteAutomation,
  getAutomation, listAutomations, getAutomationByName,
  getActiveScheduledAutomations,
  createRun, updateRun, getRun, listRuns,
  getRunningRuns, getPendingRuns, getAutomationStats,
};
