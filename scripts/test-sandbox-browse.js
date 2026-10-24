// Closedhand browses the sandbox computer's Chrome through one lasting
// connection (sandbox-image/agent: POST /browse, browser_helper.py serve)
// instead of a new Python process and a fresh connection for every step, and
// reads a page as a numbered outline it acts on by number instead of guessing
// CSS selectors. Measured on the sandbox image: a step went from 0.85 to 2
// seconds to tens of milliseconds. Running code there has no daily cap.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const server = read("sandbox-image/agent/server.js");
const helper = read("sandbox-image/agent/browser_helper.py");

// The agent's queue, run against a stand-in Python process.
function agentQueue(answer) {
  const start = server.indexOf("let browseChild = null");
  const end = server.indexOf("// Started when a step first wants it", start);
  const spawned = [];
  const box = {
    console: { error() {} }, setTimeout, clearTimeout, JSON, Map, Promise, Error, Math, Date,
    PYTHON: "python3", SANDBOX_PROFILE: "", WORKSPACE: "/workspace", execEnv: () => ({}), truncate: (s) => s,
    spawn: (cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.exitCode = null; child.killed = false;
      child.kill = () => { child.killed = true; child.emit("exit"); };
      child.stdin = { write: (line) => { const req = JSON.parse(line); answer(req, (result) => child.stdout.emit("data", Buffer.from(JSON.stringify({ id: req.id, result }) + "\n"))); } };
      spawned.push({ cmd, args, child });
      return child;
    },
  };
  vm.runInNewContext(server.slice(start, end) + "\nthis.browseRequest = browseRequest;", box);
  return { browseRequest: box.browseRequest, spawned };
}

test("steps share one lasting process, run one at a time, and answers find their request", async () => {
  const order = [];
  const { browseRequest, spawned } = agentQueue((req, reply) => { order.push(req.step.action); setTimeout(() => reply({ did: req.step.action }), req.step.action === "outline" ? 30 : 1); });
  const [a, b] = await Promise.all([
    browseRequest({ op: "step", step: { action: "outline" } }, 1000),
    browseRequest({ op: "step", step: { action: "click", ref: 3 } }, 1000),
  ]);
  assert.deepEqual([a.did, b.did], ["outline", "click"]);
  assert.deepEqual(order, ["outline", "click"], "the second waits for the first");
  assert.equal(spawned.length, 1, "one process for both");
  assert.deepEqual([...spawned[0].args], ["-u", "-m", "browser_helper", "serve"]);
});

test("a step that hangs is stopped, and the next starts a fresh process", async () => {
  let hang = true;
  const { browseRequest, spawned } = agentQueue((req, reply) => { if (!hang) reply({ ok: true }); });
  await assert.rejects(browseRequest({ op: "step", step: { action: "click" } }, 50), /still running after 0 seconds and was stopped/);
  hang = false;
  assert.deepEqual(await browseRequest({ op: "step", step: { action: "outline" } }, 500), { ok: true });
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].child.killed, true);
});

test("the agent guards the endpoint and knows when Closedhand is browsing", () => {
  assert.match(server, /app\.use\("\/browse", auth\);/);
  assert.match(server, /function botBrowsing\(\) \{\n\s*return browseBusy > 0 \|\| Date\.now\(\) - lastBrowseAt < 20000;/);
  assert.match(server, /try \{ browseChild && browseChild\.kill\(\); \} catch \{\}/, "the helper goes when the agent goes");
});

test("the helper keeps its connection while serving and reads pages as a numbered outline", () => {
  assert.match(helper, /def _release\(pw, browser\):\n    """A one-off call disconnects; the serving process keeps the connection\."""\n    if _PERSIST:\n        return/);
  assert.equal((helper.match(/finally:\n        _release\(pw, browser\)/g) || []).length, 6, "every call keeps or drops the connection the same way");
  assert.match(helper, /el\.setAttribute\('data-ch-ref', String\(n\)\);/);
  assert.match(helper, /if \(k === 'password'\) \{ if \(el\.value\) line \+= ' \(filled\)'; \}/, "a password is never read back");
  assert.match(helper, /selector = '\[data-ch-ref="%d"\]' % int\(step\["ref"\]\)/, "a number names its element, and only a number");
  assert.match(helper, /page\.fill\(selector, ""\)\n[\s\S]{0,200}page\.type\(selector/, "a box is cleared before typing");
  assert.match(helper, /"hint": "Do not guess again\. Act on a \[number\] from this outline with ref\.",\n\s*"outline": _outline\(page\)/);
  assert.match(helper, /if __name__ == "__main__":\n    import sys\n    if sys\.argv\[1:\] == \["serve"\]:\n        serve\(\)/);
});

test("the bot sends every step but a card fill through the lasting connection, and the LLM is told to use numbers", () => {
  const handlers = read("lib/tools/handlers.js");
  const browse = handlers.slice(handlers.indexOf('case "sandbox_browse": {'), handlers.indexOf("// --- Background Agents ---"));
  assert.match(browse, /let answer = await sandboxBrowse\(userId, \{ \.\.\.body, engine \}, 60000\);/);
  assert.equal((browse.match(/sandboxExec\(/g) || []).length, 1, "only the card and address fills run as a one-off script");
  assert.match(browse, /code = wallet\.fillScript\(secret, [^\n]+\);[\s\S]*?code = wallet\.addressScript\(address, [^\n]+\);[\s\S]*?await sandboxExec\(userId, "python", code, 60000\);/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /enum: \["outline", "read_pages", "batch", "screenshot", "scrape_text", "extract_data", "click", "fill", "press", "wait_for", "eval_js", "fill_card", "fill_address"\]/);
  assert.match(defs, /ref: \{\n\s*type: "number",\n\s*description: "For click, fill, press and wait_for: the \[number\] of the element in the latest outline\./);
  assert.match(read("lib/sandbox.js"), /async function sandboxBrowse\(userId, body, timeoutMs = 60000\) \{/);
});

test("running code on the sandbox computer has no daily cap: it is part of the person's own computer", () => {
  const sandbox = read("lib/sandbox.js");
  assert.doesNotMatch(sandbox, /Daily execution limit|daily_exec/);
  assert.match(sandbox, /total_exec_count: \(sandbox\?\.total_exec_count \|\| 0\) \+ 1,\n\s*last_used_at: new Date\(\)\.toISOString\(\),/);
});
