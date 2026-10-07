// A request plainly about mail, calendar, files, reminders or places gets those tools with its
// first model call, instead of spending a round trip looking them up.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8");
const start = src.indexOf("const TOOL_FAMILIES");
const end = src.indexOf("\n}\n", src.indexOf("function likelyOnDemandTools")) + 3;
const box = {};
vm.runInNewContext(src.slice(start, end) + "\nthis.likely = likelyOnDemandTools;", box);
const available = ["gmail_send", "gmail_reply", "gmail_create_draft", "gcal_create_event", "gcal_update_event", "drive_search", "drive_read", "outlook_send", "list_bookings", "booking_scan", "add_schedule", "list_schedules", "remove_schedule", "maps_search_places", "maps_directions", "maps_geocode"].map((name) => ({ name }));
const pick = (msg, convo = []) => [...box.likely(msg, convo, available)].sort();

test("mail, calendar and Drive requests load their tools up front", () => {
  assert.deepEqual(pick("Email sam@example.com about dinner"), ["gmail_create_draft", "gmail_reply", "gmail_send", "outlook_send"]);
  assert.deepEqual(pick("Add dinner to my calendar on Friday"), ["gcal_create_event", "gcal_update_event"]);
  assert.deepEqual(pick("Find my Google Doc about the menu"), ["drive_read", "drive_search"]);
});

test("reminders and places load their tools up front too", () => {
  assert.deepEqual(pick("oh and make the icloud reminder 8am not 9"), ["add_schedule", "list_schedules", "remove_schedule"]);
  assert.deepEqual(pick("which of those hotels is closest to Ben Thanh market?"), ["maps_directions", "maps_geocode", "maps_search_places"]);
});

test("a follow-up keeps the tools the last turns used", () => {
  const convo = [{ role: "assistant", content: [{ type: "tool_use", name: "gcal_create_event", input: {} }] }];
  assert.deepEqual(pick("Move it to 7:30pm", convo), ["gcal_create_event", "gcal_update_event"]);
});

test("a question about what a background run found loads its saved result", () => {
  const tools = [{ name: "agent_report_read" }, { name: "agent_report_update" }, { name: "agent_status" }];
  assert.deepEqual([...box.likely("what did it find?", [], tools)].sort(), ["agent_report_read", "agent_report_update"]);
  assert.deepEqual([...box.likely("can you find the receipt", [], tools)], [], "finding something new is not about a run");
  assert.deepEqual([...box.likely("so what has the agent found", [], tools)].sort(), ["agent_report_read", "agent_report_update"]);
  assert.deepEqual([...box.likely("reword the report's second section", [], tools)].sort(), ["agent_report_read", "agent_report_update"]);
});

test("a short reply carries the subject of ClosedHand's last message", () => {
  const convo = [{ role: "user", content: "write to Sam about dinner" }, { role: "assistant", content: "Here's a draft email to Sam: ... Want me to send it?" }];
  assert.deepEqual(pick("make it a bit warmer", convo), ["gmail_create_draft", "gmail_reply", "gmail_send", "outlook_send"]);
  assert.deepEqual(pick("Separately, what is the weather going to do on Saturday afternoon around Hampstead Heath for the picnic?", convo), [], "a long new message brings its own subject");
});

test("changing a setting loads the settings tools", () => {
  const tools = [{ name: "update_settings" }, { name: "pulse_toggle" }, { name: "pulse_check" }, { name: "gmail_send" }];
  assert.deepEqual([...box.likely("turn pulse off for the weekend", [], tools)].sort(), ["pulse_check", "pulse_toggle", "update_settings"]);
  assert.deepEqual([...box.likely("set quiet hours from 11pm", [], tools)].sort(), ["pulse_check", "pulse_toggle", "update_settings"]);
  assert.deepEqual([...box.likely("call me Sammy from now on", [], tools)].sort(), ["pulse_check", "pulse_toggle", "update_settings"]);
});

test("anything else leaves every tool on demand", () => {
  assert.deepEqual(pick("What's the weather like?"), []);
  assert.deepEqual(pick("Thanks!"), []);
});

test("only tools this person can use are ever loaded", () => {
  assert.deepEqual([...box.likely("send an email", [], [{ name: "outlook_send" }])], ["outlook_send"]);
});
