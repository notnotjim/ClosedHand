// Moving a Closedhand to another computer, such as one on Railway that is on
// all the time. Everything it holds is one database and the files in its
// storage folder, so a move sends both, in parts, to a new Closedhand that
// isn't set up yet, which takes them in one transaction.
//
// The source (this side, started from Settings):
//   1. Says hello with the new Closedhand's setup code, which only the person's
//      account at the host shows, and checks both run the same release.
//   2. Marks itself as moving (move-marker.js): its bot restarts and sits
//      still, so nothing changes or gets answered twice from here on.
//   3. Sends every row and file, read in one snapshot, in parts.
//   4. Once the other side has taken it all, stops its personal URL tunnel,
//      marks itself moved and tells the other side to start. From then on
//      this computer shows only a page saying where Closedhand went.
// Anything that fails before step 4 undoes step 2, and Closedhand carries on
// here as before.
//
// The destination (a Closedhand with SETUP_CODE and no password yet) keeps the
// parts in a temporary folder, then empties its own tables and fills them in
// one transaction, so it either has everything or nothing.
//
// Stored secrets never travel under either computer's own key: the source
// opens each one and seals it again under a one-time key sent with the last
// call, and the destination seals it under its own.
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { decryptString, encryptString, sealWith, openWith, PREFIX } = require("./crypto-tokens");

// Not carried across: signed-in browsers (the new computer signs in for
// itself) and the record of database updates (each keeps its own).
const LEFT_BEHIND = new Set(["dashboard_sessions", "schema_migrations"]);
// Settings about this computer rather than the person: how far its local
// models got downloading. The new computer downloads its own.
const SETTINGS_LEFT_BEHIND = ["LOCAL_MODELS_STATUS"];
// What the storage folder holds that moves: the person's files (the buckets
// the app keeps), and the bot's own WhatsApp session, so WhatsApp stays
// linked. Its local models and tool servers' scratch space stay behind.
const BUCKETS = ["attachments", "logos"];
const BOT_FOLDERS = ["wa-linked-session"];
// The bot's files wait in the database until the new bot writes them into its
// own storage folder, just before it restarts (lib/move-files.js).
const BOT_FILES_BUCKET = "_moved-bot-files";
const SEALED = new RegExp(PREFIX.replace(/[:]/g, "\\$&") + "[A-Za-z0-9+/]+=*", "g");
const ROWS_PER_FETCH = 500;
const ROWS_PER_INSERT = 200;
const PART_CHARS = 16 * 1024 * 1024; // before compression
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';

// The newest database update this computer has applied. Two Closedhands on
// the same release have the same one.
async function latestUpdate(pool) {
  const { rows } = await pool.query("SELECT max(filename) AS latest FROM schema_migrations");
  return rows[0].latest || null;
}

async function tablesToMove(client) {
  const { rows } = await client.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
  return rows.map((r) => r.name).filter((t) => !LEFT_BEHIND.has(t));
}

// "https://name.up.railway.app" from whatever was pasted. Only https, apart
// from this computer's own names for trying a move locally.
function cleanAddress(value) {
  let text = String(value || "").trim();
  if (!/^[a-z]+:\/\//i.test(text)) text = "https://" + text;
  let u;
  try { u = new URL(text); } catch (_) { return null; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  return u.origin;
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

// Every row of every table, then every stored file, one per line, read in one
// snapshot. Rows stay as Postgres wrote them (row_to_json), never parsed, so
// large numbers keep every digit; sealed secrets are swapped in the text.
//   R <tab> table <tab> row as JSON
//   F <tab> {"bucket","key"} <tab> base64   a file the app keeps
//   B <tab> {"path"} <tab> base64           one of the bot's own files
async function* exportLines(pool, { storageDir, transferKey }) {
  const reseal = (text) => text.replace(SEALED, (sealed) => {
    const plain = decryptString(sealed, "a secret being moved");
    return typeof plain === "string" ? sealWith(plain, transferKey) : sealed;
  });
  const client = await pool.connect();
  let ended = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const table of await tablesToMove(client)) {
      await client.query(`DECLARE move_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS r FROM ${ident(table)} t`);
      for (;;) {
        const { rows } = await client.query(`FETCH ${ROWS_PER_FETCH} FROM move_rows`);
        if (!rows.length) break;
        for (const { r } of rows) yield `R\t${table}\t${reseal(r)}`;
      }
      await client.query("CLOSE move_rows");
    }
    await client.query("COMMIT");
    ended = true;
  } finally {
    // Also when sending stopped part way: the snapshot ends before the
    // connection goes back to the pool.
    if (!ended) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  if (storageDir) {
    for (const bucket of BUCKETS) {
      for await (const { key, full } of filesUnder(path.join(storageDir, bucket))) {
        yield `F\t${JSON.stringify({ bucket, key })}\t${(await fsp.readFile(full)).toString("base64")}`;
      }
    }
    for (const folder of BOT_FOLDERS) {
      for await (const { key, full } of filesUnder(path.join(storageDir, folder))) {
        yield `B\t${JSON.stringify({ path: `${folder}/${key}` })}\t${(await fsp.readFile(full)).toString("base64")}`;
      }
    }
  }
}

// Every file under a folder, as a path inside it ("u1/note.txt").
async function* filesUnder(dir, prefix = "") {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const key = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) yield* filesUnder(full, key);
    else if (e.isFile()) yield { key, full };
  }
}

