// lib/storage-driver-local.js — Local-disk storage, the OSS default.
//
// Emulates the subset of the supabase-js Storage API the app uses:
//   storage.from(bucket).upload(path, buffer, {contentType, upsert})
//   storage.from(bucket).download(path)   -> { data: { arrayBuffer() }, error }
//   storage.from(bucket).remove([paths])
//   storage.from(bucket).getPublicUrl(path) (sync) -> { data: { publicUrl } }
//
// Files live under <dir>/<bucket>/<path>. Buckets: `attachments` (private,
// fetched via download() behind an auth check) and `logos` (public, rendered in
// the browser via getPublicUrl → the app serves /storage/logos/* itself).
//
// One box, no external accounts. For multi-process (bot + webapp) or multi-host,
// point STORAGE_DIR at a shared volume, or use the optional S3 driver.
//
// Vendored duplicate: webapp/storage-driver-local.js must be kept in sync.

const fsp = require("fs/promises");
const path = require("path");

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// Resolve <root>/<bucket>/<key>, guaranteeing the result stays inside
// <root>/<bucket> (blocks `../` traversal). Exported for the public route.
function safeJoin(root, bucket, key) {
  const base = path.resolve(root, bucket);
  const full = path.resolve(base, key || "");
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error("Invalid storage path");
  }
  return full;
}

function createLocalStorage({ dir, baseUrl } = {}) {
  const root = path.resolve(dir || "./data/storage");
  const base = String(baseUrl || "").replace(/\/+$/, "");

  return {
    from(bucket) {
      return {
        // The app always passes upsert:true, so a plain overwrite matches.
        async upload(key, body, _opts = {}) {
          try {
            const full = safeJoin(root, bucket, key);
            await fsp.mkdir(path.dirname(full), { recursive: true });
            await fsp.writeFile(full, Buffer.isBuffer(body) ? body : Buffer.from(body));
            return { data: { path: key }, error: null };
          } catch (e) {
            return { data: null, error: { message: e.message } };
          }
        },
        async download(key) {
          try {
            const buf = await fsp.readFile(safeJoin(root, bucket, key));
            return { data: { arrayBuffer: async () => toArrayBuffer(buf) }, error: null };
          } catch (e) {
            return { data: null, error: { message: e.code === "ENOENT" ? "Object not found" : e.message } };
          }
        },
        async remove(keys) {
          const arr = Array.isArray(keys) ? keys : [keys];
          try {
            for (const k of arr) {
              try { await fsp.unlink(safeJoin(root, bucket, k)); }
              catch (e) { if (e.code !== "ENOENT") throw e; } // removing a missing object is not an error
            }
            return { data: arr.map((name) => ({ name })), error: null };
          } catch (e) {
            return { data: null, error: { message: e.message } };
          }
        },
        // Synchronous, like supabase-js. Only `logos` is actually served publicly.
        getPublicUrl(key) {
          return { data: { publicUrl: `${base}/storage/${bucket}/${key}` } };
        },
      };
    },
  };
}

module.exports = { createLocalStorage, safeJoin };
