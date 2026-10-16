// Files kept in the Postgres database the bot and the dashboard already share,
// for hosts where they cannot share a folder (Railway gives each service its
// own volume). STORAGE_DRIVER=pg selects it; Docker and the Mac app keep the
// local folder (storage-driver-local.js), whose interface this matches.
// The table is storage_objects (migration 060).
//
// Vendored duplicate: lib/storage-driver-pg.js and webapp/storage-driver-pg.js
// must stay byte-identical.

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// The same names the local driver accepts: no climbing out with "..", no
// absolute paths, no empty parts.
function validKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 1024 && !key.startsWith("/") &&
    key.split("/").every((part) => part && part !== "." && part !== "..");
}

function createPgStorage({ pool, baseUrl } = {}) {
  if (!pool) throw new Error("The database storage needs the database connection.");
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return {
    from(bucket) {
      return {
        // The app always passes upsert:true, so a plain overwrite matches.
        async upload(key, body, opts = {}) {
          if (!validKey(key)) return { data: null, error: { message: "Invalid storage path" } };
          try {
            await pool.query(
              `INSERT INTO storage_objects (bucket, key, content_type, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (bucket, key) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
              [bucket, key, opts.contentType || null, Buffer.isBuffer(body) ? body : Buffer.from(body)]);
            return { data: { path: key }, error: null };
          } catch (e) {
            return { data: null, error: { message: e.message } };
          }
        },
        async download(key) {
          if (!validKey(key)) return { data: null, error: { message: "Invalid storage path" } };
          try {
            const row = (await pool.query("SELECT data, content_type FROM storage_objects WHERE bucket = $1 AND key = $2", [bucket, key])).rows[0];
            if (!row) return { data: null, error: { message: "Object not found" } };
            return { data: { arrayBuffer: async () => toArrayBuffer(row.data), type: row.content_type || "" }, error: null };
          } catch (e) {
            return { data: null, error: { message: e.message } };
          }
        },
        async remove(keys) {
          const arr = Array.isArray(keys) ? keys : [keys];
          try {
            const valid = arr.filter(validKey);
            if (valid.length) await pool.query("DELETE FROM storage_objects WHERE bucket = $1 AND key = ANY($2::text[])", [bucket, valid]);
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

module.exports = { createPgStorage, validKey };
