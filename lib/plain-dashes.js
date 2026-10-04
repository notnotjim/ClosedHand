// ClosedHand writes without emdashes: commas, colons and full stops instead.
// The model is asked to (response-presentation.js); this makes it so for
// every chat reply, background answer, report and message ClosedHand sends,
// whatever the model did. Code, and number ranges such as 10–12, are left as
// they are.
function noEmDashes(text) {
  if (typeof text !== "string" || !/\u2014|[ \t]\u2013[ \t]/.test(text)) return text;
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part
    .replace(/^([ \t]*)[\u2014\u2013][ \t]+/gm, "$1- ")      // used as a bullet
    .replace(/[ \t]*\u2014[ \t]*$/gm, ":")               // ending a line that leads into the next
    .replace(/[ \t]*\u2014[ \t]*/g, ", ")                // anywhere else
    .replace(/[ \t]+\u2013[ \t]+/g, ", ")                // a spaced en dash standing in for one
    .replace(/, ([.,;:!?)])/g, "$1")                // a comma left before other punctuation
  ).join("");
}

module.exports = { noEmDashes };
