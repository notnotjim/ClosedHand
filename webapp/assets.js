// Content-stamped scripts and stylesheets.
//
// Every "/name.js" or "/name.css" reference in a served page is rewritten to
// "/name.js?v=<hash of the file's bytes>". A changed file therefore gets a new
// address, so no stored copy, in a browser or at Cloudflare in front of a
// tunnel, can keep handing out the old one. A request that carries the current
// hash may be kept for a year; one without a hash must be checked every time.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const publicDir = path.join(__dirname, "public");
const viewsDir = path.join(__dirname, "views");
const hashes = new Map();
const pages = new Map();
function version(urlPath) {
  const file = path.resolve(publicDir, "." + urlPath);
  if (!file.startsWith(publicDir + path.sep)) return null;
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  let entry = hashes.get(file);
  if (!entry || entry.mtime !== stat.mtimeMs || entry.size !== stat.size) {
    entry = { mtime: stat.mtimeMs, size: stat.size, hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12) };
    hashes.set(file, entry);
  }
  return entry.hash;
}
function stamp(html) {
  return html.replace(/((?:src|href)=")(\/[^"?#]+\.(?:js|css))"/g, (match, prefix, urlPath) => {
    const v = version(urlPath);
    return v ? prefix + urlPath + "?v=" + v + '"' : match;
  });
}
// Where Closedhand runs. Moved to Railway (Go always-on), it lives in the
// person's own Railway account, not on their computer: a sentence that says
// "your computer" carries its Railway wording in data-railway, put in place
// here, and the page is marked data-host="railway" for what its scripts write.
const onRailway = !!process.env.RAILWAY_ENVIRONMENT_ID;
function forHost(html, railway = onRailway) {
  if (!railway) return html;
  return html
    .replace(/(<([a-z][a-z0-9]*)\b[^>]*?)\s+data-railway="([^"]*)"([^>]*>)[^<]*(<\/\2>)/gi, (match, open, tag, wording, rest, close) => open + rest + wording + close)
    .replace(/<html(?=[\s>])/i, '<html data-host="railway"');
}
function page(name) {
  const file = path.join(viewsDir, name);
  const stat = fs.statSync(file);
  let entry = pages.get(file);
  if (!entry || entry.mtime !== stat.mtimeMs) { entry = { mtime: stat.mtimeMs, html: forHost(fs.readFileSync(file, "utf8")) }; pages.set(file, entry); }
  return stamp(entry.html);
}
// Light or dark, as the person picked under Appearance in Settings
// (settings.appearance): put on every page as it is served, so theme.js sets
// the theme before anything is drawn. "device", or none yet, leaves it to the
// device. Kept here by the server (server.js) at start and on each change.
let appearance = "device";
function setAppearance(pick) { appearance = pick === "light" || pick === "dark" ? pick : "device"; }
function withAppearance(html) {
  return appearance === "device" ? html : html.replace(/<html(?=[\s>])/i, `<html data-theme-pick="${appearance}"`);
}
function sendPage(res, name, headers) { if (headers) res.set(headers); res.type("html").send(withAppearance(page(name))); }
// setHeaders for express.static: long-lived only when the address carries the current hash.
function cacheHeaders(res, file) {
  const urlPath = "/" + path.relative(publicDir, file).split(path.sep).join("/");
  const v = res.req?.query?.v;
  res.set("Cache-Control", v && v === version(urlPath) ? "public, max-age=31536000, immutable" : "no-cache");
}
module.exports = { version, stamp, forHost, sendPage, cacheHeaders, setAppearance, withAppearance };
