// The first message is stored with the connection so setup can show the very
// same words that were sent to WhatsApp, including after a page reload.
function buildWelcome(facts) {
  const values = {};
  for (const [key, raw] of Object.entries(facts || {})) {
    let value = raw;
    if (typeof value === "string" && value.startsWith("{")) {
      try { value = JSON.parse(value).value; } catch (_) {}
    } else if (value && typeof value === "object") value = value.value;
    if (value != null) values[key] = String(value).trim();
  }
  const full = values["profile-name"] || "";
  const name = ((full.match(/\(([^)]+)\)/) || [])[1] || full.split(/\s+/)[0]).slice(0, 60);
  const key = ["upcoming-key-event-1", "project-current-1", "profile-company", "profile-job-title"]
    .find(k => values[k]);
  const fact = key ? values[key].replace(/[.\s]+$/, "").slice(0, 180) : null;
  const lines = [`Hey${name ? " " + name : ""}. We're connected. This is where you can talk to me, in Message Yourself.`];
  if (fact) lines.push(`One thing I've picked up already: ${fact}.`);
  lines.push("Ask me what needs your attention, or send me something to remember.");
  lines.push("Your dashboard shows what I know, which apps are connected, and the work you ask me to do. I'll show you around there when you're ready.");
  return lines.join("\n\n");
}

module.exports = { buildWelcome };
