// Light or dark for every page the app serves: colours by name, the person's
// pick (Settings, Appearance) put on each page as it is served, and theme.js
// setting the theme before anything is drawn. Invented values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// The app's pages. Telegram's and LINE's mini apps follow their own app's
// theme (Telegram's and LINE's colours), so they are not among them.
const PAGES = ["dashboard", "index", "setup", "login", "setup-code", "keep", "privacy", "terms"].map((p) => `webapp/views/${p}.html`);

test("the app names its colours: no page, style or script holds a palette value", () => {
  const css = fs.readdirSync(path.join(root, "webapp/public")).filter((f) => f.endsWith(".css")).map((f) => `webapp/public/${f}`);
  // theme.js keeps the browser bar's two colours, which take values.
  const js = fs.readdirSync(path.join(root, "webapp/public")).filter((f) => f.endsWith(".js") && f !== "theme.js").map((f) => `webapp/public/${f}`);
  const iface = read("webapp/public/interface.css");
  const darkHex = [...iface.slice(0, iface.indexOf(':root[data-theme="light"]')).matchAll(/--[\w-]+:\s*#([0-9A-Fa-f]{6});/g)].map((m) => m[1]);
  assert.ok(darkHex.length >= 30, "the names are defined");
  const triples = darkHex.map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join("\\s*,\\s*"));
  const palette = new RegExp(`(?<![&\\w%])#(?:${darkHex.join("|")})\\b|rgba?\\(\\s*(?:${triples.join("|")})\\s*[,)]`, "i");
  for (const file of [...PAGES, ...css, ...js]) {
    let text = read(file).replace(/<meta name="theme-color"[^>]*>/g, "");
    // Only the names' own definitions hold values.
    if (file === "webapp/public/interface.css") text = text.replace(/:root(?:\[data-theme="light"\])? \{[^}]*--fg:[^}]*\}/g, "");
    const hit = text.match(palette);
    assert.equal(hit, null, `${file} uses a colour's value (${hit && hit[0]}), not its name`);
  }
  assert.match(iface, /:root\[data-theme="light"\] \{\n  color-scheme: light;\n  --fg: #1A1817; --fg-rgb: 26,24,23;/, "with a light value for each");
});

test("every page sets its theme before anything is drawn", () => {
  for (const page of PAGES) {
    assert.match(read(page), /<meta name="viewport"[^>]*>\s*<script src="\/theme\.js"><\/script>/, `${page} loads theme.js first`);
  }
  const theme = read("webapp/public/theme.js");
  assert.match(theme, /return p === 'device' \? \(device\.matches \? 'light' : 'dark'\) : p;/, "Match this device follows the device");
  assert.match(theme, /device\.addEventListener\('change', function \(\) \{ if \(pick\(\) === 'device'\) apply\(current\(\)\); \}\);/, "and its changes");
  assert.match(theme, /document\.startViewTransition/, "switching plays the transition");
  assert.match(read("webapp/public/interface.css"), /\.theme-ring \{[^}]*view-transition-name: theme-ring;/, "with closedhand.com's ember ring");
});

test("the pick is put on every page as it is served, and only a real pick", () => {
  const assets = require("../webapp/assets");
  const html = '<!DOCTYPE html>\n<html lang="en"><head></head></html>';
  assets.setAppearance("light");
  assert.match(assets.withAppearance(html), /<html data-theme-pick="light" lang="en">/);
  assets.setAppearance("dark");
  assert.match(assets.withAppearance(html), /<html data-theme-pick="dark" lang="en">/);
  for (const other of ["device", undefined, "sepia", '"><script>']) {
    assets.setAppearance(other);
    assert.equal(assets.withAppearance(html), html, `${other} leaves it to the device`);
  }
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/settings\/appearance"[\s\S]{0,400}\["device", "light", "dark"\]\.includes\(pick\)[\s\S]{0,300}patchSettings\(supabase, userId, \{ set: \{ appearance: pick \} \}\);\n    assets\.setAppearance\(pick\);/, "saved in the person's settings");
  assert.match(server, /assets\.setAppearance\(data\?\.settings\?\.appearance\);/, "and read back when the app starts");
  assert.match(server, /res\.type\("html"\)\.send\(assets\.withAppearance\(assets\.forHost\(html\)\)\);/, "Privacy and Terms carry it");
  assert.match(server, /res\.send\(assets\.withAppearance\(require\("\.\/report-page"\)\.pageHtml\(report\)\)\);/, "Pages carry it");
  assert.match(read("webapp/report-page.js"), /:root\[data-theme-pick="dark"\] \{/, "and follow it");
});

test("Settings has Appearance: Match this device, Light and Dark", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<h2>Appearance<\/h2>\s*<p class="section-desc">Light or dark, on every page and every device you open Closedhand on\.<\/p>/);
  assert.match(dash, /data-pick="device">Match this device<\/button>\s*<button class="seg-btn" type="button" role="radio" data-pick="light">Light<\/button>\s*<button class="seg-btn" type="button" role="radio" data-pick="dark">Dark<\/button>/);
  assert.match(dash, /window\.parent\.closedhandTheme\.setPick\(pick, at && \{ x: frame\.left \+ at\.x, y: frame\.top \+ at\.y \}\);/, "the web chat behind the dashboard switches with it");
  assert.match(dash, /fetch\("\/api\/settings\/appearance"/);
});
