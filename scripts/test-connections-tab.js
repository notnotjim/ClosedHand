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
    '<h3 class="add-sub">Connect anything</h3>', '<p class="mcp-description">Paste an MCP server</p>', "Connections are scanned for security risks</p>"]) {
    assert.ok(add.includes(want), want);
  }
  assert.doesNotMatch(dashboard, /Your MCPs|<summary>Connect more<\/summary>|id="catalogue-search"|Add a key when prompted|int-more-sub/);
  assert.match(dashboard, /Connect your Mac and choose what ClosedHand has access to/);
  assert.match(dashboard, /if \(live\) document\.getElementById\('connected-section'\)\.appendChild\(macCard\);/, "the Mac moves to Connected once set up");
  assert.match(dashboard, /var any = !!section\.querySelector\('#connected-grid > \.int-wrap, #mcp-list > \.int-wrap, #apple-local-section:not\(\[style\*="display: none"\]\)'\);/, "Connected shows only when something is");
  assert.match(dashboard, /if \(window\.filterConnectionCatalogue\) window\.filterConnectionCatalogue\(query\);/, "one search for the whole tab");
});
