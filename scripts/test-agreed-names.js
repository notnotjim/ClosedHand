// The names agreed in AGENTS.md "User-Facing Copy", held where people read
// them. Each old name here once shipped in a view, an error or a chat reply,
// usually because one screen kept it after the rest moved on. Comments are
// stripped first: code and contributor notes may still use the old words.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const noHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
const noCodeComments = (s) => s.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|[^:\\'"`])\/\/[^\n]*/g, "$1");
// A page as shipped, less its comments and styles.
const markup = (f) => noHtmlComments(read(f)).replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/g, (m, open, code, close) => open + noCodeComments(code) + close);
const scripts = (f) => [...markup(f).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
// What a person reads in a page.
const visible = (html) => noHtmlComments(html).replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const visibleText = (f) => visible(read(f));
// Sentences and labels in a script, not ids, keys or log lines.
const strings = (src) => (noCodeComments(src).match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [])
  .map((s) => s.slice(1, -1)).filter((s) => / /.test(s) && !/^\s*\[/.test(s));
// Everything a person can read in a file: a page's text and its scripts'
// sentences, a script's sentences, or a document as written.
const readable = (f) => f.endsWith(".html") ? visibleText(f) + "\n" + strings(scripts(f)).join("\n")
  : f.endsWith(".js") ? strings(read(f)).join("\n") : read(f);

test("the dashboard says Chat apps, and pins facts as Pinned facts", () => {
  const dashboard = markup("webapp/views/dashboard.html");
  assert.doesNotMatch(dashboard, /Chat Platforms/, "the first heading on the first tab");
  assert.doesNotMatch(dashboard, /\+ Add Note|Pinned Note|pinned note/i, "a pinned fact is not a note");
  assert.match(dashboard, />\+ Pin a fact</);
  assert.doesNotMatch(dashboard, /Search memory|building your memory/);
  assert.doesNotMatch(dashboard, /['>](Edit|New) Note['<]|'Note (saved|deleted)'/, "Context Notes are never bare notes");
  for (const f of ["README.md", "closedhand-com/views/privacy.html", "webapp/views/privacy.html", "lib/onboarding.js"]) {
    assert.doesNotMatch(noHtmlComments(read(f)), /chat platforms?|messaging apps/i, f);
  }
});

test("the web chat is where people talk; the dashboard is the control panel", () => {
  const setup = readable("webapp/views/setup.html");
  assert.doesNotMatch(setup, /chat on your dashboard/i);
  assert.doesNotMatch(setup, /open the dashboard and ask/i);
  assert.doesNotMatch(setup, /Your chat app is where you talk to it/, "a chat app may not be linked");
  assert.doesNotMatch(markup("webapp/views/index.html"), /Open this dashboard on your Mac/);
  assert.doesNotMatch(markup("webapp/views/dashboard.html"), /Keep your dashboard handy|Closedhand gives your dashboard an address/);
});

test("the sandbox computer is never Workspace, cloud or online", () => {
  const index = markup("webapp/views/index.html");
  const panel = index.slice(index.indexOf('id="monCloud"'), index.indexOf('id="monFileControlsRow"'));
  assert.match(panel, /<\/svg>\s*Sandbox computer\s*<span class="mon-info"/, "the Computers panel title");
  assert.doesNotMatch(panel, /<span>Closedhand's sandbox computer<\/span>/, "named once, not twice");
  assert.doesNotMatch(index, /(?<![\w\/.-])[Ww]orkspace(?![\w\/-])/, "no Workspace in anything the web chat shows");
  assert.doesNotMatch(index, /cloud: 'Cloud'|cloud \$|Your online workspace/);
  assert.doesNotMatch(read("desktop/Sources/Closedhand/MenuView.swift"), /row\("Workspace"/);
  assert.doesNotMatch(readable("desktop/workspace/host.js"), /Preparing Workspace|Starting Workspace|Workspace (?:could not|took|stopped|disconnected|is closing|starts|did not)/, "the Mac app's startup messages");
  for (const f of ["closedhand-com/views/terms.html", "webapp/views/terms.html", "webapp/views/privacy.html", "closedhand-com/views/architecture.html"]) {
    assert.doesNotMatch(visibleText(f), /\b[Ww]orkspace\b/, f);
  }
});

test("a personal URL is claimed, never confirmed, and has one name", () => {
  const claimConfirm = /confirm(?:ed|ing|ation)?\b[^.<'"`]{0,80}(?:closedhand\.com|personal URL)|(?:closedhand\.com|personal URL)[^.<'"`]{0,40}\bconfirm/i;
  const files = ["webapp/views/setup.html", "webapp/views/dashboard.html", "webapp/views/keep.html", "webapp/public/keep.js",
    "webapp/public/setup-personal-url.js", "closedhand-com/views/pair.html", "closedhand-com/public/pair.js", "closedhand-com/lib/addresses.js", "README.md"];
  for (const f of files) {
    const text = readable(f);
    assert.doesNotMatch(text, claimConfirm, f);
    assert.doesNotMatch(text, /Get (?:your|a) personal URL|confirmation link|Get a new confirmation/i, f);
  }
  assert.doesNotMatch(visibleText("closedhand-com/views/pair.html"), /\bConfirm(?:ed)?\b/, "the claim page's button and progress");
  assert.doesNotMatch(strings(read("closedhand-com/public/pair.js")).join("\n"), /Confirm|confirmed/);
  const stale = /(?:turn on|Enable) Your phone|phone access|phone address|dashboard address|Dashboard access|permanent link|dashboard-link service|\blink service/;
  for (const f of ["lib/dashboard-links.js", "lib/telegram-in-app.js", "lib/dashboard-overview.js", "webapp/phone-access.js", "webapp/phone-registration.js", "webapp/public/keep.js"]) {
    assert.deepEqual(strings(read(f)).filter((s) => stale.test(s)), [], f);
  }
  for (const f of ["webapp/views/dashboard.html", "webapp/views/keep.html", "webapp/views/privacy.html", "webapp/views/terms.html", "closedhand-com/views/privacy.html", "closedhand-com/views/terms.html", "closedhand-com/views/home.html", "README.md"]) {
    assert.doesNotMatch(readable(f), stale, f);
  }
});

test("closedhand.com names Closedhand as your Closedhand assistant first, and never as an installation", () => {
  assert.match(visibleText("closedhand-com/views/assistant-email-confirm.html"), /Confirm your Closedhand assistant’s email address/);
  for (const f of ["closedhand-com/views/assistant-email-confirm.html", "closedhand-com/views/privacy.html"]) {
    assert.doesNotMatch(visibleText(f), /\byour assistant\b/i, f);
  }
  assert.doesNotMatch(strings(read("closedhand-com/public/assistant-email-confirm.js")).join("\n"), /your assistant/i);
  assert.deepEqual(strings(read("closedhand-com/lib/assistant-mail-relay.js")).filter((s) => /\binstall(?:ation)?s?\b/i.test(s)), [], "the email card's errors");
  assert.doesNotMatch(read("README.md"), /\bOne install\b|scripted installs/);
});

test("closedhand.com explains when Closedhand is there in one place, as a choice of home", () => {
  const views = fs.readdirSync(path.join(__dirname, "..", "closedhand-com", "views")).filter((f) => f.endsWith(".html"));
  const allowed = new Set(["terms.html", "privacy.html"]);
  for (const view of views.filter((v) => !allowed.has(v))) {
    let html = noHtmlComments(read("closedhand-com/views/" + view));
    if (view === "home.html") {
      const start = html.indexOf('<section class="lives'), end = html.indexOf("</section>", start);
      const lives = html.slice(start, end);
      assert.ok(start > 0 && /Where Closedhand lives/.test(lives), "the one section that owns it");
      assert.match(lives, /can’t be moved to another one/, "no move between homes is implied");
      assert.match(lives, /Schedules due while it sleeps are skipped/, "a laptop does not catch up on schedules");
      html = html.slice(0, start) + html.slice(end);
    }
    assert.doesNotMatch(visible(html), /\bawake\b|keep (?:that|the|your) computer|on and online/i, view);
  }
  for (const f of fs.readdirSync(path.join(__dirname, "..", "closedhand-com", "public")).filter((f) => f.endsWith(".js"))) {
    assert.doesNotMatch(strings(read("closedhand-com/public/" + f)).join("\n"), /\bawake\b|on your computer while/i, f);
  }
  const readme = read("README.md");
  assert.doesNotMatch(readme, /full product|sets the tier|catches up/i);
  assert.match(readme, /a schedule due while it slept is skipped/);
  assert.match(readme, /no supported way to move Closedhand's data to another computer/);
  assert.doesNotMatch(visibleText("webapp/views/setup.html"), /while this computer is on/);
});
