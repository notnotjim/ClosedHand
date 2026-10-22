// What a routine can wait for, in one list: lib/watches.js runs the watches,
// webapp/server.js saves them, and the dashboard's routine form offers them
// from here. Every kind of item the sync stores can be watched as it
// arrives; a kind with a time of its own (a calendar event, a booking) can
// also be watched at a time set by it: an hour before each meeting, the day
// after each stay. Adding a kind is one line here. Vendored byte-identical
// in lib/ and webapp/ (scripts/check-vendored-identical.js).

const KINDS = {
  email: { types: ["email"], noun: "email", plural: "Emails", grace: 10 * 60 * 1000 },
  messages: { types: ["message"], noun: "chat message", plural: "Chat messages", grace: 10 * 60 * 1000 },
  calendar: { types: ["event"], noun: "calendar event", plural: "Calendar events", grace: 0, timed: true },
  bank: { types: ["bank_transaction"], noun: "bank transaction", plural: "Bank transactions", grace: 48 * 3600 * 1000 },
  notes: { types: ["page"], noun: "Notion page", plural: "Notion pages", grace: 0 },
  bookings: { table: "bookings", noun: "booking", plural: "Bookings", grace: 0, timed: true },
};

const ALIASES = {
  email: "email", emails: "email", mail: "email", gmail: "email", outlook: "email", inbox: "email",
  messages: "messages", message: "messages", chat: "messages", slack: "messages", whatsapp: "messages",
  calendar: "calendar", event: "calendar", events: "calendar", meeting: "calendar", meetings: "calendar", gcal: "calendar",
  bank: "bank", banks: "bank", bank_transaction: "bank", transaction: "bank", transactions: "bank", payment: "bank", payments: "bank",
  notes: "notes", notion: "notes", page: "notes", pages: "notes",
  bookings: "bookings", booking: "bookings", flight: "bookings", flights: "bookings", hotel: "bookings", stay: "bookings", trip: "bookings",
};

// When it runs: as an item arrives, or a set time before an item starts or
// after it ends (kinds with a time only).
const WHEN = ["arrives", "before", "after"];

function kindOf(name) {
  return ALIASES[String(name || "email").trim().toLowerCase()] || null;
}

function offsetWords(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m % 1440 === 0 && m >= 1440) return m === 1440 ? "a day" : `${m / 1440} days`;
  if (m % 60 === 0 && m >= 60) return m === 60 ? "an hour" : `${m / 60} hours`;
  return `${m} minutes`;
}

// The routine's trigger in words: "each new email", "an hour before each
// calendar event", "as each booking ends".
function describe(source, when = "arrives", minutes = 0) {
  const kind = KINDS[source] || KINDS.email;
  if (when === "before") return minutes ? `${offsetWords(minutes)} before each ${kind.noun}` : `as each ${kind.noun} starts`;
  if (when === "after") return minutes ? `${offsetWords(minutes)} after each ${kind.noun} ends` : `as each ${kind.noun} ends`;
  return `each new ${kind.noun}`;
}

// What the routine form lists.
function choices() {
  return Object.entries(KINDS).map(([id, k]) => ({ id, label: k.plural, timed: !!k.timed }));
}

module.exports = { KINDS, WHEN, kindOf, offsetWords, describe, choices };
