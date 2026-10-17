// lib/web-search-fallback.js -- free web search, with no key and nothing to pay.
//
// Every Closedhand can search the web, whatever AI provider it uses. With no
// search key and no provider search, this reads the ordinary results pages of
// DuckDuckGo and Brave Search, as a browser on the same computer would. Each
// answer takes the shape the paid searches return.
//
// DuckDuckGo and Brave sometimes show a connection a check for bots instead of
// results, more often after a burst of searches: DuckDuckGo did for whole days
// in October 2026. A check was once read as an empty search, and a background
// task that got nothing from nine searches spent its whole step allowance
// working round them. So a check is never "no results": that engine rests for
// a while and the next one answers. Checks are respected, never worked round.
// Requests to one engine are spaced out and a repeated search is answered from
// memory for ten minutes, so there are fewer bursts to begin with. Only when
// every engine is resting does the search fail, with an error the model can
// act on.
const { httpGet } = require("./http");

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function stripTags(s) { return decodeEntities(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }

// A results page that is really a check for bots.
class BotCheck extends Error {}

// DuckDuckGo wraps each result URL in a redirect: //duckduckgo.com/l/?uddg=<url>
function realUrl(href) {
  const m = String(href || "").match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; } }
  return href;
}

function parseDuckDuckGo(statusCode, body, count = 5) {
  if (statusCode !== 200 || /bots use DuckDuckGo|anomaly-modal|challenge-form/i.test(body)) throw new BotCheck("DuckDuckGo");
  const results = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let m;
  while ((m = snippetRe.exec(body))) snippets.push(stripTags(m[1]));
  let i = 0;
  while ((m = linkRe.exec(body)) && results.length < count) {
    const url = realUrl(decodeEntities(m[1]));
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com/.test(url)) { i++; continue; }
    results.push({ title: stripTags(m[2]), url, snippet: snippets[i] || "" });
    i++;
  }
  return results;
}

// Brave's page marks each web result data-type="web": the first link is the
// result, then its title and its snippet.
function parseBrave(statusCode, body, count = 5) {
  const blocks = String(body).split('data-type="web"').slice(1);
  if (statusCode !== 200 || (!blocks.length && /captcha/i.test(body))) throw new BotCheck("Brave");
  const results = [];
  for (const block of blocks) {
    if (results.length >= count) break;
    const link = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/);
    const title = block.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const snippet = block.match(/class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!link || !title) continue;
    const url = decodeEntities(link[1]);
    if (/(^|\.)brave\.com\//.test(url.replace(/^https?:\/\//, ""))) continue;
    results.push({ title: stripTags(title[1]), url, snippet: snippet ? stripTags(snippet[1]) : "" });
  }
  return results;
}

const ENGINES = [
  { name: "DuckDuckGo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGo },
  { name: "Brave", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`, parse: parseBrave },
];
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; ClosedHand/1.0; +https://closedhand.com)", "Accept": "text/html", "Accept-Language": "en-GB,en;q=0.8" };
// An engine that shows a check rests 15 minutes, doubling each time it
// shows another straight after, up to four hours.
const REST_MS = 15 * 60000, MAX_REST_MS = 4 * 3600000;
// At least this long between two requests to one engine, and how long a
// search is remembered.
const GAP_MS = 2000, REMEMBER_MS = 10 * 60000, REMEMBERED = 100;
// An engine that has not answered by then is passed over, so a slow one
// cannot keep a person waiting.
const ANSWER_WITHIN_MS = 8000;

const UNAVAILABLE = "web search is unavailable: the free search engines are showing this connection a check for bots instead of results, so searching again will not help. Fetch a page whose address you know, or answer from what you know and say it is unchecked";

function createFreeSearch({ get = httpGet, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)), engines = ENGINES, answerWithinMs = ANSWER_WITHIN_MS } = {}) {
  const resting = new Map(); // engine name -> { until, rest }
  const nextAt = new Map(); // engine name -> earliest time for its next request
  const remembered = new Map(); // "count:query" -> { at, answer }
  let lead = 0; // the engine that answered last goes first next time
  return async function freeSearch(query, count = 5) {
    const key = count + ":" + String(query).trim().toLowerCase();
    const hit = remembered.get(key);
    if (hit && now() - hit.at < REMEMBER_MS) return hit.answer;
    const order = engines.map((_, i) => engines[(lead + i) % engines.length]);
    let answered = null, lastError = null;
    for (const engine of order) {
      const r = resting.get(engine.name);
      if (r && r.until > now()) continue;
      try {
        const at = Math.max(now(), nextAt.get(engine.name) || 0);
        nextAt.set(engine.name, at + GAP_MS);
        if (at > now()) await wait(at - now());
        let timer;
        const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${engine.name} took too long`)), answerWithinMs); });
        const { statusCode, body } = await Promise.race([get(engine.url(query), HEADERS), late]).finally(() => clearTimeout(timer));
        const results = engine.parse(statusCode, body, count);
        resting.delete(engine.name);
        lead = engines.indexOf(engine);
        if (results.length) { answered = { results, source: engine.name }; break; }
        answered = answered || { results, source: engine.name };
      } catch (e) {
        if (e instanceof BotCheck) {
          const rest = r ? Math.min(r.rest * 2, MAX_REST_MS) : REST_MS;
          resting.set(engine.name, { until: now() + rest, rest });
          console.warn(`[web-search] ${engine.name} showed a check for bots; resting it ${Math.round(rest / 60000)} minutes`);
        } else {
          lastError = e;
        }
      }
    }
    if (answered) {
      remembered.delete(key);
      remembered.set(key, { at: now(), answer: answered });
      if (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value);
      return answered;
    }
    if (lastError) throw new Error(`web search failed: ${lastError.message}`);
    throw new Error(UNAVAILABLE);
  };
}

const freeSearch = createFreeSearch();

module.exports = { freeSearch, createFreeSearch, parseDuckDuckGo, parseBrave, BotCheck, UNAVAILABLE };
