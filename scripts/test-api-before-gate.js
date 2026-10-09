// Everything registered after the login gate in webapp/server.js needs the
// session once a dashboard password exists. Routes registered before it are
// reachable by anyone who can reach the dashboard, including through the
// personal URL, so each must check access itself (requireSetupAccess, which
// is open only until a password exists) or be on the short list of routes
// that are public by design. The Wallet and chat-app key routes once sat
// there without a check; this test keeps any route from doing so again.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const server = fs.readFileSync(path.join(__dirname, "..", "webapp", "server.js"), "utf8");

const PUBLIC = new Set([
  "/api/setup/status",    // which setup step to show, before signing in
  "/api/setup/qr",        // a QR picture of a t.me link
  "/api/setup/provider",  // always refuses
  "/api/login",           // signing in
  "/api/telegram/session",// Telegram's own signed proof
]);
const GUARDS = /requireSetupAccess\(req, res\)|hasAdminSession\(req, res\)|hereHeaders\(req, res\)|checkDashboardPassword\(|validateTelegramInitData\(/;

test("every API route before the login gate checks access, or is public by design", () => {
  const gate = server.indexOf("// --- The gate: everything registered below needs the session");
  assert.ok(gate > 0, "the gate is where this test expects it");
  const before = server.slice(0, gate);
  const routes = [...before.matchAll(/^app\.(get|post|put|patch|delete)\("([^"]+)"/gm)];
  const open = [];
  routes.forEach((m, i) => {
    const route = m[2];
    if (!route.startsWith("/api/") || PUBLIC.has(route)) return;
    const end = i + 1 < routes.length ? routes[i + 1].index : before.length;
    if (!GUARDS.test(before.slice(m.index, end))) open.push(m[1].toUpperCase() + " " + route);
  });
  assert.deepEqual(open, [], "open to anyone who can reach the dashboard: " + open.join(", "));
  for (const r of ['app.get("/api/wallet"', 'app.post("/api/wallet"', 'app.delete("/api/wallet/:id"', 'app.post("/api/settings/spend-limits"', 'app.post("/api/chat-apps/:app"', 'app.delete("/api/chat-apps/:app"']) assert.ok(before.includes(r), r + " is still checked here");
});
