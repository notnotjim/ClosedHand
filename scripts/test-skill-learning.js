// Closedhand writes down how it did a kind of task, as a skill, only when it
// had to work the method out (lib/skill-learning.js). These hold the guards
// that keep that from filling up with bodged or scattered skills: a strict
// gate before the LLM is asked at all, one fixed layout checked by code,
// specific triggers, nothing personal, no second skill for the same task,
// only "safe" from the security review, and only learned skills ever
// changed. The writer never sees what a tool returned.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// ---- Stand-ins for the database, the LLM and the chat ----
const db = { rows: [], log: [] };
function query(table) {
  const filters = [];
  let op = "select", patch = null;
  const match = (r) => filters.every(([k, how, v]) => how === "eq" ? r[k] === v : how === "lt" ? r[k] != null && r[k] < v : how === "is" ? r[k] == v : true);
  const q = {
    select() { return q; },
    eq(k, v) { filters.push([k, "eq", v]); return q; },
    lt(k, v) { filters.push([k, "lt", v]); return q; },
    is(k, v) { filters.push([k, "is", v]); return q; },
    update(p) { op = "update"; patch = p; return q; },
    delete() { op = "delete"; return q; },
    insert(row) {
      const r = { id: "s" + (db.rows.length + 1), installed_at: new Date().toISOString(), uses: 0, last_used_at: null, ...row };
      db.rows.push(r); db.log.push(["insert", r.name]);
      return Promise.resolve({ error: null });
    },
    then(resolve, reject) {
      const hit = db.rows.filter((r) => r._table === undefined && match(r));
      if (op === "update") { for (const r of hit) Object.assign(r, patch); db.log.push(["update", hit.map((r) => r.name)]); }
      if (op === "delete") { db.rows = db.rows.filter((r) => !hit.includes(r)); db.log.push(["delete", hit.map((r) => r.name)]); }
      return Promise.resolve({ data: op === "select" ? hit : null, error: null }).then(resolve, reject);
    },
  };
  return q;
}
const llm = { answers: [], prompts: [] };
const sent = [];
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub("../lib/db", { supabase: { from: query } });
stub("../lib/llm", { getInternalClient: () => ({ model: "test-model", client: { messages: { create: async (req) => {
  llm.prompts.push(req);
  const next = llm.answers.shift();
  return { content: [{ type: "text", text: typeof next === "string" ? next : JSON.stringify(next) }] };
} } } }) });
stub("../lib/messaging", { sendToPlatform: async (platform, to, text) => { sent.push({ platform, to, text }); } });

const learning = require("../lib/skill-learning");
const userSkills = require("../lib/user-skills");

const ok = (name, input) => ({ use: { type: "tool_use", id: name + JSON.stringify(input), name, input }, result: { tool_use_id: name + JSON.stringify(input), content: '{"found":3,"body":"Dear Sam, the secret code is 4471"}' } });
const bad = (name, input, error) => ({ use: { type: "tool_use", id: name + JSON.stringify(input), name, input }, result: { tool_use_id: name + JSON.stringify(input), content: JSON.stringify({ error }), is_error: true } });
const round = (...calls) => [calls.map((c) => c.use), calls.map((c) => c.result)];

const goodSkill = {
  decision: "new", why: "Took four tries to find the permalink route.", skill: "",
  name: "Comment on Instagram posts",
  description: "Leave a comment on one of the person's own Instagram posts through the sandbox computer's browser.",
  triggers: ["comment on my instagram", "instagram comment", "comment on my post"],
  when: "When the person asks to comment on, or reply under, one of their own Instagram posts.",
  steps: ["Read the post links from the profile page in one eval_js call.", "Open the post by its own link.", "Type the comment in the box under the post and press Post."],
  avoid: ["Clicking from the home feed to the profile grid uses up the step budget; open each post by its own link instead."],
  check: "The comment shows under the post with the person's name beside it.",
};

function freshSkills() {
  db.rows = []; db.log = []; llm.answers = []; llm.prompts = []; sent.length = 0;
  learning._reset();
  userSkills.invalidateUserSkills("u1");
}

const struggled = () => {
  const r1 = round(bad("sandbox_browse", { action: "click", selector: "a.profile", _userId: "u1" }, "Element not found"));
  const r2 = round(ok("sandbox_browse", { action: "eval_js", script: "links()" }), ok("sandbox_browse", { action: "goto", url: "https://www.instagram.com/p/XYZ/" }));
  const r3 = round(ok("sandbox_browse", { action: "type", text: "Lovely" }));
  return [r1, r2, r3].flatMap(([uses, results]) => learning.stepsFrom(uses, results));
};

