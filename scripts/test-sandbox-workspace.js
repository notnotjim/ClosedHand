// The sandbox computer's files: Closedhand's own working files are cleared
// once nothing in them has changed for 30 days; what the person adds goes in
// Yours and stays, and nothing hidden (the browser's profile) is touched.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { clearOldWork } = require("../sandbox-image/agent/workspace-cleanup");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("old working files go; Yours, hidden folders and anything recently used stay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ch-workspace-"));
  const day = 86400000, now = Date.now();
  const put = (rel, ageDays) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x");
    const t = new Date(now - ageDays * day);
    fs.utimesSync(p, t, t);
    return p;
  };
  put("ferry-times.png", 40);
  put("harbour-report.pdf", 5);
  put("Yours/lease.pdf", 400);
  put(".chromium-profile/Default/Cookies", 90);
  put("charts/old.png", 50); put("charts/new.png", 2);
  put("scrape/page.html", 60); put("scrape/page.headers", 61);
  for (const dir of ["charts", "scrape", "Yours", ".chromium-profile", ".chromium-profile/Default"]) {
    const t = new Date(now - 100 * day); fs.utimesSync(path.join(root, dir), t, t);
  }
  const cleared = clearOldWork(root, now).sort();
  assert.deepEqual(cleared, ["ferry-times.png", "scrape"]);
  const left = fs.readdirSync(root).sort();
  assert.deepEqual(left, [".chromium-profile", "Yours", "charts", "harbour-report.pdf"]);
  assert.ok(fs.existsSync(path.join(root, "charts/old.png")), "a folder still in use is never cleared in part");
  assert.ok(fs.existsSync(path.join(root, "Yours/lease.pdf")));
  assert.ok(fs.existsSync(path.join(root, ".chromium-profile/Default/Cookies")), "the browser's sign-ins stay");
  fs.rmSync(root, { recursive: true });
});

test("the sandbox computer clears at start and once a day", () => {
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /require\("\.\/workspace-cleanup"\)\.clearOldWork\(WORKSPACE\)/);
  assert.match(agent, /clearOldWork\(\);\nsetInterval\(clearOldWork, 24 \* 60 \* 60 \* 1000\)\.unref\(\);/);
});

test("what the person uploads or copies in goes in Yours, and Files says what is there", () => {
  const server = read("webapp/server.js");
  const start = server.indexOf("function intoYours");
  const intoYours = new Function("path", server.slice(start, server.indexOf("\n}\n", start) + 2).replace("function intoYours", "const SANDBOX_YOURS = \"/workspace/Yours\"; return function") )(path);
  assert.equal(intoYours("/workspace/notes.txt"), "/workspace/Yours/notes.txt");
  assert.equal(intoYours("/workspace/charts/notes.txt"), "/workspace/Yours/notes.txt");
  assert.equal(intoYours("/workspace/Yours/trips/plan.pdf"), "/workspace/Yours/trips/plan.pdf");
  assert.equal(intoYours("notes.txt"), "/workspace/Yours/notes.txt");
  assert.match(server, /const filePath = intoYours\(req\.body\.path \|\| req\.file\.originalname \|\| "upload"\);/);
  assert.match(server, /const destPath = intoYours\(req\.body\.destPath\);/);
  const chat = read("webapp/views/index.html");
  assert.match(chat, /<p class="mon-files-note" id="monFilesNote">Closedhand's working files, cleared after 30 days unused\. What you upload goes in Yours and stays\.<\/p>/);
  assert.equal((chat.match(/_monCloudPath ?= ?'\/workspace\/Yours'/g) || []).length, 3, "after an upload, a copy or a drop, Files opens Yours");
});
