// lib/http.js — Generic HTTP helpers (no internal deps)

const https = require("https");
const http = require("http");
const { isBlockedUrl } = require("./ssrf");

// Generic HTTP GET helper — handles http/https, redirects, and headers
function httpGet(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirect = res.headers.location;
        if (redirect.startsWith("/")) {
          const parsed = new URL(url);
          redirect = `${parsed.protocol}//${parsed.host}${redirect}`;
        }
        if (isBlockedUrl(redirect)) return reject(new Error("Redirect blocked: target is a private/internal address"));
        return httpGet(redirect, headers, maxRedirects - 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        // Detect charset from Content-Type header or HTML meta
        const ct = (res.headers["content-type"] || "").toLowerCase();
        let body;
        const charsetMatch = ct.match(/charset=([^\s;]+)/);
        const charset = charsetMatch ? charsetMatch[1].replace(/['"]/g, "") : null;
        if (charset && charset !== "utf-8" && charset !== "utf8") {
          try {
            const { TextDecoder } = require("util");
            const decoder = new TextDecoder(charset);
            body = decoder.decode(buf);
          } catch (e) {
            body = buf.toString("utf-8"); // fallback
          }
        } else {
          body = buf.toString("utf-8");
          // Check for meta charset in HTML if no header charset
          if (!charset && body.includes("<")) {
            const metaMatch = body.match(/charset=["']?([^"'\s;>]+)/i);
            if (metaMatch && metaMatch[1].toLowerCase() !== "utf-8") {
              try {
                const { TextDecoder } = require("util");
                const decoder = new TextDecoder(metaMatch[1]);
                body = decoder.decode(buf);
              } catch (e) { /* keep utf-8 version */ }
            }
          }
        }
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

// Binary version of httpGet — returns raw Buffer instead of string
function httpGetBuffer(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirect = res.headers.location;
        if (redirect.startsWith("/")) {
          const parsed = new URL(url);
          redirect = `${parsed.protocol}//${parsed.host}${redirect}`;
        }
        if (isBlockedUrl(redirect)) return reject(new Error("Redirect blocked: target is a private/internal address"));
        return httpGetBuffer(redirect, headers, maxRedirects - 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, buffer: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

// General-purpose HTTP request helper — supports all methods, JSON body, 20s timeout
// timeoutMs is a parameter because callers differ wildly: a sandbox browser
// action loading a heavy page legitimately needs a minute, while a metadata
// lookup should fail fast. A single hardcoded value silently killed the former.
function makeRawRequest(method, url, body = null, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;

    const reqHeaders = { Accept: "application/json", ...headers };
    let postData = null;
    if (body) {
      postData = typeof body === "string" ? body : JSON.stringify(body);
      if (!reqHeaders["Content-Type"]) reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(postData);
    }

    const req = lib.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method.toUpperCase(),
      headers: reqHeaders,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.substring(0, 500)}`));
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve({ raw: text });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Request timed out after ${Math.round(timeoutMs/1000)}s`)); });
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = { httpGet, httpGetBuffer, makeRawRequest };
