// The bot of a Closedhand that is moving to another computer, or has moved
// (lib/move-marker.js). It starts nothing: no chat apps, schedules or sync.
// It answers its health check, saying so, and the dashboard's call to start
// again once the move is over or has failed (webapp/move.js).
const express = require("express");

// POST /internal/restart, for the dashboard: the process ends and Docker,
// the Mac app or the host starts it again, reading the marker afresh. A
// non-zero exit, because a host may restart a service only when it fails.
function registerRestart(app, stop = async () => {}) {
  const { verifyToken } = require("./ws-ticket");
  app.post("/internal/restart", async (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    res.json({ restarting: true });
    console.log("[move] restarting at the dashboard's request");
    setTimeout(async () => {
      try { await stop(); } catch (_) {}
      // Files that came with a move go in first, so the bot that starts
      // next finds its WhatsApp session in place (move-files.js).
      try { await require("./move-files").restore(); } catch (e) { console.error("[move] files that came with the move:", e.message); }
      process.exit(1);
    }, 200);
  });
}

function start() {
  const state = require("./move-marker").read();
  const app = express();
  app.use(express.json());
  app.get("/health", (req, res) => res.json({ status: "ok", platform: "closedhand-bot", move: state && state.state }));
  registerRestart(app);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[move] ${state.state === "moved" ? "moved to another computer" : "moving to another computer"}: the bot starts nothing (port ${port})`));
}

module.exports = { start, registerRestart };