test("a step keeps the tool, what was sent and whether it worked, never what came back", () => {
  const steps = struggled();
  assert.equal(steps.length, 4);
  assert.deepEqual(steps[0], { tool: "sandbox_browse", sent: '{"action":"click","selector":"a.profile"}', ok: false, error: "Element not found" });
  assert.equal(steps[1].ok, true);
  assert.doesNotMatch(JSON.stringify(steps), /secret code|Dear Sam|_userId/);
  const msgs = [{ role: "user", content: "go" }, { role: "assistant", content: [steps && { type: "tool_use", id: "a", name: "gmail_search", input: { query: "x" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "[]" }] }];
  assert.deepEqual(learning.stepsFromMessages(msgs), [{ tool: "gmail_search", sent: '{"query":"x"}', ok: true, error: null }]);
});

test("only a task that had to be worked out is reviewed at all", () => {
  const smooth = Array.from({ length: 12 }, () => ({ tool: "web_search", ok: true }));
  assert.equal(learning.worthReviewing({ steps: smooth, request: "find me hotels in Lisbon" }), false, "long and smooth: nothing to learn");
  assert.equal(learning.worthReviewing({ steps: [...smooth.slice(0, 3), { tool: "web_search", ok: false }], request: "x" }), true);
  assert.equal(learning.worthReviewing({ steps: [{ ok: false }, { ok: true }, { ok: true }], request: "x" }), false, "too short");
  assert.equal(learning.worthReviewing({ steps: smooth.slice(0, 5), request: "No, don't use the API, do it in the browser" }), true, "corrected");
  assert.equal(learning.worthReviewing({ steps: smooth.slice(0, 2), request: "remember how you did that for next time", asked: true }), true);
});

test("a skill is laid out the same way every time, or not kept", () => {
  const shaped = learning.shapeSkill(goodSkill, { name: "Sam Rivers" });
  assert.equal(shaped.problems, undefined);
  assert.match(shaped.content, /^---\nname: Comment on Instagram posts\ndescription: .+\ntriggers: \[comment on my instagram, instagram comment, comment on my post\]\n---\n\n## When to use\n.+\n\n## Steps\n1\. Read .+\n2\. Open .+\n3\. Type .+\n\n## Mistakes to avoid\n- Clicking .+\n\n## How to check it worked\n.+\n$/);
  const off = (patch) => learning.shapeSkill({ ...goodSkill, ...patch }, { name: "Sam Rivers", email: "sam@example.com" }).problems || [];
  assert.ok(off({ triggers: ["email", "comment on my post"] }).includes("triggers"), "a lone everyday word loads it everywhere");
  assert.ok(off({ triggers: ["comment on my post"] }).includes("triggers"), "at least two ways of asking");
  const kept = learning.shapeSkill({ ...goodSkill, triggers: ["receipts", "my last post", "comment on my instagram", "instagram comment"] });
  assert.match(kept.content, /\ntriggers: \[comment on my instagram, instagram comment\]\n/, "a vague trigger is dropped, the skill kept");
  assert.ok(off({ avoid: [] }).includes("mistakes"), "the hard-won part is required");
  assert.ok(off({ steps: ["Do it."] }).includes("steps"));
  assert.ok(off({ steps: [...goodSkill.steps, "Then tell Sam it is done."] }).some((p) => /person's name/.test(p)));
  assert.ok(off({ check: "Mail sam@example.com to confirm it posted." }).some((p) => /email address/.test(p)));
  assert.ok(off({ steps: [...goodSkill.steps, "Use order 99812345 as the example."] }).some((p) => /long number/.test(p)));
  assert.equal(learning.shapeSkill({ ...goodSkill, name: "Comment \u2014 then check" }).name, "Comment, then check", "no em dashes");
});

test("a second skill for the same kind of task is refused", () => {
  const shaped = learning.shapeSkill(goodSkill);
  assert.equal(learning.overlaps(shaped, [{ name: "Instagram post comments", triggers: ["reply on insta"] }]), "Instagram post comments", "same name in other words");
  assert.equal(learning.overlaps(shaped, [{ name: "Export Shopify orders", triggers: ["instagram comment"] }]), "Export Shopify orders", "a trigger already taken");
  assert.equal(learning.overlaps(shaped, [{ name: "Export Shopify orders", triggers: ["shopify orders export"] }]), null);
});

test("a learned skill fires on whole words, two at most, and each use counts once", async () => {
  freshSkills();
  db.rows.push(
    { id: "a", user_id: "u1", name: "Comment on Instagram posts", category: "learned", uses: 0, content: "---\nname: Comment on Instagram posts\ndescription: d\ntriggers: [instagram comment, insta]\n---\n\nSTEPS A" },
    { id: "b", user_id: "u1", name: "Brand voice", category: "community", uses: 0, content: "---\nname: Brand voice\ndescription: How we write\n---\n\nSTEPS B" },
  );
  await userSkills.warmUserSkills("u1");
  const quiet = userSkills.getUserSkillsBlock("u1", "please install the app");
  assert.match(quiet, /- Brand voice: How we write/, "a skill the person added is listed");
  assert.doesNotMatch(quiet, /Instagram|STEPS A/, "a learned one is not listed, and 'insta' is not inside 'install'");
  const fired = userSkills.getUserSkillsBlock("u1", "leave an Instagram comment on my last photo");
  assert.match(fired, /SKILLS YOU LEARNED[\s\S]*--- SKILL: Comment on Instagram posts ---\nSTEPS A/);
  userSkills.getUserSkillsBlock("u1", "leave an Instagram comment on my last photo");
  await new Promise((r) => setImmediate(r));
  assert.equal(db.rows.find((r) => r.id === "a").uses, 1, "counted once, however often the prompt is rebuilt");
});

test("a struggled task leaves one clean, scanned skill and says so once", async () => {
  freshSkills();
  llm.answers.push(goodSkill, { risk_level: "safe", findings: [], summary: "Plain instructions" });
  const out = await learning.considerTurn({ userId: "u1", store: { profile: { display_name: "Sam Rivers" } }, platform: "whatsapp", chatId: "chat-9",
    request: "comment 'Lovely' on my latest Instagram post", steps: struggled(), reply: "Done, it's posted.", conversation: [] });
  assert.deepEqual(out, { learned: "Comment on Instagram posts" });
  const row = db.rows.find((r) => r.name === "Comment on Instagram posts");
  assert.equal(row.category, "learned");
  assert.equal(row.learned_from, "whatsapp");
  assert.deepEqual(sent, [{ platform: "whatsapp", to: "chat-9", text: learning.savedNotice("Comment on Instagram posts") }]);
  const reviewed = llm.prompts[0].messages[0].content;
  assert.match(reviewed, /The default is NONE/);
  assert.match(reviewed, /1\. sandbox_browse sent \{"action":"click","selector":"a.profile"\} -> failed: Element not found/);
  assert.doesNotMatch(reviewed, /secret code|Dear Sam/, "what tools returned never reaches the writer");
  assert.match(llm.prompts[1].messages[0].content, /Analyze this skill file for security risks/, "the same review a pasted skill gets");
});

test("nothing is saved when the review is not clean or the writer says none, and a good one is never turned away by a count", async () => {
  freshSkills();
  llm.answers.push(goodSkill, { risk_level: "warning", findings: [{ severity: "warning", description: "x" }], summary: "x" });
  assert.equal(await learning.consider({ userId: "u1", platform: "web", request: "x", steps: struggled(), reply: "", recent: [], from: "web" }), null);
  assert.equal(db.rows.length, 0, "a warning has nobody to accept it");
  freshSkills();
  llm.answers.push({ decision: "none", why: "One-off research." });
  assert.equal(await learning.consider({ userId: "u1", request: "x", steps: struggled(), reply: "", recent: [], from: "web" }), null);
  assert.equal(llm.prompts.length, 1, "no scan without a skill");
  freshSkills();
  for (const n of ["Export Shopify orders", "File monthly receipts", "Book a squash court"]) db.rows.push({ id: n, user_id: "u1", name: n, category: "learned", installed_at: new Date().toISOString(), content: `---\nname: ${n}\ntriggers: [${n.toLowerCase()}]\n---\n\nx` });
  llm.answers.push(goodSkill, { risk_level: "safe", findings: [], summary: "ok" });
  assert.deepEqual(await learning.consider({ userId: "u1", request: "x", steps: struggled(), reply: "", recent: [], from: "web" }), { learned: "Comment on Instagram posts" }, "no quota: a good skill is kept however many came before it");
});

test("only skills Closedhand learned are ever changed or removed", async () => {
  freshSkills();
  db.rows.push({ id: "p", user_id: "u1", name: "Brand voice", category: "community", content: "---\nname: Brand voice\n---\n\nmine" });
  llm.answers.push({ ...goodSkill, decision: "update", skill: "Brand voice" });
  assert.equal(await learning.consider({ userId: "u1", request: "x", steps: struggled(), reply: "", recent: [], from: "web" }), null);
  assert.equal(db.rows[0].content, "---\nname: Brand voice\n---\n\nmine");
  db.rows.push({ id: "l", user_id: "u1", name: "Comment on Instagram posts", category: "learned", content: "---\nname: Comment on Instagram posts\ntriggers: [instagram comment]\n---\n\nold way" });
  learning._reset();
  llm.answers.push({ ...goodSkill, decision: "update", skill: "Comment on Instagram posts", name: "Renamed by the writer" }, { risk_level: "safe", findings: [], summary: "ok" });
  assert.deepEqual(await learning.consider({ userId: "u1", request: "instagram comment please", steps: struggled(), reply: "", recent: [], from: "web" }), { updated: "Comment on Instagram posts" });
  const updated = db.rows.find((r) => r.id === "l");
  assert.match(updated.content, /^---\nname: Comment on Instagram posts\n/, "the name stays");
  assert.match(updated.content, /## Mistakes to avoid/);
  assert.equal(sent.length, 0, "an update is not announced");
});

test("a learned skill unused for two months is removed; others stay", async () => {
  freshSkills();
  const old = new Date(Date.now() - 61 * 86400000).toISOString(), recent = new Date().toISOString();
  db.rows.push(
    { id: 1, name: "stale", category: "learned", last_used_at: old, installed_at: old },
    { id: 2, name: "never used", category: "learned", last_used_at: null, installed_at: old },
    { id: 3, name: "in use", category: "learned", last_used_at: recent, installed_at: old },
    { id: 4, name: "person's own", category: "community", last_used_at: null, installed_at: old },
  );
  await learning.removeUnused();
  assert.deepEqual(db.rows.map((r) => r.name), ["in use", "person's own"]);
});

test("it runs after chat replies and background tasks, and the dashboard shows it", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /turnSteps\.push\(\.\.\.require\("\.\/skill-learning"\)\.stepsFrom\(response\.content, toolResults\)\);\n\s*messages\.push\(\{ role: "user", content: toolResults \}\);/);
  assert.match(engine, /require\("\.\/skill-learning"\)\.considerTurn\(\{ userId, store, platform: deliverPlatform, chatId, request: userMessage, steps: turnSteps/);
  const agents = read("lib/agents.js");
  assert.match(agents, /require\("\.\/skill-learning"\)\.considerTask\(/);
  assert.match(agents, /getSkillsForPrompt\(userStore, goal\) \+ require\("\.\/user-skills"\)\.getUserSkillsBlock\(userStore\?\.userId, goal\)/);
  assert.match(read("index.js"), /require\("\.\/lib\/skill-learning"\)\.startUpkeep\(\);/);
  assert.match(read("migrations/065_learned_skills.sql"), /ADD COLUMN IF NOT EXISTS uses integer NOT NULL DEFAULT 0;[\s\S]*last_used_at timestamptz;[\s\S]*learned_from text;/);
  assert.match(read("webapp/server.js"), /\.select\("id, name, description, source_url, category, installed_at, uses, last_used_at, updated_at, learned_from, content"\)/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /learnedHeading\.hidden = learnedList\.length === 0;/, "learned skills have their own group, shown only when there are some");
  assert.match(dash, /var used = skill\.uses \? \(skill\.uses === 1 \? 'Once' : skill\.uses \+ ' times'\)/, "how often it is used, inside the opened card");
  assert.match(dash, /function learnedSkillRows\(skill\)/);
  assert.match(dash, /learnedHeading\.append\(window\.infoHint\(LEARNED_HINT, 'About learned skills'\)\)/, "what learned skills are sits behind an i on their label, not as text under Skills");
  assert.match(dash, /Instructions Closedhand follows for a particular kind of task\.<\/p>/);
  assert.match(dash, /list\.innerHTML = all\.map\(skillCard\)\.join\(''\) \+ ADD_SKILL_CARD;/, "Add a skill closes the person's skills and takes them to the box that adds one");
  assert.match(dash, /function focusConnectBox\(\) \{\n\s*var input = document\.getElementById\('mcp-url-input'\);/);
  // One dashed tile for every list the person can add to: Skills, and Connected too.
  assert.match(dash, /var ADD_SKILL_CARD = addCard\('Add a skill', 'focusConnectBox\(\)'\);/);
  assert.match(dash, /last\.insertAdjacentHTML\('beforeend', addCard\('Add a connection', 'goToAddConnection\(\)'\)\);/);
  assert.equal((dash.match(/class="int-card add-card"/g) || []).length, 1, "built in one place");
  assert.match(read("webapp/public/llm-hint.js"), /window\.infoHint = function \(text, label\) \{[\s\S]*?tip\.textContent = text;\n\s*return attach\(mark, tip\);/, "the i reuses the hint that opens on hover, focus or tap");
  assert.equal(read("lib/skill-scan-prompt.js"), read("webapp/skill-scan-prompt.js"));
  assert.match(read("webapp/security-scan.js"), /require\("\.\/skill-scan-prompt"\)\.skillScanPrompt\(content\)/);
});
