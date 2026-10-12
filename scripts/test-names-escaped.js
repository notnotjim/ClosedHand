// File, folder and document names come from files anyone can make (a page
// the sandbox downloaded, an email attachment, a file on the Mac), so the
// dashboard never puts one into its HTML as is. In a click handler a name
// goes through jsq(), as text through escapeHtml(). Before, names were
// escaped only for ', so a name holding " or \ or a tag ran script in the
// dashboard with the person's session.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const HOSTILE = [
  'a"onmouseover="alert(1)',
  "x'); alert(1); ('",
  "back\\slash'",
  "trailing\\",
  "<img src=x onerror=alert(1)>",
  "line\nbreak",
  "&quot;literal&#39;",
  "para\u2028sep",
];
const decode = (attr) => attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function helpers(file, start) {
  const src = read(file);
  const box = {};
  const jsq = src.slice(src.indexOf(start)).match(/function jsq\(s\) \{[\s\S]*?\n\s*\}/)[0];
  vm.runInNewContext(jsq + "\nthis.jsq = jsq;", box);
  return { src, jsq: box.jsq };
}

for (const file of ["webapp/views/index.html", "webapp/views/dashboard.html"]) {
  test(`${file}: a name in a click handler arrives as itself and can't end the handler`, () => {
    const { jsq } = helpers(file, "");
    for (const name of HOSTILE) {
      const attr = "open('" + jsq(name) + "')";
      assert.doesNotMatch(attr, /["<>]/, "nothing that ends the attribute or starts a tag: " + JSON.stringify(name));
      let got;
      vm.runInNewContext(decode(attr), { open: (v) => { got = v; } });
      assert.equal(got, name, "the handler gets exactly the name");
    }
  });
}

test("text names are escaped, and no page escapes a name for ' alone", () => {
  const page = read("webapp/views/index.html");
  const box = {};
  vm.runInNewContext(page.slice(page.indexOf("function escapeHtml(s) {\n  if (typeof s"), page.indexOf("\n}", page.indexOf("function escapeHtml(s) {\n  if (typeof s")) + 2) + "\nthis.escapeHtml = escapeHtml;", box);
  for (const name of HOSTILE) assert.doesNotMatch(box.escapeHtml(name), /[<>"']/);
  for (const file of ["webapp/views/index.html", "webapp/views/dashboard.html"]) {
    const src = read(file);
    const loose = (src.match(/\.replace\(\/'\/g,\s*"\\\\'"\)/g) || []).length;
    assert.equal(loose, 1, `${file}: only jsq() itself escapes ' for a script`);
  }
  assert.match(page, /'<span class="mon-row-name">'\+escapeHtml\(f\.name\)/);
  assert.match(page, /else html \+= '<span>' \+ escapeHtml\(parts\[i\]\) \+ '<\/span>';\n    \}\n    el\.innerHTML = html;/, "the Mac breadcrumb's last folder too");
  assert.match(page, /title="'\+escapeHtml\(f\.name\)\+'">'\+escapeHtml\(f\.name\)/);
  assert.match(page, /escapeHtml\(String\(msg\.filename \|\| ''\)\)/);
  assert.match(page, /Uploading '\+escapeHtml\(String\(name\)\)\+'\.\.\./);
  assert.match(page, /ragRetrieveDoc\(\\'' \+ jsq\(r\.document_id\) \+ '\\',\\'' \+ jsq\(r\.document_name \|\| 'file'\) \+ '\\'\)/);
});

test("a name in a Mac or sandbox shell command is only ever that name", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const server = read("webapp/server.js");
  const box = { Buffer };
  vm.runInNewContext(server.slice(server.indexOf("const shq = "), server.indexOf("\n", server.indexOf("const shDecoded = ")) + 1) + "\nthis.shq = shq; this.shDecoded = shDecoded;", box);
  const marker = path.join(os.tmpdir(), `ch-name-test-${process.pid}`);
  const names = [`a'; touch ${marker}; echo '`, `$(touch ${marker})`, "`touch " + marker + "`", 'say "hi" & $HOME', "ends with \\", "ünïcode 名前"];
  for (const name of names) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${box.shq(name)}`]).toString(), name);
    // As the Mac runs it: a command inside bash -c '...', itself run by a shell.
    assert.equal(execFileSync("/bin/sh", ["-c", `bash -c 'printf %s ${box.shDecoded(name)}'`]).toString(), name);
  }
  assert.equal(fs.existsSync(marker), false, "no name ran a command");
  assert.match(server, /--form-string path=\$\{shDecoded\(destPath\)\}/);
  assert.doesNotMatch(server, /-F "path=\$\{destPath\}"/);
  assert.doesNotMatch(server, /language: "bash", code: `[^`]*"\$\{(destPath|parentDir)\}"/, "sandbox commands quote names with shq()");
});
