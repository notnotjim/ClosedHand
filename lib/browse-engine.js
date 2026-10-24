// lib/browse-engine.js: which of the sandbox computer's two browsers a step
// runs in.
//
// The visible browser is the Chrome the person watches on the Computers tab.
// The hidden one has no window: it reads faster, takes several pages at once,
// stays out of the person's way, and carries the visible one's logins (its
// cookies are copied in for every request and handed back after). Closedhand
// picks per job, as the LLM says with `browser`; code knows the sites that
// watch for automation and can restrict an account, which always run visible;
// and a site that answers the hidden browser with a check for bots moves to
// the visible one, where most such checks pass by themselves, for the rest of
// the day.

const { looksBlocked } = require("./blocked-page");

const VISIBLE_SITES = /(^|\.)(instagram\.com|facebook\.com|messenger\.com|threads\.net|tiktok\.com|linkedin\.com|x\.com|twitter\.com|snapchat\.com|pinterest\.com|web\.whatsapp\.com)$/i;
const MOVED_FOR_MS = 24 * 60 * 60 * 1000;

const _state = new Map(); // userId -> { engine, lastUrl: { visible, headless }, moved: Map(host -> until) }

function stateOf(userId) {
  if (!_state.has(userId)) _state.set(userId, { engine: null, lastUrl: {}, moved: new Map() });
  return _state.get(userId);
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

// The address a step or a sequence opens first.
function firstUrl(input) {
  if (input && input.url) return input.url;
  const steps = input && Array.isArray(input.steps) ? input.steps : [];
  const withUrl = steps.find((s) => s && s.url);
  if (withUrl) return withUrl.url;
  const urls = input && Array.isArray(input.urls) ? input.urls : [];
  return urls[0] || null;
}

function visibleOnly(userId, host) {
  if (!host) return false;
  if (VISIBLE_SITES.test(host)) return true;
  const until = stateOf(userId).moved.get(host);
  return !!until && until > Date.now();
}

function choose(userId, input = {}) {
  const st = stateOf(userId);
  if (input.action === "fill_card" || input.action === "fill_address") return st.engine || "visible"; // where the checkout is
  const host = hostOf(firstUrl(input));
  if (visibleOnly(userId, host)) return "visible";
  if (input.browser === "visible" || input.browser === "headless") return input.browser;
  if (!host) return st.engine || "headless"; // a follow-up stays where the job is
  return "headless";
}

// A step in the other browser than the last one, with no address of its own,
// picks up on the page the job was on.
function carryOver(userId, engine) {
  const st = stateOf(userId);
  if (!st.engine || st.engine === engine) return null;
  return st.lastUrl[st.engine] || null;
}

function ran(userId, engine, url) {
  const st = stateOf(userId);
  st.engine = engine;
  if (url && /^https?:/i.test(url)) st.lastUrl[engine] = url;
}

function moveToVisible(userId, host) {
  if (host) stateOf(userId).moved.set(host, Date.now() + MOVED_FOR_MS);
}

// A page that is a check for bots rather than the page (lib/blocked-page.js),
// or one the site refused outright.
function wasStopped(probe) {
  if (!probe) return false;
  if (probe.status === 403 || probe.status === 429) return true;
  return looksBlocked(probe.html || "", probe.text);
}

function needsPerson(host) {
  return `${host || "The site"} wants a person to show they are human. Ask the person to open the Computers tab and do it there, once, then carry on.`;
}

// Several pages at once. The hidden browser reads them together, each in a
// tab of its own; a page on a site that runs visible, or that stops the
// hidden browser with a check, is read in the visible one, one at a time.
// `browse` sends one request to the sandbox computer (lib/sandbox.js).
async function readPages(userId, urls, browse) {
  const read = new Map();
  const visible = urls.filter((u) => visibleOnly(userId, hostOf(u)));
  const hidden = urls.filter((u) => !visible.includes(u));
  if (hidden.length) {
    const answer = await browse({ op: "read_pages", urls: hidden, engine: "headless" });
    if (answer && answer.error) return { error: answer.error };
    for (const page of (answer && answer.result && answer.result.pages) || []) {
      if (!page.error && wasStopped(page.probe)) {
        moveToVisible(userId, hostOf(page.url || page.asked));
        visible.push(page.asked);
        continue;
      }
      const { probe, ...kept } = page;
      read.set(page.asked, kept);
    }
  }
  for (const u of visible) {
    const answer = await browse({ op: "step", engine: "visible", step: { action: "page_text", url: u, probe: true } });
    if (answer && answer.error) { read.set(u, { asked: u, error: answer.error }); continue; }
    const r = (answer && answer.result) || {};
    const page = { asked: u, url: r.url, title: r.title, text: String(r.text || "").slice(0, 6000), read_in: "visible" };
    if (wasStopped(r.probe)) page.needs_person = needsPerson(hostOf(r.url || u));
    read.set(u, page);
    ran(userId, "visible", r.url);
  }
  return { pages: urls.map((u) => read.get(u) || { asked: u, error: "Not read." }) };
}

module.exports = { VISIBLE_SITES, choose, carryOver, ran, moveToVisible, wasStopped, visibleOnly, hostOf, needsPerson, readPages, _reset: () => _state.clear() };
