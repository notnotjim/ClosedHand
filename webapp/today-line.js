// The "today" line under the home page's chat box: what is on today and
// tomorrow at a glance, the answer "what's on today?" gives, without asking.
// Timed calendar events, bookings and flights, in the person's own time, one
// entry per thing (a booking and the calendar event made from it are one),
// marked when rain is likely at that hour.

function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}` };
}

// "Reservation at Harbour Grill Old Town, table for 2" reads as "Harbour
// Grill Old Town": what it is, in whole words, at most four.
function shortLabel(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim()
    .replace(/^(reservation|booking|table|appointment|stay|dinner|lunch)\s+(at|with|for)\s+/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/,.*$/, "");
  if (t.length > 26) t = t.split(" ").slice(0, 4).join(" ");
  return t;
}

const words = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
function sameThing(a, b) {
  if (Math.abs(a.at - b.at) > 45 * 60000) return false;
  const wa = words(a.raw), wb = words(b.raw);
  for (const w of wa) if (wb.has(w)) return true;
  return false;
}

// items: [{ at: ms, raw: "title", kind: "event"|"booking"|"flight", label? }]
function build(items, { tz, now = Date.now(), rainAt = () => false } = {}) {
  const today = localParts(now, tz).day;
  const tomorrow = localParts(now + 86400000, tz).day;
  const kept = [];
  const order = { booking: 0, flight: 1, event: 2 };
  for (const it of [...items].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (!Number.isFinite(it.at) || it.at < now - 30 * 60000) continue;
    const day = localParts(it.at, tz).day;
    if (day !== today && day !== tomorrow) continue;
    if (kept.some((k) => sameThing(k, it))) continue;
    kept.push(it);
  }
  return kept.sort((a, b) => a.at - b.at).slice(0, 4).map((it) => {
    const { day, time } = localParts(it.at, tz);
    return { when: day === today ? "today" : "tomorrow", time, label: it.label || shortLabel(it.raw), rain: it.kind !== "flight" && !!rainAt(it.at) };
  });
}

// "Dentist 09:00 · Harbour Grill 19:00, rain likely · Tomorrow: flight to SGN 11:55"
function sentence(entries) {
  if (!entries.length) return "";
  const part = (e) => `${e.label} ${e.time}${e.rain ? ", rain likely" : ""}`;
  const todays = entries.filter((e) => e.when === "today").map(part);
  const tomorrows = entries.filter((e) => e.when === "tomorrow").map(part);
  const out = [];
  if (todays.length) out.push("Today: " + todays.join(" · "));
  if (tomorrows.length) out.push("Tomorrow: " + tomorrows.join(" · "));
  return out.join(" · ");
}

module.exports = { build, sentence, shortLabel, localParts };
