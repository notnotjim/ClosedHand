// lib/ssrf.js — Shared SSRF protection utility

/**
 * Returns true if the given URL points to a private, internal, or otherwise
 * blocked address.  Used by web_fetch, api_request, and the HTTP redirect
 * follower to prevent Server-Side Request Forgery.
 */
function isBlockedUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();

    // Block private/internal IPs and metadata endpoints
    const blocked = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^0\./,
      /^\[::1?\]$/,
      /^\[fc/i,
      /^\[fd/i,
      /^\[fe80/i,
      /^\[::ffff:/i,
      /\.local$/i,
      /\.internal$/i,
      /\.localhost$/i,
      /metadata\.google/i,
      /\.compute\.internal$/i,
    ];

    if (blocked.some(r => r.test(hostname))) return true;
    if (parsed.port && !["80", "443", "8080", "8443"].includes(parsed.port)) return true;
    if (!["http:", "https:"].includes(parsed.protocol)) return true;

    return false;
  } catch {
    return true; // Block unparseable URLs
  }
}

module.exports = { isBlockedUrl };
