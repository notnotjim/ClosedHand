// Moving a Closedhand to another computer (webapp/move.js): every row and
// file arrives as it was, stored secrets come out sealed under the new
// computer's key (and never travel under either computer's own), settings
// about the old computer stay behind, counters carry on, and a move that
// fails part way leaves the new computer as it was.
// Run: DATABASE_URL=postgres://... (with pgvector) node --test scripts/test-move.js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { Pool } = require("pg");
const { runPendingMigrations } = require("../lib/migrations");

const ADMIN = "00000000-0000-0000-0000-0000000000ad";
const KEY_FROM = crypto.randomBytes(32).toString("base64");
const KEY_TO = crypto.randomBytes(32).toString("base64");
// Each computer has its own encryption key: load the module afresh under it.
function on(key) {
  process.env.TOKEN_ENCRYPTION_KEY = key;
  for (const m of ["../webapp/move", "../webapp/crypto-tokens"]) delete require.cache[require.resolve(m)];
  return { move: require("../webapp/move"), tokens: require("../webapp/crypto-tokens") };
}

let admin, from, to, storageDir;
const url = (db) => { const u = new URL(process.env.DATABASE_URL); u.pathname = "/" + db; return u.href; };
before(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const db of ["move_from", "move_to"]) {
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
  }
  from = new Pool({ connectionString: url("move_from") });
  to = new Pool({ connectionString: url("move_to") });
  for (const pool of [from, to]) {
    await runPendingMigrations(pool);
    // A counter and a computed column, which no table has today, so a table
    // that gains one moves too.
    await pool.query("CREATE TABLE move_probe (n bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, big bigint, label text, shout text GENERATED ALWAYS AS (upper(label)) STORED)");
  }
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-test-"));
});
after(async () => {
  await from?.end(); await to?.end();
  for (const db of ["move_from", "move_to"]) await admin.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => {});
  await admin?.end();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

async function seedFrom() {
  const { tokens } = on(KEY_FROM);
  const settings = {
    preferred_name: "Sam",
    self_host_config: {
      DASHBOARD_PASSWORD_HASH: "scrypt$made-up",
      TELEGRAM_BOT_TOKEN: tokens.encryptString("123456:made-up-telegram"),
      LOCAL_MODELS_STATUS: { embed: { state: "ready" } },
      PHONE_PERMANENT_URL: "https://quiet-test.example",
    },
  };
  await from.query("INSERT INTO profiles (id, display_name, settings) VALUES ($1, 'Sam Example', $2)", [ADMIN, settings]);
  await from.query("INSERT INTO connections (user_id, service, tokens, metadata) VALUES ($1, 'google', $2, $3)",
    [ADMIN, { access_token: tokens.encryptString("ya29.made-up"), refresh_token: tokens.encryptString("1//made-up") }, { email: "sam@example.com" }]);
  await from.query("INSERT INTO facts (user_id, key, value) VALUES ($1, 'partner', 'Mei, a nurse; says \"tab\\there\" and enc:v1:not-a-secret')", [ADMIN]);
  const vector = "[" + Array.from({ length: 1536 }, (_, i) => (i % 7) / 10).join(",") + "]";
  await from.query("INSERT INTO data_vectors (user_id, service, item_type, external_id, embedding) VALUES ($1, 'gmail', 'email', 'm-1', $2)", [ADMIN, vector]);
  await from.query("INSERT INTO move_probe (big, label) VALUES (9007199254740993, 'first'), (2, 'second')");
  await from.query("INSERT INTO dashboard_sessions (token_hash, password_fp, expires_at) VALUES ('made-up-session', 'fp', now() + interval '1 day')");
  fs.mkdirSync(path.join(storageDir, "logos"), { recursive: true });
  fs.writeFileSync(path.join(storageDir, "logos", "sam.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
  fs.mkdirSync(path.join(storageDir, "attachments", "u1"), { recursive: true });
  fs.writeFileSync(path.join(storageDir, "attachments", "u1", "note.txt"), "hello");
  fs.writeFileSync(path.join(storageDir, ".closedhand-move.json"), '{"state":"moving"}');
  fs.mkdirSync(path.join(storageDir, "wa-linked-session"), { recursive: true });
  fs.writeFileSync(path.join(storageDir, "wa-linked-session", "creds.json"), '{"me":"made-up"}');
  fs.mkdirSync(path.join(storageDir, "models", "embed"), { recursive: true });
  fs.writeFileSync(path.join(storageDir, "models", "embed", "weights.bin"), "big local model");
  fs.mkdirSync(path.join(storageDir, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(storageDir, "mcp", "scratch.txt"), "tool scratch");
}

// The source's lines, in parts, as the other computer would receive them.
async function sendAll(transferKey, partChars) {
  const { move } = on(KEY_FROM);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "move-parts-"));
  const lines = move._internals.exportLines(from, { storageDir, transferKey });
  const parts = await move._internals.sendInParts(lines, async (n, gz) => fs.writeFileSync(path.join(dir, `part-${n}`), gz));
  return { dir, parts };
}

test("everything arrives, sealed under the new computer's key, and nothing travels under either key", async () => {
  await seedFrom();
  const transferKey = crypto.randomBytes(32);
  const { dir, parts } = await sendAll(transferKey);
  const sent = Array.from({ length: parts }, (_, n) => zlib.gunzipSync(fs.readFileSync(path.join(dir, `part-${n}`))).toString()).join("\n");
  assert.doesNotMatch(sent, /ya29\.made-up|1\/\/made-up|123456:made-up-telegram/, "no secret travels in the clear");
  const { tokens: fromTokens } = on(KEY_FROM);
  for (const sealed of sent.match(/enc:v1:[A-Za-z0-9+/]+=*/g)) {
    assert.throws(() => fromTokens.openWith(sealed, Buffer.from(KEY_FROM, "base64")), "nothing is sealed under the old computer's key");
  }
  assert.doesNotMatch(sent, /made-up-session/, "signed-in browsers stay behind");
  assert.doesNotMatch(sent, /closedhand-move/, "the move marker stays behind");
  assert.doesNotMatch(sent, /weights\.bin|scratch\.txt/, "local models and tool scratch stay behind");

  // The new computer already has its own first rows, which the move replaces.
  await to.query("INSERT INTO profiles (id, display_name) VALUES ($1, 'New')", [ADMIN]);
  const { move, tokens } = on(KEY_TO);
  await move._internals.importParts(to, { dir, parts, transferKey, storage: "pg" });

  const profile = (await to.query("SELECT display_name, settings FROM profiles WHERE id = $1", [ADMIN])).rows[0];
  assert.equal(profile.display_name, "Sam Example");
  const conf = profile.settings.self_host_config;
  assert.equal(tokens.decryptString(conf.TELEGRAM_BOT_TOKEN), "123456:made-up-telegram", "sealed under the new key");
  assert.equal(conf.DASHBOARD_PASSWORD_HASH, "scrypt$made-up");
  assert.equal(conf.LOCAL_MODELS_STATUS, undefined, "the old computer's model downloads stay behind");
  assert.equal(conf.PHONE_PERMANENT_URL, "https://quiet-test.example", "the personal URL comes along");
  const conn = (await to.query("SELECT tokens, metadata FROM connections")).rows[0];
  assert.deepEqual(tokens.decryptTokens(conn.tokens), { access_token: "ya29.made-up", refresh_token: "1//made-up" });
  assert.equal(conn.metadata.email, "sam@example.com");
  const fact = (await to.query("SELECT value FROM facts")).rows[0].value;
  assert.equal(fact, (await from.query("SELECT value FROM facts")).rows[0].value, "quotes and backslashes arrive as they were");
  assert.match(fact, /enc:v1:not-a-secret/, "text that only looks sealed is left as it was");
  const vec = (await to.query("SELECT embedding::text AS v FROM data_vectors")).rows[0].v;
  assert.equal(vec, (await from.query("SELECT embedding::text AS v FROM data_vectors")).rows[0].v, "vectors arrive whole");
  const probe = (await to.query("SELECT n, big::text, label, shout FROM move_probe ORDER BY n")).rows;
  assert.deepEqual(probe.map((r) => [r.big, r.shout]), [["9007199254740993", "FIRST"], ["2", "SECOND"]], "big numbers keep every digit; computed columns are computed again");
  const next = (await to.query("INSERT INTO move_probe (big, label) VALUES (3, 'third') RETURNING n")).rows[0].n;
  assert.equal(Number(next), Number(probe[1].n) + 1, "counters carry on from the highest that came across");
  const files = (await to.query("SELECT bucket, key, data FROM storage_objects WHERE bucket NOT LIKE '\\_%' ORDER BY bucket, key")).rows;
  assert.deepEqual(files.map((f) => [f.bucket, f.key, f.data.toString("hex")]), [["attachments", "u1/note.txt", Buffer.from("hello").toString("hex")], ["logos", "sam.png", "89504e4700ff"]]);

  // The bot's WhatsApp session waits in the database, then goes into its folder.
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-bot-"));
  const saved = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = botDir;
  try {
    assert.equal(await require("../lib/move-files").restore(to), 1);
    assert.equal(fs.readFileSync(path.join(botDir, "wa-linked-session", "creds.json"), "utf8"), '{"me":"made-up"}');
    assert.equal(await require("../lib/move-files").restore(to), 0, "written once, then gone from the database");
  } finally {
    if (saved === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = saved;
    fs.rmSync(botDir, { recursive: true, force: true });
  }
  assert.equal((await to.query("SELECT count(*)::int AS n FROM dashboard_sessions")).rows[0].n, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a move that can't be taken in whole changes nothing on the new computer", async () => {
  const before = (await to.query("SELECT count(*)::int AS n FROM facts")).rows[0].n;
  const transferKey = crypto.randomBytes(32);
  const { dir, parts } = await sendAll(transferKey);
  const { move } = on(KEY_TO);
  await assert.rejects(move._internals.importParts(to, { dir, parts, transferKey: crypto.randomBytes(32), storage: "pg" }), /couldn't be opened/, "the wrong one-time key is refused");
  fs.writeFileSync(path.join(dir, `part-${parts - 1}`), Buffer.from("not gzip"));
  await assert.rejects(move._internals.importParts(to, { dir, parts, transferKey, storage: "pg" }), /didn't arrive whole/);
  assert.equal((await to.query("SELECT count(*)::int AS n FROM facts")).rows[0].n, before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pasted address becomes an https origin, and nothing else is accepted", () => {
  const { move } = on(KEY_TO);
  assert.equal(move.cleanAddress("quiet-test.up.railway.app"), "https://quiet-test.up.railway.app");
  assert.equal(move.cleanAddress(" https://quiet-test.up.railway.app/setup?x=1 "), "https://quiet-test.up.railway.app");
  assert.equal(move.cleanAddress("http://127.0.0.1:3190"), "http://127.0.0.1:3190", "this computer's own names, for trying a move locally");
  assert.equal(move.cleanAddress("http://new.localhost:3000"), "http://new.localhost:3000");
  for (const bad of ["http://quiet-test.up.railway.app", "ftp://x.example", "javascript:alert(1)", ""]) assert.equal(move.cleanAddress(bad), null, bad);
});

test("a move that fails after Closedhand paused here gives everything back to this computer", async () => {
  const { move } = on(KEY_FROM);
  const marks = [], calls = [];
  let restarts = 0, tunnelStopped = false, exited = false, botState = null;
  const marker = {
    available: () => true,
    write: (s) => { marks.push(s.state); botState = null; },
    clear: () => { marks.push("cleared"); },
  };
  const latest = await move._internals.latestUpdate(from);
  const fakeFetch = async (url, opts) => {
    const route = new URL(url).pathname;
    calls.push(route);
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (route === "/api/move/hello") return reply(200, { token: "t", latest });
    if (route === "/api/move/part") return reply(200, { ok: true });
    if (route === "/api/move/commit") return reply(500, { error: "The new Closedhand ran out of room." });
    return reply(404, {});
  };
  move.startMove({ address: "https://new.example", code: "K7M2Q9X4P8R3T6W5" }, {
    pool: from, storageDir, marker, fetch: fakeFetch,
    restartBot: async () => { restarts += 1; botState = marks[marks.length - 1] === "moving" ? "moving" : null; },
    botMoveState: async () => botState,
    stopTunnel: () => { tunnelStopped = true; },
    personalUrl: async () => "https://quiet-test.example",
    exitSoon: () => { exited = true; },
  });
  for (let i = 0; i < 100 && !["done", "failed"].includes(move.outboundStatus().step); i++) await new Promise((r) => setTimeout(r, 100));
  const st = move.outboundStatus();
  assert.equal(st.step, "failed");
  assert.equal(st.error, "The new Closedhand ran out of room.", "the other side's reason is shown");
  assert.deepEqual(marks, ["moving", "cleared"], "paused, then given back");
  assert.equal(restarts, 2, "the bot restarts to pause and again to carry on");
  assert.equal(tunnelStopped, false, "the personal URL stays here");
  assert.equal(exited, false);
  assert.deepEqual(calls.slice(0, 2), ["/api/move/hello", "/api/move/part"]);
  assert.throws(() => move.startMove({ address: "http://new.example", code: "x" }, { marker }), /https/);
});
