// The dashboard of a Closedhand that has moved to another computer
// (move.js). It starts nothing else, no sync, tunnel or schedule: every page
// says where Closedhand went.
const express = require("express");
const fs = require("fs");
const path = require("path");
const assets = require("./assets");

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(state) {
  let url = null;
  try { url = new URL(state.url || state.to).href.replace(/\/$/, ""); } catch (_) { /* no address recorded */ }
  let where = "on another computer";
  try { if (new URL(state.to).hostname.endsWith(".railway.app")) where = "on Railway"; } catch (_) {}
  const html = assets.stamp(fs.readFileSync(path.join(__dirname, "views", "moved.html"), "utf8"))
    .replace("__WHERE__", where)
    .replace("__URL__", escape(url || "#"))
    .replace("__URL_TEXT__", escape(url ? url.replace(/^https?:\/\//, "") : "its new address"));
  return assets.withAppearance(html);
}

function serve() {
  const state = require("./move-marker").read();
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (req, res) => res.json({ status: "ok", service: "closedhand-webapp", move: "moved" }));
  // Settings polls this while handing over; after the restart it lands here.
  app.get("/api/move/status", (req, res) => res.set("Cache-Control", "no-store").json({ step: "done", url: state.url || state.to || null }));
  app.use(express.static(path.join(__dirname, "public"), { setHeaders: assets.cacheHeaders }));
  app.use((req, res) => res.set("Cache-Control", "no-store").type("html").send(page(state)));
  const port = process.env.PORT || 3000;
  app.listen(port, process.env.LISTEN_HOST || undefined, () => console.log(`[move] moved to ${state.to}: the dashboard shows only that (port ${port})`));
}

module.exports = { serve, page };
