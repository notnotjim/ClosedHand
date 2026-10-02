const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load just confirmationAnswer from lib/confirmation.js (its requires pull in the whole bot).
const src = fs.readFileSync(path.join(__dirname, "..", "lib", "confirmation.js"), "utf8");
const start = src.indexOf("const YES_CORE");
const end = src.indexOf("async function handleConfirmation");
const sandbox = {};
vm.runInNewContext(src.slice(start, end) + "\nthis.confirmationAnswer = confirmationAnswer;", sandbox);
const answer = sandbox.confirmationAnswer;

test("a natural yes to a send confirmation counts as yes", () => {
  for (const reply of ["yes", "Yes.", "Yes, send it.", "yes please", "OK, go ahead!", "send it", "Do it", "yep", "y", "Sure"]) {
    assert.equal(answer(reply), "yes", reply);
  }
});

test("a natural no counts as no", () => {
  for (const reply of ["no", "No.", "No thanks", "don't send it", "Do not send it", "cancel", "never mind", "not now", "n"]) {
    assert.equal(answer(reply), "no", reply);
  }
});

test("anything more than a plain answer is not an answer", () => {
  for (const reply of ["yes but change the subject", "send it to Sam instead", "yes no", "what does it say?", "", "ok but first check the date please"]) {
    assert.equal(answer(reply), null, reply);
  }
});

test("only a bare always approves a place for good", () => {
  assert.equal(answer("always"), "always");
  assert.equal(answer("Always."), "always");
  assert.equal(answer("yes always"), "yes");
});
