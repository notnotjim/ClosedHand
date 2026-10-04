// Every page ClosedHand serves wears the same icon in its browser tab: the
// ClosedHand fist, drawn from fist.png's own pixels so the logo stays exact.
// It is cream on dark tab bars and near-black on light ones; Safari ignores
// that choice, so its colour is a mid-tone that reads on both. Pages that
// name no icon (a PDF in a tab) get favicon.ico in that same mid-tone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

test("every page links the one icon, and no other", () => {
  const views = fs.readdirSync(path.join(root, "webapp/views")).filter((f) => f.endsWith(".html")).map((f) => `webapp/views/${f}`);
  for (const file of [...views, "webapp/server.js", "webapp/report-page.js"]) {
    const src = read(file);
    const heads = (src.match(/<head[\s>]/g) || []).length;
    assert.equal(src.split(ICON).length - 1, heads, `${file}: every head carries the icon`);
    const icons = src.match(/<link rel="(?:shortcut |alternate )?icon"[^>]*>/g) || [];
    assert.ok(icons.every((l) => l === ICON), `${file}: ${icons.filter((l) => l !== ICON).join(", ")}`);
  }
});

test("the icon is fist.png's own outline, coloured for the tab it sits in", () => {
  const svg = read("webapp/public/favicon.svg");
  const embedded = svg.match(/href="data:image\/png;base64,([^"]+)"/)[1];
  assert.ok(Buffer.from(embedded, "base64").equals(fs.readFileSync(path.join(root, "webapp/public/fist.png"))), "the logo exactly, not a redrawing");
  assert.match(svg, /mask-type:alpha/, "the shape comes from the outline, not its colour");
  assert.match(svg, /\.f\{fill:#868178\}@media \(prefers-color-scheme: dark\)\{\.f\{fill:#EFE6D6\}\}@media \(prefers-color-scheme: light\)\{\.f\{fill:#100E0D\}\}/);
});

test("pages that name no icon still get the fist", () => {
  const ico = fs.readFileSync(path.join(root, "webapp/public/favicon.ico"));
  assert.equal(ico.readUInt16LE(2), 1, "a real icon file");
  assert.equal(ico.readUInt16LE(4), 3, "16, 32 and 48 pixel sizes");
  assert.match(read("webapp/server.js"), /app\.use\(express\.static\(path\.join\(__dirname, "public"\)/, "served from public, before the login gate");
});
