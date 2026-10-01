// The tools Pulse's writer starts with: what its instructions ask it to do
// (read and pin facts, check mail, calendar, attachments and flights, look
// things up by meaning, read an original in full, check the weather). Every
// other tool, including the person's own connected apps, is listed by name
// and unlocked with get_tool_details, as in the chat. send_pulse is Pulse's
// own and is always offered. The starting set never varies with the news,
// so the tool list repeats from check to check and providers can cache it.
const { createToolScope } = require("./task-tools");
const PULSE_INITIAL = ["get_tool_details", "get_facts", "pin_fact", "search_cache", "read_cached_record", "semantic_search",
  "search_calendar", "fetch_attachment", "flight_scan", "weather_lookup"];
function pulseToolScope(tools) {
  return createToolScope(tools, "", { initial: PULSE_INITIAL });
}
module.exports = { PULSE_INITIAL, pulseToolScope };
