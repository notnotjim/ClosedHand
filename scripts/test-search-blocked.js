// A background task once got no results from nine web searches and spent its
// whole step allowance working round them, then sent the one line it wrote
// before its last tool call instead of the answer it had drafted. DuckDuckGo
// had been showing the connection a check for bots, which was read as an empty
// search. Now that check is an error that says so, and a stopped task sends
// the last answer it wrote, not what it was about to do next.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseResults } = require("../lib/web-search-fallback");
const { writtenAnswer } = require("../lib/task-outcome");

const challenge = `<html><body><form id="challenge-form" class="anomaly-modal__form">
<p>Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.</p></form></body></html>`;
const resultsPage = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffares.example.org%2Fharbour-line&amp;rut=1">Harbour Line &amp; fares</a>
<a class="result__snippet" href="#">Singles from <b>4.20</b> each way.</a></div>`;

test("a check for bots is an error that says search is unavailable, never an empty list", () => {
  assert.throws(() => parseResults(202, challenge), /web search is unavailable.*searching again will not help/);
  assert.throws(() => parseResults(200, challenge), /web search is unavailable/);
  assert.throws(() => parseResults(503, "<html></html>"), /web search is unavailable/);
});

test("an ordinary results page still gives its results", () => {
  assert.deepEqual(parseResults(200, resultsPage), [
    { title: "Harbour Line & fares", url: "https://fares.example.org/harbour-line", snippet: "Singles from 4.20 each way." },
  ]);
  assert.deepEqual(parseResults(200, "<html><body>No results.</body></html>"), []);
});

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