// Gathers lines into parts of about PART_CHARS and hands each over gzipped.
async function sendInParts(lines, sendPart, onProgress = () => {}) {
  let part = [], size = 0, n = 0, sent = 0;
  const flush = async () => {
    if (!part.length) return;
    await sendPart(n, zlib.gzipSync(Buffer.from(part.join("\n"), "utf8")));
    n += 1; sent += size; part = []; size = 0;
    onProgress({ parts: n, chars: sent });
  };
  for await (const line of lines) {
    part.push(line);
    size += line.length + 1;
    if (size >= PART_CHARS) await flush();
  }
  await flush();
  return n;
}

let outbound = null; // the one move this computer is making: { step, error, url, ... }

function outboundStatus() {
  if (!outbound) return { step: "idle" };
  const { step, error, url, parts, chars } = outbound;
  return { step, error: error || null, url: url || null, parts: parts || 0, sentMb: Math.round((chars || 0) / 1e6) };
}

// deps: pool, storageDir, marker, restartBot(), botMoveState(), stopTunnel(),
// personalUrl(), exitSoon(), fetch. Returns at once; status() follows it.
function startMove({ address, code }, deps) {
  if (outbound && !["done", "failed"].includes(outbound.step)) throw new Error("A move is already under way.");
  const to = cleanAddress(address);
  if (!to) throw new Error("Paste the web address Railway gave your new Closedhand, starting https://.");
  if (!String(code || "").trim()) throw new Error("Paste its setup code too.");
  if (!deps.marker.available()) throw new Error("This Closedhand can't move from here: it has no storage folder.");
  outbound = { step: "checking" };
  run(to, String(code).trim(), deps).catch(() => {});
  return outboundStatus();
}

