// lib/skills.js — Markdown skill loader and prompt injector

const fs = require("fs");
const path = require("path");

const SKILLS_DIR = path.resolve(__dirname, "..", "skills");

let _skills = []; // Loaded at startup

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Simple regex-based parser — no external dependencies.
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.substring(0, idx).trim();
    let val = line.substring(idx + 1).trim();
    // Handle arrays like "triggers: [sales, orders, revenue]"
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    // Handle comma-separated services
    else if (key === "requires_service" && val.includes(",")) {
      val = val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    meta[key] = val;
  }
  return { meta, body: match[2].trim() };
}

/**
 * Scan skills/ directory at startup and load all SKILL.md files.
 */
function loadAllSkills() {
  _skills = [];

  if (!fs.existsSync(SKILLS_DIR)) {
    console.log("No skills/ directory found, skipping skill loading.");
    return;
  }

  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const mdPath = path.join(SKILLS_DIR, dir.name, "SKILL.md");
    if (!fs.existsSync(mdPath)) continue;

    try {
      const raw = fs.readFileSync(mdPath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      _skills.push({
        id: dir.name,
        name: meta.name || dir.name,
        description: meta.description || "",
        requires_service: meta.requires_service || null,
        triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
        always_active: meta.always_active === true || meta.always_active === "true",
        body,
      });
    } catch (e) {
      console.error(`Failed to load skill ${dir.name}:`, e.message);
    }
  }

  console.log(`Loaded ${_skills.length} skills: ${_skills.map((s) => s.id).join(", ")}`);
}

/**
 * Build skills block to inject into the system prompt.
 * - Filters by connected services
 * - Always shows 1-line descriptions of available skills
 * - If userMessage matches triggers, injects the full skill body
 */
function getSkillsForPrompt(userStore, userMessage = "") {
  if (_skills.length === 0) return "";

  const msgLower = (userMessage || "").toLowerCase();

  // Filter skills by connected services
  const available = _skills.filter((skill) => {
    if (!skill.requires_service) return true;
    const required = Array.isArray(skill.requires_service)
      ? skill.requires_service
      : [skill.requires_service];
    // ALL required services must be connected
    return required.every((svc) => userStore?.isConnected(svc));
  });

  if (available.length === 0) return "";

  // Always include brief skill list
  let block = "\nAVAILABLE SKILLS:\n";
  for (const skill of available) {
    block += `- ${skill.name}: ${skill.description}\n`;
  }

  // Always-active skills: inject full body regardless of message
  const alwaysActive = available.filter((skill) => skill.always_active);
  if (alwaysActive.length > 0) {
    block += "\n";
    for (const skill of alwaysActive) {
      block += `--- SKILL: ${skill.name} ---\n${skill.body}\n\n`;
    }
  }

  // Check for trigger matches — inject full body if matched
  const triggered = available.filter((skill) =>
    !skill.always_active && skill.triggers.length > 0 && skill.triggers.some((t) => msgLower.includes(t))
  );

  if (triggered.length > 0) {
    block += "\n";
    for (const skill of triggered) {
      block += `--- SKILL: ${skill.name} ---\n${skill.body}\n\n`;
    }
  }

  return block;
}

// Built-in skills live as files on disk, not in the user_skills table, so
// anything resolving a skill by name has to be able to reach them here.
function getBuiltInSkill(name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return null;
  // The picker and task_tools use the folder slug ("meta-ads"), while the
  // skill calls itself "Meta Ads". Match either, or the lookup finds nothing
  // for every skill that has a display name, which is all of them.
  return _skills.find((s) => String(s.id).toLowerCase() === want)
    || _skills.find((s) => String(s.name).toLowerCase() === want)
    || null;
}

function listBuiltInSkills() {
  return _skills
    .filter((s) => !s.always_active) // already injected everywhere, nothing to choose
    .map((s) => ({ id: s.id, name: s.name, description: s.description }));
}

module.exports = { loadAllSkills, getSkillsForPrompt, getBuiltInSkill, listBuiltInSkills };
