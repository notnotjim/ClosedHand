// lib/blocked-page.js -- is this page a check for bots rather than the page?
//
// Sites behind Cloudflare, Akamai, DataDome and the like often answer an
// automated request with a short "Just a moment…" or captcha page, sometimes
// with an ordinary 200. Read as content, it tells the model the page says
// nothing, the same mistake as a blocked search read as "no results". Markers
// left by the check services decide it on their own; the wording of a check
// counts only on a short page, so an article that mentions captchas is not
// mistaken for one.
// Ordinary pages carry some of these services' scripts too (Cloudflare's
// challenge-platform/scripts, Incapsula's resource script), so only the
// parts a check page alone has count.
const SERVICE_MARKERS = /challenge-platform\/h\/|cf_chl_opt|geo\.captcha-delivery\.com|px-captcha|Incapsula incident ID|bots use DuckDuckGo|scheduled a captcha/i;
const CHECK_WORDING = /just a moment\.\.\.|checking your browser|verify (that )?you are (a )?human|enable javascript and cookies to continue|attention required|access denied|are you a robot|unusual traffic|complete the captcha|solve the captcha/i;

function looksBlocked(body, text) {
  const raw = String(body || "");
  if (SERVICE_MARKERS.test(raw)) return true;
  const words = text !== undefined ? String(text) : raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return words.length < 1500 && CHECK_WORDING.test(words);
}

module.exports = { looksBlocked };
