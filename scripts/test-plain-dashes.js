// ClosedHand's own writing has no emdashes. The model is asked not to use
// them, and every reply, background answer, report and sent message has any
// that slip through turned into a comma, colon or bullet. Code and number
// ranges are left alone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { noEmDashes } = require("../lib/plain-dashes");
const EM = "—", EN = "–";

test("an emdash becomes the punctuation a careful writer would use", () => {
  assert.equal(noEmDashes(`Cà Phê Zoom ${EM} 169A Trần Hưng Đạo, open 06:00${EN}22:00.`), `Cà Phê Zoom, 169A Trần Hưng Đạo, open 06:00${EN}22:00.`);
  assert.equal(noEmDashes(`Two options${EM}both close.`), "Two options, both close.");
  assert.equal(noEmDashes(`It is cheap ${EM} £14 a night ${EM} and close.`), "It is cheap, £14 a night, and close.");
  assert.equal(noEmDashes(`Here is what I found ${EM}\n- one`), "Here is what I found:\n- one");
  assert.equal(noEmDashes(`${EM} first\n${EM} second`), "- first\n- second");
  assert.equal(noEmDashes(`Done ${EM}.`), "Done.");
  assert.equal(noEmDashes(`A spaced ${EN} en dash`), "A spaced, en dash");
});

test("code and ranges are left as written", () => {
  assert.equal(noEmDashes(`Use \`a ${EM} b\` here`), `Use \`a ${EM} b\` here`);
  assert.equal(noEmDashes("```\nx = 'a " + EM + " b'\n```"), "```\nx = 'a " + EM + " b'\n```");
  assert.equal(noEmDashes(`10${EN}12 October`), `10${EN}12 October`);
  assert.equal(noEmDashes(null), null);
});

test("every way ClosedHand writes to the person goes through it", () => {
  assert.match(read("lib/engine.js"), /\.trim\(\);\n\s*finalText = require\("\.\/plain-dashes"\)\.noEmDashes\(finalText\);/, "chat replies");
  assert.match(read("lib/engine.js"), /return require\("\.\/plain-dashes"\)\.noEmDashes\(line \|\|/, "the hand-over note");
  assert.match(read("lib/messaging.js"), /async function sendToPlatform\(platform, chatId, message\) \{\n  message = require\("\.\/plain-dashes"\)\.noEmDashes\(message\);/, "background answers, reminders and notices");
  assert.match(read("lib/tools/handlers.js"), /const title = noEmDashes\([\s\S]{0,80}const content = noEmDashes\(/, "reports");
  assert.match(read("lib/response-presentation.js"), /Write without emdashes \(the long dash\): use a comma, colon or full stop/);
  assert.doesNotMatch(read("lib/plain-dashes.js"), new RegExp(EM), "the rule's own code holds none either");
});
