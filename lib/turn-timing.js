// Where a reply's time went, as one log line, so a slow reply explains itself.
// Replies took a median of 23 s and up to six minutes, a time-zone question
// among them, and nothing in the log said whether the wait was the model, a
// tool, recall or a queue.
//
//   [Turn] 41.2s: model 3x 18.4s (2.1 9.8 6.5), tool search_cache 12.0s, recall 6.0s, check: asked for 2.3s

function start() {
  const t0 = Date.now();
  const parts = [];
  return {
    // Time a promise under a label and return its result.
    async time(label, work) {
      const s = Date.now();
      try { return await work; } finally { parts.push([label, Date.now() - s]); }
    },
    add(label, ms) { parts.push([label, ms]); },
    line(note = "") {
      const groups = new Map();
      for (const [label, ms] of parts) groups.set(label, (groups.get(label) || []).concat(ms));
      const sec = (ms) => (ms / 1000).toFixed(1);
      const pieces = [...groups.entries()]
        .map(([label, list]) => ({ label, list, sum: list.reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.sum - a.sum)
        .map(({ label, list, sum }) => list.length > 1
          ? `${label} ${list.length}x ${sec(sum)}s (${list.map(sec).join(" ")})`
          : `${label} ${sec(sum)}s`);
      return `[Turn] ${sec(Date.now() - t0)}s${note ? " " + note : ""}: ${pieces.join(", ") || "no timed steps"}`;
    },
  };
}

module.exports = { start };
