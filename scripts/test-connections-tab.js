// The Connections tab: what is live sits under Connected (built-in apps,
// pasted servers and the Mac alike), and Add a connection holds the built-in
// apps not yet connected as tiles, then "Connect anything" for any MCP server.
// The app list runs here against a small stand-in for the page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

class El {
  constructor(tag, id) { this.tag = tag; this.id = id || ""; this.children = []; this.hidden = false; this.className = ""; this.attrs = {}; this.listeners = {}; this._text = ""; this.classList = new Set(); this.classList.remove = this.classList.delete; }
  set textContent(t) { this._text = String(t); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  set innerHTML(h) { this._html = h; }
  append(...xs) { this.children.push(...xs); }
  replaceChildren() { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { (this.listeners.click || this.onclick || (() => {}))(); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  all(pred, out = []) { for (const c of this.children) if (c instanceof El) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
}

function page(services) {
  const ids = {};
  for (const id of ["catalogue-status", "catalogue-retry", "connection-catalogue-list", "catalogue-apps-heading", "catalogue-setup", "catalogue-browse", "mcp-section", "mcp-url-input"]) ids[id] = new El("div", id);
  const hero = new El("div");
  let ready;
  const document = {
    getElementById: (id) => ids[id],
    createElement: (tag) => new El(tag),
    querySelector: (sel) => sel === "#connection-catalogue .mcp-hero" ? hero
      : sel === "#connection-catalogue-list .catalogue-tile" ? ids["connection-catalogue-list"].all((e) => e.className === "catalogue-tile")[0] : null,
    addEventListener: (type, fn) => { if (type === "DOMContentLoaded") ready = fn; },
  };
  const window = {};
  const fetch = async () => ({ ok: true, json: async () => ({ services }) });
  vm.runInNewContext(read("webapp/public/connection-catalogue.js"), { window, document, fetch, setTimeout, navigator: {} });
  return { ids, hero, window, start: async () => { ready(); await new Promise((r) => setImmediate(r)); } };
}

const app = (key, name, extra = {}) => ({ key, name, description: name + " things", logoUrl: "", connected: false, mode: "setup", scopes: [], guide: "https://example.com", instruction: "Create an app.", redirectUri: "http://localhost:3000/auth/" + key + "/callback", ...extra });

test("only apps not yet connected are tiles, and the tab's search narrows them", async () => {
  const p = page([app("notion", "Notion", { mode: "mcp", url: "https://mcp.example.com", manualMode: "setup" }), app("github", "GitHub"), app("gitlab", "GitLab"), app("google", "Google", { connected: true })]);
  await p.start();
  const tiles = () => p.ids["connection-catalogue-list"].all((e) => e.className === "catalogue-tile").map((t) => t.textContent);
  assert.deepEqual(tiles(), ["GitHub", "GitLab", "Notion"], "Google is connected, so it lives under Connected instead");
  p.window.filterConnectionCatalogue("git");
  assert.deepEqual(tiles(), ["GitHub", "GitLab"]);
  p.window.filterConnectionCatalogue("");
  assert.equal(tiles().length, 3);
});

test("an app's setup stands alone, and Back brings the rest back", async () => {
  const p = page([app("meta_ads", "Meta Ads"), app("notion", "Notion", { mode: "mcp", url: "https://mcp.example.com", manualMode: "setup" })]);
  await p.start();
  const tile = (name) => p.ids["connection-catalogue-list"].all((e) => e.className === "catalogue-tile").find((t) => t.textContent === name);
  tile("Meta Ads").click();
  const setup = p.ids["catalogue-setup"];
  assert.equal(setup.hidden, false);
  assert.equal(p.hero.hidden, true, "the paste box is not one of the form's steps");
  assert.ok(p.ids["mcp-section"].classList.has("setting-up"), "nor is the Mac card");
  assert.ok(setup.all((e) => e.className === "catalogue-copybox").length, "the callback address sits in its own box");
  assert.ok(setup.all((e) => e.className === "catalogue-copy-btn").length, "with a copy icon, not a Copy button");
  assert.ok(setup.all((e) => e.className === "catalogue-deep").length, "the settings link is a button");
  setup.all((e) => e.className === "catalogue-return")[0].click();
  assert.equal(setup.hidden, true);
  assert.equal(p.hero.hidden, false);
  assert.ok(!p.ids["mcp-section"].classList.has("setting-up"));
  tile("Notion").click();
  const labels = setup.all((e) => e.tag === "button").map((b) => b.textContent);
  assert.ok(labels.includes("Connect Notion") && labels.includes("Use your own Notion app instead"), "two routes, offered as a choice");
});

test("the tab is laid out as Connected, then Add a connection", () => {
  const dashboard = read("webapp/views/dashboard.html");
  const connected = dashboard.slice(dashboard.indexOf('id="connected-section"'), dashboard.indexOf('id="mcp-section"'));
  assert.match(connected, /<h2>Connected<\/h2>/);
  assert.match(connected, /id="mcp-list"/, "pasted servers sit with everything else that is live");
  const add = dashboard.slice(dashboard.indexOf('id="mcp-section"'), dashboard.indexOf("<!-- Workers Tab Content -->"));
  for (const want of ["<h2>Add a connection</h2>", 'id="apple-local-section"', '<h3 class="add-sub" id="catalogue-apps-heading">Apps</h3>',
    '<h3 class="add-sub">Connect anything</h3>', '<p class="mcp-description">Paste an MCP server, a skill or an API key</p>', "Servers and skills are scanned for security risks</p>"]) {
    assert.ok(add.includes(want), want);
  }
  assert.doesNotMatch(dashboard, /Your MCPs|<summary>Connect more<\/summary>|id="catalogue-search"|Add a key when prompted|int-more-sub/);
  assert.match(dashboard, /Connect your Mac and choose what Closedhand has access to/);
  assert.match(dashboard, /if \(live\) document\.getElementById\('connected-section'\)\.appendChild\(macCard\);/, "the Mac moves to Connected once set up");
  assert.match(dashboard, /placeholder="A link, a command, JSON or an API key" aria-label="MCP server, skill or API key"/, "one box takes a server, a skill or a key");
  assert.match(dashboard, /<div class="section" id="skills-section">\n\s*<h2>Skills<\/h2>[\s\S]*?<div class="integrations-grid" id="skills-connected"><\/div>/, "every skill, built in or added, is listed on Connections");
  assert.match(dashboard, /var all = _builtinSkills\.map\(function \(skill\) \{ return \{ skill: skill, builtin: true \}; \}\)\n\s*\.concat\(_installedSkills\.map/, "built-in skills are listed, not only added ones");
  assert.match(dashboard, /\(item\.builtin \? '' : '<div class="conn-drawer-actions"><button onclick="event\.stopPropagation\(\);deleteSkill\(/, "only an added skill can be removed");
  assert.match(dashboard, /async function installSkill\(acceptWarnings, url\) \{[\s\S]*?var btn = document\.getElementById\('mcp-connect-btn'\);/, "a skill's scan shows under the box it was pasted into");
  assert.doesNotMatch(dashboard, /openSkillsLibrary|skills-library|skill-install-url|Install a skill in Agents/, "no second place to add a skill");
  assert.doesNotMatch(dashboard, /In chat, and by any agent you pick it for/, "no line that says the same on every skill");
  assert.match(dashboard, /\.filter\(function \(app\) \{ return String\(skill\.name \|\| ''\)\.toLowerCase\(\)\.indexOf\(app\.toLowerCase\(\)\) === -1; \}\);/, "no Works with line that repeats the skill's own name");
  assert.match(dashboard, /var any = !!section\.querySelector\('#connected-grid > \.int-wrap, #mcp-list > \.int-wrap, #apple-local-section:not\(\[style\*="display: none"\]\)'\);/, "Connected shows only when something is");
  assert.match(dashboard, /if \(window\.filterConnectionCatalogue\) window\.filterConnectionCatalogue\(query\);/, "one search for the whole tab");
});

test("a card in any list opens on a click and closes on the next", () => {
  const vm = require("node:vm");
  const dashboard = read("webapp/views/dashboard.html");
  const start = dashboard.indexOf("    function toggleMcpUnfurl(el) {");
  const code = dashboard.slice(start, dashboard.indexOf("\n    }\n", start) + 6);
  const classes = () => { const set = new Set(); return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) }; };
  const list = { cards: [] };
  const make = () => { const card = { classList: classes() }, unfurl = { classList: classes() }, wrap = { parentElement: list, querySelector: () => unfurl }; card.closest = () => wrap; list.cards.push({ card, unfurl }); return { card, unfurl }; };
  list.querySelectorAll = (sel) => list.cards.map((c) => (sel.includes("unfurl") ? c.unfurl : c.card)).filter((n) => n.classList.contains(sel.includes("unfurl") ? "open" : "expanded"));
  const a = make(), b = make();
  const toggle = vm.runInNewContext(code + "\ntoggleMcpUnfurl", {});
  toggle(a.card); assert.ok(a.unfurl.classList.contains("open"));
  toggle(b.card); assert.ok(b.unfurl.classList.contains("open") && !a.unfurl.classList.contains("open"), "one open at a time");
  toggle(b.card); assert.ok(!b.unfurl.classList.contains("open"), "a second click closes it");
});

test("everything you have is one card size: chat apps, connected and skills", () => {
  const css = read("webapp/public/interface.css");
  const dashboard = read("webapp/views/dashboard.html");
  assert.match(css, /\.dashboard-container :is\(\.platforms-grid, \.integrations-grid\) \{ gap: 12px; grid-auto-flow: row; grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 320px\), 1fr\)\);/, "the same columns for every group");
  assert.match(css, /\.dashboard-container :is\(\.plat-card, \.int-card\) \{ flex-direction: row; align-items: center; gap: 12px; min-height: 56px; padding: 12px 16px;/, "the same one-line card");
  assert.doesNotMatch(css, /platforms-grid \{ grid-template-columns: repeat\(5/, "chat apps no longer squeezed into five columns");
  assert.match(dashboard, /'<span class="int-name">' \+ escHtml\(skill\.name\) \+ '<\/span>' \+\n\s*\(missing\.length \? '<span class="int-tag" title="Connect it below to use this skill">Needs '[^\n]*\n\s*: item\.builtin \? '<span class="int-tag">Built in<\/span>' : '<span class="int-tag">Added<\/span>'\)/, "a skill is one line with a quiet tag, saying what it needs when its service is missing");
  assert.match(dashboard, /'<span class="int-name">' \+ escHtml\(m\.name\) \+ '<\/span>' \+\n\s*statusBadge/, "a pasted server is one line too");
});

test("a label inside Add a connection never reads as level with its heading", () => {
  const css = read("webapp/public/connection-catalogue.css");
  assert.match(css, /\.add-sub \{font-size:13px;font-weight:600;color:rgba\(239,230,214,0\.6\);text-transform:uppercase;letter-spacing:0\.8px;/, "small grey capitals, like the dashboard's other labels");
  assert.match(css, /#mcp-section > #apple-local-section \{margin-bottom:32px;\}/, "the Mac card sits as far from Apps as Apps from Connect anything");
});

test("Connect anything sits centred under the apps", () => {
  const css = read("webapp/public/connection-catalogue.css");
  assert.match(css, /\.connection-catalogue \.mcp-copy \{text-align:center;/);
  assert.match(css, /\.connection-catalogue \.mcp-pill \{max-width:640px!important;margin:0 auto!important;\}/);
  assert.match(css, /\.connection-catalogue \.mcp-scan \{display:flex;width:fit-content;align-items:center;gap:6px;margin:12px auto 0;/);
  assert.match(css, /\.connection-catalogue \.mcp-browse \{justify-content:center;\}/);
});

test("a connected chat app opens like any connection: rows, the day it connected, the chat and turning it off", () => {
  const dash = fs.readFileSync(path.join(__dirname, "../webapp/views/dashboard.html"), "utf8");
  const card = dash.slice(dash.indexOf("        if (platform.connected) {"), dash.indexOf("} else if (data.selfHost && key === 'telegram' && platform.configured)"));
  assert.match(card, /class="plat-card connected" role="button" tabindex="0" aria-expanded="false" onclick="togglePlatform\(this\)"/);
  assert.match(card, />Connected &#10003;<\/span>/, "every chat app says Connected, the same as Telegram");
  assert.match(card, /row\('Chat', 'Message Yourself'\) \+ \(platform\.number \? row\('Number', escHtml\(spacedNumber\(platform\.number\)\)\)/);
  assert.match(card, /row\('Chat', escHtml\(platform\.botName \|\| 'Your bot'\)\)/);
  assert.match(card, /<div class="conn-date">Connected \$\{/, "the day it connected, as other connections show it");
  assert.match(card, /'https:\/\/wa\.me\/' \+ encodeURIComponent\(platform\.number\)/, "Open chat goes to Message Yourself");
  assert.match(card, /window\.open\('\$\{chatHref\}','_blank','noopener'\)">Open chat<\/button>/, "a button like every other tile's");
  assert.match(card, /platformAskOff\(this\)">Disconnect<\/button>/);
  assert.doesNotMatch(dash, /'Unlink'|linked as a device|' unlinked\.'/, "one word for turning any chat app off");
  const spacedNumber = new Function(dash.slice(dash.indexOf("    function spacedNumber(digits) {"), dash.indexOf("    function row(label, value) {")) + "return spacedNumber;")();
  assert.equal(spacedNumber("447700900123"), "+44 7700900123");
  assert.equal(spacedNumber("15550100123"), "+1 5550100123");
  assert.equal(spacedNumber("35315550123"), "+353 15550123");
  assert.equal(spacedNumber("8613800000000"), "+86 13800000000");
  assert.doesNotMatch(card, /\/setup#step-chat|Manage/, "nothing sends you off to setup to turn it off");
  assert.doesNotMatch(dash, /platformDisconnectClick|Tap again to disconnect/, "no hidden second tap");
  assert.match(dash, /'Disconnect ' \+ name \+ '\? Closedhand stops replying and sending you messages there\. Your bot stays set up, so saying hello to it connects it again\.'/);
  const server = fs.readFileSync(path.join(__dirname, "../webapp/server.js"), "utf8");
  const unlink = server.slice(server.indexOf('app.post("/api/setup/whatsapp-linked"'));
  assert.ok(unlink.indexOf('from("chat_links").delete()') > 0 && unlink.indexOf('from("chat_links").delete()') < unlink.indexOf("res.json({ success: true, enabled: enable })"), "unlinking clears the link the card reads");
});
