// Mail to the person's own accounts goes without "yes or no"; anything that
// could reach someone else still asks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sendsOnlyToSelf } = require("../lib/self-send");

const store = { connections: {
  google: { metadata: { email: "sam@example.com" } },
  google_extra_work: { metadata: { email: "Sam@Work.example" } },
  microsoft: { metadata: { email: "sam@outlook.example" } },
}, profile: {} };

test("a new message only to your own accounts needs no confirmation", () => {
  assert.equal(sendsOnlyToSelf("gmail_send", { to: "sam@example.com" }, store), true);
  assert.equal(sendsOnlyToSelf("outlook_send", { to: "Sam <sam@outlook.example>", cc: "sam@work.example" }, store), true);
});

test("anyone else, a reply, or no recipient still asks", () => {
  assert.equal(sendsOnlyToSelf("gmail_send", { to: "sam@example.com", cc: "mei@example.com" }, store), false);
  assert.equal(sendsOnlyToSelf("gmail_send", { to: "sam@example.com", bcc: "x@example.org" }, store), false);
  assert.equal(sendsOnlyToSelf("gmail_reply", { to: "sam@example.com" }, store), false, "a reply goes to the thread");
  assert.equal(sendsOnlyToSelf("gmail_send", { to: "" }, store), false);
  assert.equal(sendsOnlyToSelf("gmail_send", { to: "sam@example.com" }, { connections: {} }), false, "no connected account, no exception");
});

test("both the chat and background agents use it", () => {
  const fs = require("node:fs"), path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  assert.match(read("lib/engine.js"), /require\("\.\/self-send"\)\.sendsOnlyToSelf\(block\.name, block\.input, ctx\.activeUserStore\)/);
  assert.match(read("lib/agents.js"), /!require\("\.\/self-send"\)\.sendsOnlyToSelf\(block\.name, block\.input, userStore\)/);
});
