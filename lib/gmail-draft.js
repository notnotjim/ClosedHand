// lib/gmail-draft.js — rewrite the words of a Gmail draft without disturbing
// anything else in it.
//
// Replacing the whole message is no better than starting a new draft: the point
// of editing one is that it already holds things the user does not want to
// rebuild, above all inline images, which live as separate MIME parts referenced
// by Content-ID from the HTML. Rebuild the message and those references break,
// or the images vanish entirely.
//
// So this does not parse and regenerate the message. It finds the text parts in
// the raw RFC 2822 and swaps their bodies, leaving every other byte, every
// boundary, every image part and every header exactly where it was.

/**
 * Collect every MIME boundary declared anywhere in the message, at any nesting
 * depth. A mail with inline images is typically multipart/mixed wrapping
 * multipart/related wrapping multipart/alternative, so there is never just one.
 */
function collectBoundaries(raw) {
  const found = new Set();
  const re = /boundary\s*=\s*"?([^";\r\n]+)"?/gi;
  let m;
  while ((m = re.exec(raw)) !== null) found.add(m[1].trim());
  return [...found];
}

function splitHeaders(block) {
  const idx = block.search(/\r?\n\r?\n/);
  if (idx === -1) return null;
  const sep = block.slice(idx).startsWith("\r\n") ? "\r\n\r\n" : "\n\n";
  return { headers: block.slice(0, idx), body: block.slice(idx + sep.length), sep };
}

function headerValue(headers, name) {
  const m = headers.match(new RegExp(`^${name}\\s*:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, "im"));
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : null;
}

/**
 * Replace the body of every text/plain and text/html part.
 *
 * The part's transfer encoding is rewritten to base64 rather than matching
 * whatever was there. Encoding the new text as base64 is always valid, and it
 * avoids hand rolling a quoted-printable encoder whose edge cases would corrupt
 * the very message this is meant to preserve.
 */
function replaceTextParts(raw, newText, newHtml, keepInlineImages = true) {
  const boundaries = collectBoundaries(raw);
  if (boundaries.length === 0) {
    // Single part message: no images to protect, so swap the body directly.
    const parsed = splitHeaders(raw);
    if (!parsed) return { raw, replaced: 0 };
    const isText = /text\/(plain|html)/i.test(headerValue(parsed.headers, "Content-Type") || "text/plain");
    if (!isText) return { raw, replaced: 0 };
    const headers = setEncodingBase64(parsed.headers);
    return { raw: headers + parsed.sep + b64(newText), replaced: 1 };
  }

  let out = raw;
  let replaced = 0;

  for (const boundary of boundaries) {
    const delim = `--${boundary}`;
    const segments = out.split(delim);
    if (segments.length < 2) continue;

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.startsWith("--")) continue; // closing delimiter, not a part
      const lead = seg.match(/^\r?\n/);
      if (!lead) continue;
      const block = seg.slice(lead[0].length);
      const parsed = splitHeaders(block);
      if (!parsed) continue;

      const ctype = headerValue(parsed.headers, "Content-Type") || "";
      if (!/^text\/(plain|html)/i.test(ctype)) continue;      // leave images and everything else alone
      if (/attachment/i.test(headerValue(parsed.headers, "Content-Disposition") || "")) continue;

      const isHtml = /^text\/html/i.test(ctype);
      let replacement;
      if (!isHtml) {
        replacement = newText;
      } else {
        // The HTML part is the one Gmail actually renders, so skipping it would
        // leave the user looking at their old wording. But it is also where the
        // inline images are referenced from, and new wording written by a model
        // that never saw the markup will not carry those references. Take the
        // new words, then re-attach the img tags the original had, so the
        // pictures stay visible instead of becoming orphaned parts.
        const original = decodePart(parsed.body, headerValue(parsed.headers, "Content-Transfer-Encoding"));
        const imgs = (original.match(/<img\b[^>]*src\s*=\s*["\']?cid:[^>]*>/gi) || []);
        const bodyHtml = newHtml || textToHtml(newText);
        if (!keepInlineImages) {
          // The user asked for the pictures gone. Re-attaching them here is the
          // tool arguing with the instruction, which is how an agent ends up
          // editing the same draft over and over.
          replacement = bodyHtml;
        } else {
          const missing = imgs.filter(tag => {
            const cid = (tag.match(/cid:([^"\'\s>]+)/i) || [])[1];
            return cid && !bodyHtml.includes(cid);
          });
          replacement = bodyHtml + (missing.length ? "\n" + missing.map(t => `<div>${t}</div>`).join("\n") : "");
        }
      }

      const headers = setEncodingBase64(parsed.headers);
      segments[i] = lead[0] + headers + parsed.sep + b64(replacement) + "\r\n";
      replaced++;
    }
    out = segments.join(delim);
  }
  return { raw: out, replaced };
}

function decodePart(body, encoding) {
  const enc = (encoding || "").toLowerCase();
  try {
    if (enc.includes("base64")) return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf-8");
    if (enc.includes("quoted-printable")) {
      return body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
  } catch (_) {}
  return body;
}

function textToHtml(text) {
  const esc = String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.split(/\r?\n/).map(l => `<div>${l || "<br>"}</div>`).join("\n");
}

function setEncodingBase64(headers) {
  if (/^content-transfer-encoding\s*:/im.test(headers)) {
    return headers.replace(/^content-transfer-encoding\s*:.*$/im, "Content-Transfer-Encoding: base64");
  }
  return headers + "\r\nContent-Transfer-Encoding: base64";
}

function b64(text) {
  // 76 character lines, as MIME expects
  return Buffer.from(text, "utf-8").toString("base64").replace(/(.{76})/g, "$1\r\n");
}

/** Swap a header's value, or add it if the message has none. */
function setHeader(raw, name, value) {
  const parsed = splitHeaders(raw);
  if (!parsed) return raw;
  const re = new RegExp(`^${name}\\s*:.*(?:\\r?\\n[ \\t].*)*$`, "im");
  const headers = re.test(parsed.headers)
    ? parsed.headers.replace(re, `${name}: ${value}`)
    : `${parsed.headers}\r\n${name}: ${value}`;
  return headers + parsed.sep + parsed.body;
}

/**
 * Drop MIME parts whose Content-ID nothing references any more.
 *
 * Leaving an unreferenced image part behind does not remove the picture, it
 * turns it into a stray attachment, which is not what "take the screenshots
 * out" means to anyone.
 */
function dropOrphanedInlineParts(raw) {
  let out = raw;
  let removed = 0;
  for (const boundary of collectBoundaries(out)) {
    const delim = `--${boundary}`;
    const segments = out.split(delim);
    const kept = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const lead = seg.match(/^\r?\n/);
      if (seg.startsWith("--") || !lead) { kept.push(seg); continue; }

      const parsed = splitHeaders(seg.slice(lead[0].length));
      const cidHeader = parsed && headerValue(parsed.headers, "Content-ID");
      const cid = cidHeader ? cidHeader.replace(/[<>]/g, "").trim() : null;
      if (!cid) { kept.push(seg); continue; }

      // Keep it if anything outside this part still points at it.
      const elsewhere = segments.filter((_, j) => j !== i).join(delim);
      if (elsewhere.includes(`cid:${cid}`)) { kept.push(seg); continue; }
      removed++;
    }
    out = kept.join(delim);
  }
  return { raw: out, removed };
}

module.exports = { replaceTextParts, setHeader, collectBoundaries, headerValue, splitHeaders, dropOrphanedInlineParts };
