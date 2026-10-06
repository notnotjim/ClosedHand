// A page is an extra after the answer, never ahead of it. The page tool asks
// for its link at the end of the answer, and a reply still once sent the bare
// "Open the page" link first, as a message of its own, with the answer after.
// The order is set here, in code: every page link is lifted out and placed
// once, at the end.
const LINK = /\[Open the page\]\((\/page\/[^)\s]+|https?:\/\/[^)\s]+\/page\/[^)\s]+)\)|Open the page:\s*(\S+\/page\/\S+)/g;

function linkLast(text) {
  const s = String(text || "");
  const links = [];
  let m;
  while ((m = LINK.exec(s))) links.push(m[0]);
  LINK.lastIndex = 0;
  if (!links.length) return s;
  const body = s.replace(LINK, "")
    .replace(/^(\s*\[\[next\]\]\s*)+/, "")
    .replace(/(\s*\[\[next\]\]\s*)+$/, "")
    .replace(/(\S) {2,}(?=\S)/g, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!body) return links[0];
  return body + "\n\n" + links[0];
}

module.exports = { linkLast };
