// "Email" as a saved agent's destination: its results go to the person's own
// inbox, sent from their own connected Google or Microsoft account to that
// same address. No ClosedHand mail service sits in between, and a message to
// yourself needs no confirmation (lib/self-send.js).

// Email here is plain text, so Markdown becomes the plain form of itself.
function plainText(text) {
  return require("./follow-on").joined(text)
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, (_, label, url) => label === url ? url : `${label}: ${url}`);
}

async function sendToSelf(subject, text) {
  const store = require("./context").activeUserStore;
  const pick = (list) => list.find((a) => a.primary && a.email) || list.find((a) => a.email);
  const google = pick(require("./services/google").listGoogleAccounts(store));
  const microsoft = google ? null : pick(require("./services/microsoft").listMicrosoftAccounts(store));
  const account = google || microsoft;
  if (!account) throw new Error("No Google or Microsoft account is connected to send the results from.");
  const { handleInternalTool } = require("./tools/handlers");
  const result = await handleInternalTool(google ? "gmail_send" : "outlook_send",
    { to: account.email, account: account.email, subject: String(subject || "Your agent's results").slice(0, 150), body: plainText(text) });
  if (!result || result.error) throw new Error(result?.error || "The email was not sent.");
  return result.messageId || account.email;
}

module.exports = { sendToSelf, plainText };
