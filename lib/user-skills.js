// lib/user-skills.js — skills the user installed from the dashboard, in chat.
//
// Built-in skills live on disk and lib/skills.js injects them. The ones a
// person installs from a link land in user_skills, and until now nothing read
// that table in a conversation: only an automation pinned to "skill:<name>"
// ever saw them. This module keeps a short-lived copy per user, warmed at the
// start of a turn (the prompt builder is synchronous), lists every installed
// skill so the model knows it exists, and injects the full text when the
// message names it or the model asks for it with use_skill.
//
// Skills Closedhand learned itself (lib/skill-learning.js, category
// "learned") are not listed: a list that grows with every skill would sit in
// every message. Each loads only when the message says one of its triggers as
// whole words, two at most, and each use is counted for the dashboard and for
// removing the ones nobody needs.

const { supabase } = require("./db");
const { parseFrontmatter } = require("./skills");

const _cache = new Map(); // userId -> { at, skills: [{ id, name, description, body, triggers, always, learned, uses }] }
const TTL_MS = 60 * 1000;
const MAX_LEARNED_IN_PROMPT = 2;
const _counted = new Map(); // "userId:skillId" -> when its use was last counted
const COUNT_GAP_MS = 10 * 60 * 1000;

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
    always: row.category !== "learned" && (meta.always_active === true || meta.always_active === "true"),
    learned: row.category === "learned",
    uses: row.uses || 0,
  };
}

async function warmUserSkills(userId) {
  if (!userId) return [];
  const hit = _cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.skills;
  const { data, error } = await supabase
    .from("user_skills")
    .select("id, name, description, content, category, uses")
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

// A learned skill answers to its triggers as whole words, never inside
// another word ("insta" in "install").
function firesOn(skill, text) {
  const msg = String(text || "").toLowerCase();
  return (skill.triggers || []).some((t) => {
    const s = String(t).toLowerCase().trim();
    return s.length > 3 && new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(msg);
  });
}

// Counted once per task, however many times the prompt is rebuilt.
function noteUsed(userId, skill) {
  if (!userId || !skill?.id) return;
  const key = `${userId}:${skill.id}`;
  if (Date.now() - (_counted.get(key) || 0) < COUNT_GAP_MS) return;
  _counted.set(key, Date.now());
  skill.uses = (skill.uses || 0) + 1;
  supabase.from("user_skills").update({ uses: skill.uses, last_used_at: new Date().toISOString() }).eq("id", skill.id).eq("user_id", userId)
    .then(({ error }) => { if (error) console.error("[user-skills] use not counted:", error.message); }, () => {});
}

// The block for the system prompt: a line per skill the person added, the
// full text of any the message calls for, and the learned skills it fires.
function getUserSkillsBlock(userId, userMessage = "") {
  const skills = cached(userId);
  if (!skills.length) return "";
  const msg = String(userMessage || "").toLowerCase();
  const added = skills.filter((s) => !s.learned);
  let block = "";
  if (added.length) {
    block += "\nSKILLS THE USER INSTALLED (full text via use_skill when one applies):\n";
    for (const s of added) block += `- ${s.name}${s.description ? ": " + s.description : ""}\n`;
    const fire = added.filter((s) => s.always || s.triggers.some((t) => t.length > 2 && msg.includes(t)));
    for (const s of fire) block += `\n--- SKILL: ${s.name} ---\n${s.body}\n`;
  }
  const learned = skills.filter((s) => s.learned && firesOn(s, msg)).slice(0, MAX_LEARNED_IN_PROMPT);
  if (learned.length) {
    block += "\nSKILLS YOU LEARNED (your own notes from doing this kind of task before; follow them unless the person asks otherwise):\n";
    for (const s of learned) { block += `\n--- SKILL: ${s.name} ---\n${s.body}\n`; noteUsed(userId, s); }
  }
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

module.exports = { warmUserSkills, invalidateUserSkills, getUserSkillsBlock, getUserSkill, firesOn, noteUsed };
