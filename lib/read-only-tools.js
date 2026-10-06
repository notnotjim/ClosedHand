// Tools that only look things up and change nothing. The chat runs several
// at once in one model turn and gives each a time limit (lib/engine.js);
// Pulse may use only these (lib/pulse-tools.js).
const READ_ONLY_TOOLS = new Set(["get_dashboard_overview", "web_search", "web_fetch", "weather_lookup", "search_cache", "semantic_search", "search_calendar", "list_flights", "list_bookings", "gcal_list_events", "gcal_search_events", "gcal_list_calendars", "drive_search", "drive_list_recent", "onedrive_search", "onedrive_list_recent", "maps_search_places", "maps_directions", "maps_geocode", "air_quality", "tfl_line_status", "tfl_journey", "tfl_departures", "list_attachments", "get_facts", "list_schedules", "list_connections", "matter_get", "automation_list", "agent_status", "sandbox_status", "sandbox_file_list", "list_datasets", "caldav_list_events", "get_tool_details"]);

module.exports = { READ_ONLY_TOOLS };
