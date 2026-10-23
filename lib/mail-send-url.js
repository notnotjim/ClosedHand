// lib/mail-send-url.js: an address that sends mail when posted to.
//
// Mail is only ever sent through the tools that ask the person first
// (gmail_send, gmail_reply, gmail_send_draft and the Outlook and IMAP ones).
// A raw API call to one of these addresses would send without that, so the
// chat, background tasks and schedules refuse it. A draft's own send address
// counts: two emails once went out that way, straight from drafts, with nobody
// asked. So do Microsoft's reply and forward, which send at once.
function isMailSendUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/(?:messages|drafts)\/send\b/.test(url)
    || /graph\.microsoft\.com\/.*\/(?:sendMail|messages\/[^/?#]+\/(?:send|reply|replyAll|forward))(?:[?#]|$)/i.test(url)
    || /\/(?:messages|drafts)\/send(?:[?#]|$)/.test(url);
}

// Writing a Gmail draft straight through the API, which skips what the draft
// tools do: keep it in its thread, keep the person's own edits and set a
// send-as From. A raw rewrite once moved a reply out of its thread.
function isDraftWrite(method, url) {
  if (!url || typeof url !== "string" || !/^(POST|PUT|PATCH)$/i.test(String(method || ""))) return false;
  return /gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/drafts(?:\/[^/?#]+)?(?:[?#]|$)/.test(url) && !isMailSendUrl(url);
}

module.exports = { isMailSendUrl, isDraftWrite };
