const SAFE_READS = new Set(["read_cached_record", "web_search", "web_fetch", "weather_lookup", "search_cache", "search_calendar", "list_flights", "list_bookings", "gcal_list_events", "gcal_search_events", "gcal_list_calendars", "drive_search", "maps_search_places", "maps_directions", "maps_geocode", "air_quality"]);
const INITIAL = new Set(["get_tool_details", "list_connections", "get_facts", "search_cache", "web_search", "web_fetch", "sandbox_exec", "sandbox_file_read", "sandbox_file_download", "use_skill", "agent_map"]);
function createToolScope(all, goal = "") {
  const byName = new Map(all.map(t => [t.name, t]));
  const words = String(goal).toLowerCase().match(/[a-z]{4,}/g) || [];
  const ranked = all.map(t => ({ tool: t, score: words.filter(w => (t.name + " " + t.description).toLowerCase().includes(w)).length }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.tool.name);
  const initial = new Set([...INITIAL, ...ranked]);
  return {
    has: name => byName.has(name),
    describe: name => byName.has(name) ? { ...byName.get(name), note: "This tool is available on your next step." } : { error: "That tool is not available to this task." },
    catalog: "\nAvailable tools (request a schema with get_tool_details before using an additional tool): " + all.map(t => t.name).sort().join(", "),
    definitions(messages = []) {
      if (process.env.AGENT_TOOL_DISCOVERY === "0") return all;
      const names = new Set(initial);
      for (const m of messages) for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === "tool_use") { names.add(b.name); if (b.name === "get_tool_details") names.add(b.input?.tool_name); }
      }
      return [...byName.values()].filter(t => names.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
async function runRead(userId, platform, chatId, name, input) {
  if (!SAFE_READS.has(name)) throw new Error("Concurrent execution is limited to isolated reads");
  const ctx = require("./context");
  return ctx.runWithInheritedContext(async () => {
    const store = await require("../user-store").UserStore.load(userId);
    require("./storage").swapToCloudStore(store, userId, chatId); ctx.activePlatform = platform;
    // No adapter save: this fresh read snapshot must not overwrite live chat state.
    return require("./tools/handlers").handleInternalTool(name, { ...input, _userId: userId, _chatId: chatId, _platform: platform });
  });
}
function prefetchReads(blocks, execute, concurrency = 3) {
  const calls = blocks.filter(b => b.type === "tool_use"); const pending = new Map();
  if (process.env.AGENT_PARALLEL_READS === "0" || calls.length < 2 || !calls.every(b => SAFE_READS.has(b.name))) return pending;
  let next = 0; const settlers = new Map();
  for (const call of calls) pending.set(call.id, new Promise(resolve => settlers.set(call.id, resolve)));
  const worker = async () => {
    while (next < calls.length) {
      const call = calls[next++];
      let result; try { result = await execute(call); } catch (error) { result = { error: error.message }; }
      settlers.get(call.id)(result);
    }
  };
  for (let i = 0; i < Math.min(concurrency, calls.length); i++) worker();
  return pending;
}
module.exports = { createToolScope, SAFE_READS, runRead, prefetchReads };
