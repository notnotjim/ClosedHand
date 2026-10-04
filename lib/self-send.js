// A new message whose every recipient is one of the person's own connected
// mail accounts goes without a "yes or no": nobody else can receive it.
// Replies are left out, because a reply goes to the thread, not to an address
// that can be checked here.
const NEW_SENDS = new Set(["gmail_send", "outlook_send", "send_mail"]);

function addresses(field) {
  return String(field || "").split(/[,;]/).map((part) => {
    const angled = part.match(/<([^>]+)>/);
    return (angled ? angled[1] : part).trim().toLowerCase();
  }).filter(Boolean);
}

function ownAddresses(store) {
  const own = new Set();
  const accounts = [
    ...require("./services/google").listGoogleAccounts(store),
    ...require("./services/microsoft").listMicrosoftAccounts(store),
  ];
  for (const a of accounts) if (a.email) own.add(String(a.email).trim().toLowerCase());
  return own;
}

function sendsOnlyToSelf(toolName, input, store) {
  if (!NEW_SENDS.has(toolName) || !store) return false;
  const recipients = [...addresses(input?.to), ...addresses(input?.cc), ...addresses(input?.bcc)];
  if (!recipients.length) return false;
  const own = ownAddresses(store);
  return recipients.every((a) => own.has(a));
}

module.exports = { sendsOnlyToSelf, addresses };
