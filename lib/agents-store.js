// lib/agents-store.js — Supabase CRUD for agent_tasks table

const { supabase } = require("./db");

async function createTask(userId, goal, model, platform, chatId, title = null, successCriteria = null) {
  const { data, error } = await supabase
    .from("agent_tasks")
    .insert({
      user_id: userId,
      goal,
      title,
      success_criteria: successCriteria,
      model,
      platform,
      chat_id: chatId,
      status: "running",
      progress: [],
      messages: [],
      tools_used: [],
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create agent task: ${error.message}`);
  return data;
}

async function updateTask(taskId, updates) {
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from("agent_tasks")
    .update(updates)
    .eq("id", taskId);

  if (error) console.error(`Failed to update agent task ${taskId}:`, error.message);
}

async function getActiveTasks(userId) {
  const { data, error } = await supabase
    .from("agent_tasks")
    .select("id, goal, status, model, progress, tools_used, error, created_at, completed_at")
    .eq("user_id", userId)
    .in("status", ["running", "pending", "completed", "failed", "cancelled"])
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Failed to fetch agent tasks:", error.message);
    return [];
  }
  return data || [];
}

async function getTask(taskId) {
  const { data, error } = await supabase
    .from("agent_tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (error) return null;
  return data;
}

async function getRunningTasks() {
  const { data, error } = await supabase
    .from("agent_tasks")
    .select("*")
    .eq("status", "running");

  if (error) {
    console.error("Failed to fetch running agent tasks:", error.message);
    return [];
  }
  return data || [];
}

module.exports = { createTask, updateTask, getActiveTasks, getTask, getRunningTasks };
