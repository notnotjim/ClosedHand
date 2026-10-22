#!/usr/bin/env node
// How well the daily look (lib/routine-offers.js) picks requests worth
// offering as a routine from six weeks of invented ones. Two belong: a
// weekly summary and a monthly export. The rest must not become offers:
// replies to someone, one parcel chased daily and still going, the same question at odd
// times, one-offs. The bar is no wrong offer on any run, after the code's
// own rhythm and trigger checks.
//
//   node scripts/eval-routine-offers.js --prompt > prompt.json
//   node scripts/eval-routine-offers.js --grade answers.json   ([{ run, text }])
//
// Not run in CI: it needs a live LLM.

const path = require("path");
for (const [rel, exports] of Object.entries({ "../lib/db": { supabase: {} }, "../lib/llm": { getInternalClient: () => { throw new Error("not in the eval"); } } })) {
  const p = require.resolve(path.join(__dirname, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const offers = require("../lib/routine-offers");
const { specificTrigger } = require("../lib/skill-learning");

const NOW = Date.parse("2026-10-27T01:00:00Z");
let n = 0;
const ask = (day, hour, text) => ({ id: "r" + (++n), text, at: new Date(Date.parse(`${day}T${String(hour).padStart(2, "0")}:10:00+09:00`)).toISOString(), local_at: `${day}T${String(hour).padStart(2, "0")}:10` });
const ASKS = [
  ask("2026-09-01", 20, "Export last month's Shopify orders to a spreadsheet"),
  ask("2026-09-03", 11, "Reply to Sam about the invoice, say we'll pay Friday"),
  ask("2026-09-10", 11, "Reply to Sam and ask if the new invoice is ready"),
  ask("2026-09-17", 11, "reply to sam, thanks for the invoice"),
  ask("2026-09-20", 15, "What's a good restaurant near Namba for 6 people"),
  ask("2026-10-01", 19, "Can you do the Shopify orders export for September as a spreadsheet"),
  ask("2026-10-03", 9, "Summarise what the accountants sent this week"),
  ask("2026-10-06", 14, "What's the weather in Kyoto on Saturday"),
  ask("2026-10-10", 9, "summarise this week's emails from the accountants"),
  ask("2026-10-13", 22, "weather tomorrow?"),
  ask("2026-10-17", 9, "What did the accountants send this week? Short summary please"),
  ask("2026-10-23", 8, "Has my Lego parcel shipped yet"),
  ask("2026-10-24", 8, "Check if the Lego order has shipped"),
  ask("2026-10-25", 8, "any news on the lego parcel?"),
  ask("2026-10-26", 8, "Lego parcel shipped?"),
  ask("2026-10-23", 9, "Summarise the accountants' emails from this week"),
  ask("2026-10-24", 16, "Book the dentist for next week"),
  ask("2026-10-25", 10, "weather for my run this afternoon"),
  ask("2026-10-26", 21, "Shopify orders for October to a sheet please"),
];
const WANTED = { accountants: /accountant/i, shopify: /shopify/i };

function prompt() {
  return offers.findPrompt(ASKS, [{ name: "Morning mail summary", task_prompt: "Summarise new mail each morning" }]);
}

// What would really be offered: the code keeps a group only with a steady
// rhythm and two clear triggers.
function grade(answers) {
  const byId = new Map(ASKS.map((a) => [a.id, a]));
  let wrong = 0, found = 0, runs = 0;
  for (const a of answers) {
    runs++;
    let v = null;
    try { v = JSON.parse(String(a.text).match(/\{[\s\S]*\}/)?.[0] || "null"); } catch (_) {}
    for (const g of v?.groups || []) {
      const members = (g.ids || []).map((id) => byId.get(id)).filter(Boolean);
      const rhythm = offers.rhythmOf(members, NOW);
      const triggers = (g.triggers || []).map((t) => String(t).toLowerCase()).filter(specificTrigger);
      const kept = rhythm && triggers.length >= 2;
      const kind = Object.keys(WANTED).find((k) => members.length && members.every((m) => WANTED[k].test(m.text)));
      if (kept && !kind) wrong++;
      if (kept && kind) found++;
      console.log(`${kept ? (kind ? "ok   " : "WRONG") : "drop "} run ${a.run}: "${g.name}" [${members.map((m) => m.text.slice(0, 30)).join(" / ")}] ${rhythm ? rhythm.words : "no rhythm"}; triggers ${JSON.stringify(triggers)}`);
    }
  }
  console.log(`\nwrong offers: ${wrong} (bar 0); good offers kept: ${found} of ${runs * Object.keys(WANTED).length}`);
  return wrong === 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "--prompt") process.stdout.write(JSON.stringify(prompt()));
  else if (args[0] === "--grade") process.exit(grade(JSON.parse(require("fs").readFileSync(args[1], "utf8"))) ? 0 : 1);
  else { console.error("Use --prompt or --grade answers.json"); process.exit(2); }
}

module.exports = { ASKS, prompt, grade };
