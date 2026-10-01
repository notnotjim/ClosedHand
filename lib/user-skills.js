// lib/user-skills.js — skills the user installed from the dashboard, in chat.
//
// Built-in skills live on disk and lib/skills.js injects them. The ones a
// person installs from a link land in user_skills, and until now nothing read
// that table in a conversation: only an automation pinned to "skill:<name>"
// ever saw them. This module keeps a short-lived copy per user, warmed at the
// start of a turn (the prompt builder is synchronous), lists every installed
// skill so the model knows it exists, and injects the full text when the
// message names it or the model asks for it with use_skill.

const { supabase } = require("./db");
const { parseFrontmatter } = require("./skills");

const _cache = new Map(); // userId -> { at, skills: [{ id, name, description, body, triggers, always }] }
const TTL_MS = 60 * 1000;

function normalise(row) {
  const { meta, body } = parseFrontmatter(row.content || "");
  const name = String(meta.name || row.name || "").trim();
  const description = String(meta.description || row.description || "").trim().replace(/^["']|["']$/g, "");
  const triggers = Array.isArray(meta.triggers) ? meta.triggers : [];
  // "brand-voice" should fire on "brand voice" as well as the slug.
  const words = name.toLowerCase().replace(/[-_]+/g, " ").trim();
  if (words) triggers.push(words);
  if (name && name.toLowerCase() !== words) triggers.push(name.toLowerCase());
  return {
    id: row.id,
    name: name || row.name,
    description: description.slice(0, 200),
    body: body || row.content || "",
    triggers: [...new Set(triggers.filter(Boolean))],
    always: meta.always_active === true || meta.always_active === "true",
  };
}

async function warmUserSkills(userId) {
  if (!userId) return [];
  const hit = _cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.skills;
  const { data, error } = await supabase
    .from("user_skills")
    .select("id, name, description, content")
    .eq("user_id", userId);
  if (error) { console.error("[user-skills] load failed:", error.message); return hit ? hit.skills : []; }
  const skills = (data || []).map(normalise);
  _cache.set(userId, { at: Date.now(), skills });
  return skills;
}

function invalidateUserSkills(userId) {
  _cache.delete(userId);
}

function cached(userId) {
  const hit = _cache.get(userId);
  return hit ? hit.skills : [];
}

// The block for the system prompt: a line per installed skill, and the full
// text of any the message calls for.
function getUserSkillsBlock(userId, userMessage = "") {
  const skills = cached(userId);
  if (!skills.length) return "";
  const msg = String(userMessage || "").toLowerCase();
  let block = "\nSKILLS THE USER INSTALLED (full text via use_skill when one applies):\n";
  for (const s of skills) block += `- ${s.name}${s.description ? ": " + s.description : ""}\n`;
  const fire = skills.filter((s) => s.always || s.triggers.some((t) => t.length > 2 && msg.includes(t)));
  for (const s of fire) block += `\n--- SKILL: ${s.name} ---\n${s.body}\n`;
  return block;
}

function getUserSkill(userId, name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return null;
  const skills = cached(userId);
  return skills.find((s) => s.name.toLowerCase() === want)
    || skills.find((s) => s.name.toLowerCase().replace(/[-_]+/g, " ") === want.replace(/[-_]+/g, " "))
    || skills.find((s) => s.name.toLowerCase().includes(want))
    || null;
}

module.exports = { warmUserSkills, invalidateUserSkills, getUserSkillsBlock, getUserSkill };
