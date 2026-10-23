// lib/mail-send-url.js: an address that sends mail when posted to.
//
// Mail is only ever sent through the tools that ask the person first
// (gmail_send, gmail_reply, gmail_send_draft and the Outlook and IMAP ones).
// A raw API call to one of these addresses would send without that, so the
// chat and background tasks refuse it. A draft's own send address counts: two
// emails once went out that way, straight from drafts, with nobody asked.
function isMailSendUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/(?:messages|drafts)\/send\b/.test(url)
    || /graph\.microsoft\.com\/.*\/(?:sendMail|messages\/[^/?#]+\/send)(?:[?#]|$)/i.test(url)
    || /\/(?:messages|drafts)\/send(?:[?#]|$)/.test(url);
}

module.exports = { isMailSendUrl };
