// A background task once got no results from nine web searches and spent its
// whole step allowance working round them, then sent the one line it wrote
// before its last tool call instead of the answer it had drafted. DuckDuckGo
// had been showing the connection a check for bots, which was read as an empty
// search. Now free search has more than one engine, a check rests that engine
// and the next one answers, and only when every engine is resting does search
// fail, saying so. A stopped task sends the last answer it wrote.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseDuckDuckGo, parseBrave, createFreeSearch, BotCheck } = require("../lib/web-search-fallback");
const { writtenAnswer } = require("../lib/task-outcome");

const ddgCheck = `<html><body><form id="challenge-form" class="anomaly-modal__form">
<p>Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.</p></form></body></html>`;
const ddgPage = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffares.example.org%2Fharbour-line&amp;rut=1">Harbour Line &amp; fares</a>
<a class="result__snippet" href="#">Singles from <b>4.20</b> each way&#32;&#0183; daily.</a></div>`;
const bravePage = `<div class="snippet" data-type="web" data-pos="1"><div class="result-content"><a href="https://ferries.example.net/kestrel-point" class="l1">
<div class="site-name-content"><div>Kestrel Ferries</div><cite class="snippet-url">ferries.example.net</cite></div>
<div class="title search-snippet-title line-clamp-1 svelte-x1" title="Kestrel Point crossings">Kestrel Point crossings</div></a>
<div class="generic-snippet"><div class="content desktop-default-regular svelte-x2"> Crossings every <strong>40 minutes</strong> from the harbour.</div></div></div></div>
<div class="snippet" data-type="web" data-pos="2"><a href="https://search.brave.com/goggles">Goggles</a><div class="title">Brave's own page</div></div>`;
const braveCheck = `<html><body><h1>Please verify you are human</h1><div id="captcha"></div></body></html>`;

test("each engine's results page reads into titles, links and snippets", () => {
  assert.deepEqual(parseDuckDuckGo(200, ddgPage), [
    { title: "Harbour Line & fares", url: "https://fares.example.org/harbour-line", snippet: "Singles from 4.20 each way · daily." },
  ]);
  assert.deepEqual(parseBrave(200, bravePage), [
    { title: "Kestrel Point crossings", url: "https://ferries.example.net/kestrel-point", snippet: "Crossings every 40 minutes from the harbour." },
  ]);
  assert.deepEqual(parseDuckDuckGo(200, "<html><body>No results.</body></html>"), []);
});

test("a check for bots is never read as an empty search", () => {
  assert.throws(() => parseDuckDuckGo(202, ddgCheck), BotCheck);
  assert.throws(() => parseDuckDuckGo(200, ddgCheck), BotCheck);
  assert.throws(() => parseBrave(200, braveCheck), BotCheck);
  assert.throws(() => parseBrave(429, ""), BotCheck);
});

// A stand-in for the web: each engine's next answer, and a clock to move.
function world(answers) {
  const asked = [];
  let clock = 0;
  const get = async (url) => {
    const name = url.includes("duckduckgo") ? "ddg" : "brave";
    asked.push(name);
    const next = answers[name].length > 1 ? answers[name].shift() : answers[name][0];
    if (next instanceof Error) throw next;
    return next;
  };
  const pass = (ms) => { clock += ms; };
  return { asked, get, now: () => clock, wait: async (ms) => pass(ms), pass };
}
const quiet = (fn) => async () => { const warn = console.warn; console.warn = () => {}; try { await fn(); } finally { console.warn = warn; } };

test("a check rests that engine and the next one answers", quiet(async () => {
  const w = world({ ddg: [{ statusCode: 202, body: ddgCheck }, { statusCode: 200, body: ddgPage }], brave: [{ statusCode: 200, body: bravePage }, { statusCode: 200, body: bravePage }, { statusCode: 200, body: braveCheck }] });
  const search = createFreeSearch({ get: w.get, now: w.now, wait: w.wait });
  const first = await search("kestrel point ferry");
  assert.equal(first.source, "Brave");
  assert.deepEqual(w.asked, ["ddg", "brave"]);

  w.asked.length = 0;
  await search("harbour line fares");
  assert.deepEqual(w.asked, ["brave"], "DuckDuckGo is resting, and Brave answered last so goes first");

  w.pass(16 * 60000);
  w.asked.length = 0;
  const later = await search("harbour line fares");
  assert.deepEqual(w.asked, ["brave", "ddg"]);
  assert.equal(later.source, "DuckDuckGo", "after its rest DuckDuckGo answers again, now Brave is checking");
}));

