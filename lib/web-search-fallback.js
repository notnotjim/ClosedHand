// lib/web-search-fallback.js -- web search with no key.
//
// web_search is Brave, which needs a paid key most self-hosters will not have,
// so an agent asked to look something up came back with a configuration error
// instead of results. DuckDuckGo's HTML endpoint answers a plain GET with no
// key; this parses its result list into the same shape Brave returns. A
// fallback, not a replacement: Brave stays first when its key is present.
const { httpGet } = require("./http");

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s) { return decodeEntities(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }

// DuckDuckGo wraps each result URL in a redirect: //duckduckgo.com/l/?uddg=<url>
function realUrl(href) {
  const m = String(href || "").match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; } }
  return href;
}

// DuckDuckGo sometimes answers a connection with a "bots use DuckDuckGo too"
// check (HTTP 202) instead of results. That page has no result links, and it
// was read as an empty search: on 16 October a background task got nothing
// from nine searches and spent its whole step allowance working round them.
// A check is an error the model can act on, never "no results".
function parseResults(statusCode, body, count = 5) {
  if (statusCode !== 200 || /bots use DuckDuckGo|anomaly-modal|challenge-form/i.test(body)) {
    throw new Error("web search is unavailable: DuckDuckGo is showing this connection a check for bots instead of results, so searching again will not help. Fetch a page whose address you know, or answer from what you know and say it is unchecked");
  }
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

async function duckDuckGoSearch(query, count = 5) {
  const { body, statusCode } = await httpGet(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { "User-Agent": "Mozilla/5.0 (compatible; ClosedHand/1.0)", "Accept": "text/html" }
  );
  return parseResults(statusCode, body, count);
}

module.exports = { duckDuckGoSearch, parseResults };
