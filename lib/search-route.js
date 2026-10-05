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

// A search that names no source is a search of everything synced, as
// search_cache promises: mail through its own pipeline, and WhatsApp, Slack,
// Notion and the rest alongside, under other_sources. Without this, "dentist
// appointment" searched mail alone and missed the booking made in a WhatsApp
// chat. A mail-only filter (unread, attachments) or "*" keeps it mail.
async function withOtherSources(input, mail, searchOthers) {
  const query = String(input.query || "").trim();
  if (input.source || input.type || input.unread_only || input.has_attachment || !query || query === "*") return mail;
  const others = await searchOthers(query, input.max_results || 20).catch(() => []);
  return others.length ? { ...mail, other_sources: others } : mail;
}

module.exports = { wantsMail, withOtherSources, MAIL_SOURCE };
