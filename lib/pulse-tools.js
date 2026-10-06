// The tools Pulse's writer starts with: what its instructions ask it to do
// (read and pin facts, check mail, calendar, attachments and flights, look
// things up by meaning, read an original in full, check the weather). Every
// other tool, including the person's own connected apps, is listed by name
// and unlocked with get_tool_details, as in the chat. send_pulse is Pulse's
// own and is always offered. The starting set never varies with the news,
// so the tool list repeats from check to check and providers can cache it.
const { createToolScope } = require("./task-tools");
const { READ_ONLY_TOOLS } = require("./read-only-tools");
const PULSE_INITIAL = ["get_tool_details", "get_facts", "pin_fact", "search_cache", "read_cached_record", "semantic_search",
  "search_calendar", "fetch_attachment", "flight_scan", "weather_lookup"];
// Pulse runs with nobody watching, and the mail it reads can come from
// anyone, so an email could be written to steer it. It only looks things up,
// keeps ClosedHand's own notes (pinned facts, flights) and messages the
// person. It never sends, changes or deletes anything in their accounts, and
// never fetches a web address, which a planted link could use to carry their
// data away. Something that wants doing goes in its message, and the person
// asks for it in chat, where a change waits for their yes. appReadOnly says
// whether a connected app's tool declares that it only reads.
const PULSE_OWN = new Set(["pin_fact", "read_cached_record", "fetch_attachment", "flight_scan"]);
function pulseMayUse(name, appReadOnly = () => false) {
  if (name === "web_fetch") return false;
  return READ_ONLY_TOOLS.has(name) || PULSE_OWN.has(name) || appReadOnly(name);
}
function pulseToolScope(tools, appReadOnly) {
  return createToolScope(tools.filter((t) => pulseMayUse(t.name, appReadOnly)), "", { initial: PULSE_INITIAL });
}
module.exports = { PULSE_INITIAL, pulseToolScope, pulseMayUse };
