// The Closedhand fist lives in one place: every file it appears in matches
// one complete set in brand/marks, the one brand/ACTIVE names, and the
// installer's art lines match that set too. Switching marks is
// `python3 scripts/brand.py use <name>`, never an edit to one copy.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f));
const script = read("scripts/brand.py").toString();
const files = [...script.slice(script.indexOf("FILES = ["), script.indexOf("]", script.indexOf("FILES = ["))).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const active = fs.existsSync(path.join(root, "brand/ACTIVE")) ? read("brand/ACTIVE").toString().trim() : "original";
const marks = fs.readdirSync(path.join(root, "brand/marks"));
const art = (text) => (text.match(/^HAND_FIST_(?:32|64)='[^']*'$/gm) || []).join("\n");

test("every mark is a complete set", () => {
  assert.ok(files.length >= 16, "the file list was read");
  assert.ok(marks.includes("original") && marks.includes(active), `marks: ${marks.join(", ")}`);
  for (const mark of marks) {
    for (const f of files) assert.ok(fs.existsSync(path.join(root, "brand/marks", mark, f)), `${mark} has ${f}`);
    assert.equal(art(read(`brand/marks/${mark}/install-art.txt`).toString()).split("\n").length, 2, `${mark} has both installer sizes`);
  }
});

test("the files in place are the active mark, exactly", () => {
  for (const f of files) assert.ok(read(f).equals(read(`brand/marks/${active}/${f}`)), `${f} is the ${active} mark's`);
  assert.equal(art(read("install.sh").toString()), art(read(`brand/marks/${active}/install-art.txt`).toString()), "the installer draws the active mark");
});

test("the brand folder stays out of the bot image", () => {
  assert.match(read(".dockerignore").toString(), /^brand$/m);
});

// The icons beside the fist are drawn with its brush (brand.py build-icons)
// and carried inline; a page's copy is the drawn one, and no page uses an
// emoji where an icon goes.
test("pages carry the brush icons as drawn, and no emoji", () => {
  const pages = ["closedhand-com/views", "webapp/views"].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".html")).map((f) => `${d}/${f}`));
  let used = 0;
  for (const page of pages) {
    const html = read(page).toString();
    for (const m of html.matchAll(/<svg data-icon="([a-z]+)" ([^]*?<\/svg>)/g)) {
      used++;
      assert.equal(`<svg ${m[2]}`, read(`brand/icons/${m[1]}.svg`).toString().trim(), `${page}: the ${m[1]} icon is brand/icons/${m[1]}.svg`);
    }
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${page} has no emoji`);
  }
  assert.ok(used >= 9, "the icons were found");
});

// The header's link to your own Closedhand is underlined with the same brush
// on closedhand.com and in the web chat: one drawing, copied to both. In the
// app every main action is drawn by the same rule as that link, words over
// the brush with no box, and on both sides hover paints a fresh coat over the
// stroke instead of making it vanish and redraw.
test("the brush underline is the drawn one on both sides, under closedhand.com's header link and the app's main actions", () => {
  const drawn = read("brand/icons/underline.svg");
  for (const copy of ["closedhand-com/public/brush-underline.svg", "webapp/public/brush-underline.svg"]) assert.ok(read(copy).equals(drawn), `${copy} is brand/icons/underline.svg`);
  const site = read("closedhand-com/public/interface.css").toString();
  assert.match(site, /a\.nav-cta::after \{[^}]*mask: url\(\/brush-underline\.svg\)/, "closedhand.com draws the underline");
  const app = read("webapp/public/interface.css").toString();
  const ink = app.match(/^:is\(([^)]*)\) \{\n  position: relative;/m);
  assert.ok(ink, "the app has one ink rule");
  for (const member of [".cta", ".save-btn", ".go", ".project-form button[type=submit]"]) assert.ok(ink[1].split(", ").includes(member), member);
  assert.match(app, /::after \{ content: ""; position: absolute; left: -5px; right: -6px; bottom: 1px; height: 9px; -webkit-mask: url\(\/brush-underline\.svg\)/, "the app draws the underline");
  for (const [name, text] of [["closedhand.com", site], ["the app", app]]) {
    assert.doesNotMatch(text, /a\.nav-cta \{[^}]*border-radius: (?:62|99)/, `${name} has no pill`);
    assert.doesNotMatch(text, /brush-draw/, `${name} never makes the stroke vanish and redraw`);
    assert.match(text, /clip-path: inset\(0 100% 0 0\); transition: clip-path \.45s cubic-bezier\(\.65, 0, \.35, 1\);/, `${name} paints a fresh coat on hover`);
  }
  assert.match(read("webapp/views/index.html").toString(), /id="dashboardLink" class="deep"/, "the web chat's Dashboard is a tinted button, as Open WhatsApp is");
  for (const page of ["login.html", "setup-code.html", "keep.html"]) assert.doesNotMatch(read(`webapp/views/${page}`).toString(), /background: ?var\(--accent\);[^}]*color: ?var\(--bg\)/, `${page} has no button of its own`);
  assert.doesNotMatch(read("webapp/public/keep.css").toString(), /\.primary\{/);
});
