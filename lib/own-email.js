// "Email" as a saved agent's destination: its results come from the
// assistant's own email address to its owner (lib/assistant-email.js), as a
// new conversation the owner can reply to. With the address turned off,
// delivery fails with a plain reason and the dashboard asks for it to be
// turned on.
async function sendToSelf(subject, text) {
  const userId = require("./context").activeUserId;
  if (!userId) throw new Error("No user to send the results to.");
  return require("./assistant-email").sendToOwner(userId, subject, text);
}

module.exports = { sendToSelf };
