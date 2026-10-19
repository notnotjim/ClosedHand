// tool-jobs.js: Closedhand's own tools that a connected service can take over.
//
// Vendored: lib/tool-jobs.js (bot) and webapp/tool-jobs.js (dashboard), kept
// byte-identical (scripts/check-vendored-identical.js).
//
// Every tool here looks something up outside: the web, a page, a video, the
// weather, a map. When the person connects a service that does one of these
// (an MCP server, or a key for a plain API), it does that job first, with no
// code for that service: webapp/connection-jobs.js finds which of its tools
// does which job when it is connected, and lib/connection-jobs.js runs it in
// place of Closedhand's own tool, falling back to it when the service fails.
// The voice (speaking, writing out speech) works the same way with its own
// sound handling. Tools that read the person's own accounts (mail, calendar,
// files) are not here: there is nothing for a service to take over.
//
// An entry: tool, the Closedhand tool it replaces; does, what a service's
// tool must do; inputs, Closedhand's tool's own arguments, passed on as the
// model gave them (required: a service's tool must take it); words, what
// makes a service's tool worth asking about; findWith, the words that find
// it in a plain API's endpoint list; title and lower, how the tile and the
// news name it; usesLocation, the saved location fills a missing place.

const JOBS = {
  search: {
    tool: "web_search",
    does: "searches the web for a query and returns the results: titles, links and snippets, or an answer with its sources",
    inputs: { query: { about: "the words to search for", required: true }, count: { about: "how many results to return" } },
    words: /search|query|web|serp|google|bing|lookup|look up/i,
    findWith: "search the web query results",
    title: "Closedhand’s search",
    lower: "searching the web",
  },
  read_page: {
    tool: "web_fetch",
    does: "fetches a web page by its address and returns its readable text or markdown",
    inputs: { url: { about: "the page's address", required: true } },
    words: /fetch|scrape|crawl|read|page|url|extract|markdown|browse/i,
    findWith: "scrape a web page url to markdown text",
    title: "Reading web pages",
    lower: "reading web pages",
  },
  video: {
    tool: "watch_video",
    does: "watches or transcribes a video from its link and says what is in it, or answers a question about it",
    inputs: { url: { about: "the video's link", required: true }, question: { about: "what to find out about the video" } },
    words: /video|youtube|transcri|watch|clip/i,
    findWith: "video url transcript summary",
    title: "Watching videos",
    lower: "watching videos",
  },
  weather: {
    tool: "weather_lookup",
    does: "gives the current weather and forecast for a place",
    inputs: { latitude: { about: "the place's latitude" }, longitude: { about: "the place's longitude" }, location_name: { about: "the place's name, such as a city" } },
    words: /weather|forecast|temperature|rain/i,
    findWith: "current weather forecast location",
    title: "Weather",
    lower: "the weather",
    usesLocation: true,
  },
  air_quality: {
    tool: "air_quality",
    does: "gives the air quality for a place",
    inputs: { latitude: { about: "the place's latitude" }, longitude: { about: "the place's longitude" } },
    words: /air|pollution|aqi|pollen/i,
    findWith: "air quality index location",
    title: "Air quality",
    lower: "air quality",
    usesLocation: true,
  },
  places: {
    tool: "maps_search_places",
    does: "finds places such as restaurants, shops or sights matching a query, near a location",
    inputs: { query: { about: "what to look for", required: true }, location: { about: "where to look near" }, radius: { about: "how far around it, in metres" } },
    words: /place|business|restaurant|venue|poi|nearby|search|maps/i,
    findWith: "search places nearby",
    title: "Finding places",
    lower: "finding places",
  },
  directions: {
    tool: "maps_directions",
    does: "gives a route between two places, with its time and distance",
    inputs: { origin: { about: "where from", required: true }, destination: { about: "where to", required: true }, mode: { about: "how: driving, walking, cycling or transit" } },
    words: /direction|route|navigat|journey|travel time|distance/i,
    findWith: "directions route between origin destination",
    title: "Directions",
    lower: "directions",
  },
  geocode: {
    tool: "maps_geocode",
    does: "turns an address or place name into coordinates",
    inputs: { address: { about: "the address or place", required: true } },
    words: /geocod|address|coordinates|latitude|location/i,
    findWith: "geocode address to coordinates",
    title: "Finding addresses",
    lower: "finding addresses",
  },
};

// The job that takes over a Closedhand tool, with its name, or null.
function forTool(toolName) {
  for (const [name, job] of Object.entries(JOBS)) if (job.tool === toolName) return { name, ...job };
  return null;
}

// What the tile and the news say for a job, with {name} for the service.
// Search keeps the words agreed for it.
function texts(name) {
  const job = JOBS[name];
  if (!job) return null;
  if (name === "search") {
    return {
      title: job.title,
      news: "Closedhand will now search the web with {name} first. Your searches go to {name}, which may charge your account for them.",
      on: "Closedhand searches the web with {name} first. Your searches go to {name}, which may charge your account for them.",
      off: "Closedhand searches with your primary model’s own search, or free search. Switch this on to search with {name} first.",
      stoodIn: "Last time, Closedhand’s own search stood in: ",
    };
  }
  return {
    title: job.title,
    news: `Closedhand will now use {name} first for ${job.lower}. What it looks up goes to {name}, which may charge your account for it.`,
    on: `Closedhand uses {name} first for ${job.lower}. What it looks up goes to {name}, which may charge your account for it.`,
    off: `Closedhand handles ${job.lower} itself. Switch this on to use {name} first.`,
    stoodIn: "Last time, Closedhand’s own stood in: ",
  };
}

module.exports = { JOBS, forTool, texts };