test("rests grow while an engine keeps checking, and search fails only when every engine is resting", quiet(async () => {
  const w = world({ ddg: [{ statusCode: 202, body: ddgCheck }], brave: [{ statusCode: 200, body: braveCheck }] });
  const search = createFreeSearch({ get: w.get, now: w.now, wait: w.wait });
  await assert.rejects(search("harbour line"), /web search is unavailable.*searching again will not help/);
  w.asked.length = 0;
  await assert.rejects(search("harbour line"), /web search is unavailable/);
  assert.deepEqual(w.asked, [], "nothing is asked while both rest");
  w.pass(15 * 60000 + 1);
  await assert.rejects(search("harbour line"), /unavailable/);
  w.asked.length = 0;
  w.pass(15 * 60000 + 1);
  await assert.rejects(search("harbour line"), /unavailable/);
  assert.deepEqual(w.asked, [], "the second rest is twice as long");
}));

test("requests to one engine are spaced out, and a repeated search is answered from memory", async () => {
  const w = world({ ddg: [{ statusCode: 200, body: ddgPage }], brave: [{ statusCode: 200, body: bravePage }] });
  const waited = [];
  const search = createFreeSearch({ get: w.get, now: w.now, wait: async (ms) => { waited.push(ms); w.pass(ms); } });
  await search("harbour line fares");
  await search("kestrel point");
  assert.deepEqual(waited, [2000], "the second request to DuckDuckGo waits out the gap");
  w.asked.length = 0;
  await search("Harbour line fares ");
  assert.deepEqual(w.asked, [], "the same search within ten minutes is not asked again");
  w.pass(10 * 60000);
  await search("harbour line fares");
  assert.deepEqual(w.asked, ["ddg"]);
});

test("an engine that is slow to answer is passed over", quiet(async () => {
  const w = world({ ddg: [{ statusCode: 200, body: ddgCheck }], brave: [{ statusCode: 200, body: bravePage }] });
  const slow = async (url) => url.includes("brave") ? new Promise(() => {}) : w.get(url);
  await assert.rejects(createFreeSearch({ get: slow, now: w.now, wait: w.wait, answerWithinMs: 20 })("harbour"), /web search failed: Brave took too long/);
}));

test("an engine that cannot be reached is skipped, and its error is named if no engine answers", quiet(async () => {
  const w = world({ ddg: [new Error("Request timed out")], brave: [{ statusCode: 200, body: bravePage }] });
  assert.equal((await createFreeSearch({ get: w.get, now: w.now, wait: w.wait })("kestrel")).source, "Brave");
  const down = world({ ddg: [new Error("Request timed out")], brave: [new Error("Request timed out")] });
  await assert.rejects(createFreeSearch({ get: down.get, now: down.now, wait: down.wait })("kestrel"), /web search failed: Request timed out/);
}));

test("a stopped task sends the answer it drafted, not the line beside its last tool call", () => {
  const messages = [
    { role: "user", content: "Harbour Line to Kestrel Point and back, cost and time?" },
    { role: "assistant", content: [{ type: "text", text: "Checking the fare table." }, { type: "tool_use", id: "t1", name: "web_fetch", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Single 4.20" }] },
    { role: "assistant", content: [{ type: "text", text: "8.40 return, about 50 minutes each way." }] },
    { role: "user", content: "VERIFICATION (attempt 1/2): the return fare is not supported." },
    { role: "assistant", content: [{ type: "text", text: "I need to sort the fare evidence first." }, { type: "tool_use", id: "t2", name: "web_fetch", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "Return 8.40" }] },
  ];
  assert.equal(writtenAnswer(messages).content[0].text, "8.40 return, about 50 minutes each way.");
  assert.equal(writtenAnswer(messages.slice(0, 3)), null, "with no answer drafted, the write-up from evidence takes over");
  assert.equal(writtenAnswer([{ role: "assistant", content: "Plain string answer." }]).content, "Plain string answer.");
});

test("a page that is really a check for bots is told apart from a page", () => {
  const { looksBlocked } = require("../lib/blocked-page");
  const cloudflare = `<html><head><title>Just a moment...</title></head><body><div>Checking your browser before accessing fares.example.org</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;
  assert.equal(looksBlocked(cloudflare), true);
  assert.equal(looksBlocked("<html><body><p>Access Denied</p><p>Reference #18.2f</p></body></html>"), true);
  assert.equal(looksBlocked(`<html><body><h1>Sign in</h1><p>This form is protected by reCAPTCHA.</p></body></html>`), false, "a short page that only mentions a captcha is a page");
  const article = "<html><body><article>" + "Harbour Line timetables change in spring. ".repeat(60) + "Sites sometimes show a captcha or say just a moment... when busy.</article></body></html>";
  assert.equal(looksBlocked(article), false, "a long article that mentions checks is a page");
});
