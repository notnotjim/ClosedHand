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
