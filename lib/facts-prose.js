// lib/facts-prose.js -- pinned facts as the model should read them.
//
// They used to reach the prompt as one JSON object keyed by storage names,
// so "pattern-2: Heavy marketing mail" sat beside "Sayako is James's
// girlfriend" with the same standing and no sense of what either was. Now
// they read as sentences, grouped by what they are about, with the key only
// as a bracketed handle for pin_fact and delete_fact. A fact the setup scan
// guessed says so, so the model treats it as unconfirmed.
const GROUPS = [
  ["profile", "About the user"],
  ["person", "People in their life"],
  ["business", "Businesses and projects"],
  ["preference", "How they want things done"],
  ["topic", "Other"],
];
function isInternal(key) {
  const k = String(key || "");
  return k.startsWith("_") || k.startsWith("flight-") || /^pulse[-_ ]/i.test(k) || k === "pulse" || k === "Pulse";
}
function unpack(raw) {
  if (raw && typeof raw === "object" && raw.value !== undefined) return raw;
  return { value: raw };
}
function sentence(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(t) ? t : t + ".";
}
function factsProse(facts, opts = {}) {
  const rows = [];
  for (const [key, raw] of Object.entries(facts || {})) {
    if (isInternal(key)) continue;
    const f = unpack(raw);
    if (f.value == null || String(f.value).trim() === "") continue;
    rows.push({ key, value: String(f.value), category: f.category || "topic", subject: f.subject || null, source: f.source || null });
  }
  if (rows.length === 0) return "";
  const lines = [];
  lines.push("PINNED FACTS, saved earlier about the user's life. Treat them as settled unless the user says otherwise; then update or remove them with pin_fact or delete_fact using the key in brackets.");
  for (const [category, label] of GROUPS) {
    const group = rows.filter(r => (GROUPS.some(g => g[0] === r.category) ? r.category : "topic") === category);
    if (group.length === 0) continue;
    group.sort((a, b) => (a.subject || a.key).localeCompare(b.subject || b.key));
    lines.push("");
    lines.push(label + ":");
    let lastSubject = null;
    for (const r of group) {
      const scanned = r.source === "setup scan" ? " (read from mail by the setup scan)" : "";
      let lead = "";
      if (category === "profile") {
        // The user's own facts are labelled by what they are, not by who.
        const label = r.key.replace(/^profile[-_]/, "").replace(/[-_]+/g, " ").trim();
        if (label && label !== r.key) lead = label.charAt(0).toUpperCase() + label.slice(1) + ": ";
      } else if (r.subject && r.subject !== lastSubject && !r.value.toLowerCase().startsWith(r.subject.toLowerCase())) {
        lead = r.subject + ": ";
      }
      lines.push("- " + lead + sentence(r.value) + scanned + " [" + r.key + "]");
      if (r.subject) lastSubject = r.subject;
    }
  }
  return lines.join("\n");
}
module.exports = { factsProse, isInternal };
