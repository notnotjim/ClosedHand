// Text as a reader should get it. Characters that print nothing go: some
// senders pad the top of an email with hundreds of them (a booking
// confirmation opened with about 600), which spent a reader's budget before
// the booking itself began. Runs of spaces and blank lines shrink to one.
const INVISIBLE = /[\u034F\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;
function readable(text) {
  return String(text || "").replace(INVISIBLE, "").replace(/[ \t\u00A0\u2007\u202F]+/g, " ").replace(/ ?\n[\s]*/g, "\n").trim();
}

module.exports = { readable };
