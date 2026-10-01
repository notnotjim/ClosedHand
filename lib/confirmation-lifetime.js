// A question asked in chat has a lifetime. Once it has passed, a "yes" must not
// fire the old action, and the task record must stop waiting for an answer.
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
function askedAt(pending) { return pending?.asked?.at || pending?.pausedAt || pending?.askedAt || null; }
function isLapsed(pending, now = Date.now()) { const at = askedAt(pending); return !!at && now - at > CONFIRMATION_TTL_MS; }
const NOTES = {
  moved_on: "You moved on without answering, so this was dropped.",
  lapsed: "You did not answer within a day, so this was dropped.",
  unresumable: "This was waiting for an answer but could not be picked up again, so it was dropped.",
};
function droppedNote(reason) { return NOTES[reason] || NOTES.moved_on; }
module.exports = { CONFIRMATION_TTL_MS, askedAt, isLapsed, droppedNote };