async function run(to, code, deps) {
  const doFetch = deps.fetch || fetch;
  const call = async (route, { method = "POST", body, headers = {}, token } = {}) => {
    const r = await doFetch(to + route, {
      method,
      headers: { ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...(token ? { "x-move-token": token } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `The new Closedhand answered ${r.status}.`), { said: !!j.error });
    return j;
  };
  let paused = false;
  try {
    // 1. Hello, and the same release on both sides.
    let hello;
    try { hello = await call("/api/move/hello", { body: { code } }); }
    catch (e) { throw new Error(e.said ? e.message : "Couldn't reach the new Closedhand at that address. Check it and try again."); }
    const ours = await latestUpdate(deps.pool);
    if (hello.latest !== ours) {
      throw new Error(String(hello.latest) < String(ours)
        ? "The new Closedhand is on an older release than this one. Redeploy it on Railway, then try again."
        : "This Closedhand is on an older release than the new one. Update it first, then try again.");
    }
    const token = hello.token;

    // 2. The bot here sits still from now on.
    outbound.step = "pausing";
    deps.marker.write({ state: "moving", to, at: new Date().toISOString() });
    paused = true;
    await deps.restartBot();
    const stillBy = Date.now() + 90000;
    while ((await deps.botMoveState().catch(() => null)) !== "moving") {
      if (Date.now() > stillBy) throw new Error("Closedhand here didn't stop in time, so nothing moved. Try again.");
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 3. Everything, in parts.
    outbound.step = "sending";
    const transferKey = crypto.randomBytes(32);
    const parts = await sendInParts(
      exportLines(deps.pool, { storageDir: deps.storageDir, transferKey }),
      async (n, gz) => {
        for (let attempt = 1; ; attempt++) {
          try { return await call(`/api/move/part?n=${n}`, { body: gz, token, headers: { "Content-Type": "application/octet-stream" } }); }
          catch (e) { if (attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 2000 * attempt)); }
        }
      },
      (p) => Object.assign(outbound, p));
    outbound.step = "importing";
    await call("/api/move/commit", { body: { parts, key: transferKey.toString("base64") }, token });
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await call("/api/move/progress", { method: "GET", token }).catch(() => ({ state: "importing" }));
      if (p.state === "imported") break;
      if (p.state === "failed") throw new Error(p.error || "The new Closedhand couldn't take everything in.");
    }

    // 4. Hand over: the personal URL goes with it.
    outbound.step = "handing-over";
    outbound.url = (await deps.personalUrl().catch(() => null)) || to;
    deps.stopTunnel();
    deps.marker.write({ state: "moved", to, url: outbound.url, at: new Date().toISOString() });
    paused = false;
    await call("/api/move/finish", { token }).catch((e) => console.error("[move] the new Closedhand didn't confirm starting:", e.message));
    outbound.step = "done";
    console.log("[move] moved to " + to);
    deps.exitSoon();
  } catch (e) {
    console.error("[move] stopped:", e.message);
    outbound.error = e.message;
    outbound.step = "failed";
    if (paused) {
      deps.marker.clear();
      await deps.restartBot().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// The destination
// ---------------------------------------------------------------------------

let inbound = null; // { tokenHash, expires, dir, state, error }

function tokenOk(token) {
  if (!inbound || inbound.expires < Date.now() || typeof token !== "string") return false;
  const given = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(given, inbound.tokenHash);
}

// deps: setupCode, passwordConfigured(), pool. Throws with a status for the reply.
async function hello(code, deps) {
  const refuse = (status, message) => Object.assign(new Error(message), { status });
  if (!deps.setupCode.enabled) throw refuse(404, "Not found");
  if (await deps.passwordConfigured()) throw refuse(409, "That Closedhand is already set up, so it can't take another one's data. Deploy a new one on Railway.");
  if (!deps.setupCode.matches(code)) {
    await new Promise((r) => setTimeout(r, 1000));
    throw refuse(401, "That isn't its setup code. Copy SETUP_CODE from the webapp service's Variables on Railway.");
  }
  if (inbound && inbound.state === "importing") throw refuse(409, "A move into this Closedhand is already under way.");
  if (inbound && inbound.dir) await fsp.rm(inbound.dir, { recursive: true, force: true }).catch(() => {});
  const token = crypto.randomBytes(32).toString("base64url");
  inbound = {
    tokenHash: crypto.createHash("sha256").update(token).digest(),
    expires: Date.now() + TOKEN_TTL_MS,
    dir: await fsp.mkdtemp(path.join(os.tmpdir(), "closedhand-move-")),
    state: "receiving",
    error: null,
  };
  return { token, latest: await latestUpdate(deps.pool) };
}

async function receivePart(n, body) {
  if (!Number.isInteger(n) || n < 0 || n > 100000 || !Buffer.isBuffer(body) || !body.length) throw Object.assign(new Error("No part to take."), { status: 400 });
  if (inbound.state !== "receiving") throw Object.assign(new Error("This move has stopped taking parts."), { status: 409 });
  await fsp.writeFile(path.join(inbound.dir, `part-${n}`), body);
}

// Starts taking everything in and returns at once; progress() follows it.
function commit({ parts, key }, deps) {
  const transferKey = Buffer.from(String(key || ""), "base64");
  if (!Number.isInteger(parts) || parts < 1 || transferKey.length !== 32) throw Object.assign(new Error("That move is incomplete."), { status: 400 });
  if (inbound.state !== "receiving") throw Object.assign(new Error("This move has already been taken in."), { status: 409 });
  inbound.state = "importing";
  importParts(deps.pool, { dir: inbound.dir, parts, transferKey, storage: deps.storage })
    .then(() => { inbound.state = "imported"; console.log("[move] everything taken in"); })
    .catch((e) => { inbound.state = "failed"; inbound.error = e.message; console.error("[move] taking it in failed, nothing changed:", e.message); })
    .finally(() => fsp.rm(inbound.dir, { recursive: true, force: true }).catch(() => {}));
}

function progress() {
  return { state: inbound.state, error: inbound.error };
}

// After everything is in: start again, reading it all afresh, with the
// personal URL, chat apps and schedules that came with it.
function finish(deps) {
  if (inbound.state !== "imported") throw Object.assign(new Error("Nothing has been taken in yet."), { status: 409 });
  inbound.state = "finished";
  deps.restartBot().catch(() => {});
  deps.exitSoon();
}

// storage: "pg" puts files in storage_objects in the same transaction; a
// folder path writes them there once it commits.
async function importParts(pool, { dir, parts, transferKey, storage }) {
  let opened = 0, unopened = 0;
  const reseal = (text) => text.replace(SEALED, (sealed) => {
    let plain;
    try { plain = openWith(sealed, transferKey); } catch (_) { unopened += 1; return sealed; }
    opened += 1;
    return encryptString(plain);
  });
  const client = await pool.connect();
  const filesAfter = [];
  try {
    await client.query("BEGIN");
    // Rows go in as they were, so the order of tables doesn't matter: no
    // foreign key or trigger runs until the transaction ends.
    await client.query("SET LOCAL session_replication_role = replica");
    const tables = await tablesToMove(client);
    const known = new Set(tables);
    const { rows: colRows } = await client.query(
      `SELECT table_name, column_name, is_generated, identity_generation FROM information_schema.columns WHERE table_schema = 'public'`);
    const columns = new Map();
    for (const c of colRows) {
      if (!columns.has(c.table_name)) columns.set(c.table_name, { insertable: new Set(), identityAlways: new Set() });
      const info = columns.get(c.table_name);
      if (c.is_generated !== "ALWAYS") info.insertable.add(c.column_name);
      if (c.identity_generation === "ALWAYS") info.identityAlways.add(c.column_name);
    }
    await client.query(`TRUNCATE ${tables.map(ident).join(", ")} CASCADE`);

    const pending = new Map(); // table -> raw row texts
    const columnList = new Map(); // table -> the columns both sides have
    const flush = async (table) => {
      const rows = pending.get(table);
      if (!rows || !rows.length) return;
      pending.set(table, []);
      if (!columnList.has(table)) {
        const info = columns.get(table);
        columnList.set(table, Object.keys(JSON.parse(rows[0])).filter((c) => info.insertable.has(c)));
      }
      const cols = columnList.get(table);
      const list = cols.map(ident).join(", ");
      const overriding = cols.some((c) => columns.get(table).identityAlways.has(c)) ? " OVERRIDING SYSTEM VALUE" : "";
      await client.query(
        `INSERT INTO ${ident(table)} (${list})${overriding} SELECT ${list} FROM json_populate_recordset(null::${ident(table)}, $1::json)`,
        ["[" + rows.join(",") + "]"]);
    };

    for (let n = 0; n < parts; n++) {
      let text;
      try { text = zlib.gunzipSync(await fsp.readFile(path.join(dir, `part-${n}`))).toString("utf8"); }
      catch (_) { throw new Error(`Part ${n + 1} of ${parts} didn't arrive whole.`); }
      for (const line of text.split("\n")) {
        if (!line) continue;
        const kind = line.slice(0, 2);
        const second = line.indexOf("\t", 2);
        if (kind === "R\t") {
          const table = line.slice(2, second);
          if (!known.has(table)) continue;
          if (!pending.has(table)) pending.set(table, []);
          pending.get(table).push(reseal(line.slice(second + 1)));
          if (pending.get(table).length >= ROWS_PER_INSERT) await flush(table);
        } else if (kind === "F\t") {
          const { bucket, key } = JSON.parse(line.slice(2, second));
          const data = Buffer.from(line.slice(second + 1), "base64");
          if (storage === "pg") {
            await client.query(
              `INSERT INTO storage_objects (bucket, key, data) VALUES ($1, $2, $3)
               ON CONFLICT (bucket, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [bucket, key, data]);
          } else filesAfter.push({ bucket, key, data });
        } else if (kind === "B\t") {
          const { path: where } = JSON.parse(line.slice(2, second));
          await client.query("INSERT INTO storage_objects (bucket, key, data) VALUES ($1, $2, $3)",
            [BOT_FILES_BUCKET, where, Buffer.from(line.slice(second + 1), "base64")]);
        }
      }
    }
    for (const table of pending.keys()) await flush(table);
    if (unopened && !opened) throw new Error("The stored secrets couldn't be opened, so nothing changed.");

    for (const name of SETTINGS_LEFT_BEHIND) {
      await client.query(`UPDATE profiles SET settings = settings #- $1::text[] WHERE settings ? 'self_host_config'`, [["self_host_config", name]]);
    }
    // Counters carry on from the highest id that came across.
    const { rows: seqs } = await client.query(
      `SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
       FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
       JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
       WHERE s.relkind = 'S' AND n.nspname = 'public'`);
    for (const { seq, tbl, col } of seqs) {
      await client.query(`SELECT setval($1::regclass, COALESCE((SELECT max(${ident(col)}) FROM ${ident(tbl)}), 0) + 1, false)`, [ident(seq)]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (filesAfter.length && typeof storage === "string" && storage !== "pg") {
    const { safeJoin } = require("./storage-driver-local");
    for (const f of filesAfter) {
      const full = safeJoin(path.resolve(storage), f.bucket, f.key);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, f.data);
    }
  }
  if (unopened) console.log(`[move] ${unopened} value(s) that looked sealed didn't open, and came across as they were.`);
}

module.exports = {
  cleanAddress, startMove, outboundStatus,
  hello, tokenOk, receivePart, commit, progress, finish,
  BOT_FILES_BUCKET,
  _internals: { exportLines, sendInParts, importParts, latestUpdate, tablesToMove, filesUnder, LEFT_BEHIND },
};
