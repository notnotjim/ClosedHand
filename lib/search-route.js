// lib/search-route.js -- which search a cache lookup wants.
//
// search_cache has two paths: the mail pipeline and the universal one for
// everything else. The handler chose by type alone, so a call that named a
// source without a type ("source: whatsapp") went to mail and came back with
// Gmail. Only a mail source, or no source at all, is a mail search.
const MAIL_SOURCE = /^(gmail|outlook|imap|mail)/i;
function wantsMail({ type, source } = {}) {
  if (type) return type === "email";
  return !source || MAIL_SOURCE.test(String(source));
}
module.exports = { wantsMail, MAIL_SOURCE };
