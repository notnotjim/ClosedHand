// Bank connections, read-only: SimpleFIN for US banks and Lunch Flow for UK
// and EU banks. Everything runs against a local stand-in for both services
// with invented banks, people and amounts: the dashboard's form and its
// routes, the encrypted save, the bot's sync on its timetable, the assistant's
// tools, and what the person is told when access stops.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");

process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const feeds = require("../lib/bank-feeds");
const tokens = require("../crypto-tokens");
const { createBankSync, transactionText } = require("../lib/services/bank-sync");

// ------------------------------------------------------------ stand-ins

const SF_USER = "fixture-sf-user", SF_PASS = "fixture-sf-secret-7Q2";
const LF_KEY = "lf-fixture-key-0123456789";
const DAY = 86400;
const at = (d) => Math.floor(Date.parse(d + "T12:00:00Z") / 1000);
const sf = { stage: 1, status: 200, requests: [], claimed: new Set() };
const lf = { stage: 1, status: 200, retryAfter: null, requests: [] };

function simplefinBody() {
  if (sf.stage === 1) {
    // Version 1 shape: org on each account, errors as display strings.
    return { errors: [], accounts: [{
      id: "ACT-1", name: "Everyday", currency: "USD", balance: "1520.40", "available-balance": "1500.00", "balance-date": at("2026-10-10"),
      org: { name: "Example Bank", domain: "bank.example" },
      transactions: [
        { id: "T-1", posted: at("2026-10-03"), amount: "-12.40", description: "CARD PAYMENT EXAMPLE CAFE", payee: "Example Cafe", memo: "" },
        { id: "T-2", posted: at("2026-10-01"), amount: "2100.00", description: "Salary", payee: "Acme Payroll" },
        { id: "P-1", posted: 0, transacted_at: at("2026-10-10"), amount: "-45.10", description: "Corner Grocer", payee: "Corner Grocer", pending: true },
      ],
    }] };
  }
  if (sf.stage === 2) {
    // Version 2 shape: connections and errlist. The grocer payment has booked
    // under a new id, a new one is pending, and SimpleFIN says another bank
    // wants a new sign-in there.
    return { errlist: [{ code: "con.auth", msg: "Sample Credit Union needs you to sign in again at SimpleFIN.", conn_id: "CON-2" }],
      connections: [{ conn_id: "CON-1", name: "Example Bank", org_id: "example", sfin_url: "https://sfin.example" }, { conn_id: "CON-2", name: "Sample Credit Union", org_id: "sample", sfin_url: "https://sfin.example" }],
      accounts: [{
        id: "ACT-1", name: "Everyday", conn_id: "CON-1", currency: "USD", balance: "1475.30", "balance-date": at("2026-10-11"),
        transactions: [
          { id: "T-1", posted: at("2026-10-03"), amount: "-12.40", description: "CARD PAYMENT EXAMPLE CAFE", payee: "Example Cafe" },
          { id: "T-3", posted: at("2026-10-11"), amount: "-45.10", description: "Corner Grocer", payee: "Corner Grocer" },
          { id: "P-2", posted: 0, transacted_at: at("2026-10-11"), amount: "-8.00", description: "Example Diner", payee: "Example Diner", pending: true },
        ],
      }] };
  }
  // SimpleFIN could not read this account in full: what it sent is kept, and
  // its pending payments are left alone rather than judged on half a list.
  return { errlist: [{ code: "act.missingdata", msg: "Some transactions for Everyday are missing; try again later.", account_id: "ACT-1" }], connections: [],
    accounts: [{ id: "ACT-1", name: "Everyday", conn_id: "CON-1", currency: "USD", balance: "1475.30", "balance-date": at("2026-10-11"),
      transactions: [{ id: "T-1", posted: at("2026-10-03"), amount: "-12.40", description: "CARD PAYMENT EXAMPLE CAFE", payee: "Example Cafe" }] }] };
}

const LF_ACCOUNTS = [
  { id: 101, connection_id: 9, name: "Everyday", institution_name: "Example Bank", institution_logo: "", provider: "gocardless", currency: "GBP", status: "ACTIVE" },
  { id: 102, connection_id: 9, name: "Joint", institution_name: "Sample Building Society", institution_logo: "", provider: "gocardless", currency: "EUR", status: "DISCONNECTED" },
];
function lunchflowTransactions(id) {
  if (id !== "101") return [];
  const cafe = { id: "lf-1", accountId: 101, amount: -12.4, currency: "GBP", date: "2026-10-03", merchant: "Example Cafe", description: "Card payment", isPending: false };
  const gym = { id: "", accountId: 101, amount: -60, currency: "GBP", date: "2026-10-05", merchant: "Example Gym", description: "Direct debit", isPending: false };
  const bakery = { id: "", accountId: 101, amount: -3.2, currency: "GBP", date: "2026-10-09", merchant: "Example Bakery", description: "Card payment", isPending: true };
  if (lf.stage === 1) return [cafe, gym, bakery, { ...bakery }];
  return [cafe, gym, { ...bakery, id: "lf-2", date: "2026-10-10", isPending: false }, bakery];
}

let server, base;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body, headers = {}) => { res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain" : "application/json", ...headers }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    if (url.pathname.startsWith("/claim/")) {
      const name = url.pathname.slice(7);
      if (req.method !== "POST" || name !== "good" || sf.claimed.has(name)) return send(403, "Forbidden (was it already claimed?)");
      sf.claimed.add(name);
      return send(200, `http://${SF_USER}:${SF_PASS}@127.0.0.1:${server.address().port}/simplefin`);
    }
    if (url.pathname === "/simplefin/accounts") {
      sf.requests.push({ query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || "" });
      if (req.headers.authorization !== "Basic " + Buffer.from(`${SF_USER}:${SF_PASS}`).toString("base64")) return send(403, "Forbidden");
      if (sf.status !== 200) return send(sf.status, "refused");
      const body = simplefinBody();
      if (url.searchParams.get("balances-only") === "1") body.accounts.forEach((a) => { a.transactions = []; });
      return send(200, body);
    }
    if (url.pathname.startsWith("/lf/api/v1/")) {
      lf.requests.push({ path: url.pathname.slice(10), query: Object.fromEntries(url.searchParams), key: req.headers["x-api-key"] });
      if (!req.headers["x-api-key"]) return send(401, { error: "Unauthorized", message: "Authentication required. Provide x-api-key header or Authorization: Bearer token." });
      if (req.headers["x-api-key"] !== LF_KEY) return send(403, { error: "Forbidden", message: "Invalid credentials." });
      if (lf.status !== 200) return send(lf.status, { error: "Too Many Requests", message: "Slow down" }, lf.retryAfter ? { "Retry-After": String(lf.retryAfter) } : {});
      const route = url.pathname.slice(10);
      if (route === "/accounts") return send(200, { accounts: LF_ACCOUNTS, total: LF_ACCOUNTS.length });
      const m = route.match(/^\/accounts\/(\d+)\/(balance|transactions)$/);
      if (m && m[2] === "balance") return send(200, { balance: { amount: m[1] === "101" ? 830.15 : 12, currency: m[1] === "101" ? "GBP" : "EUR" } });
      if (m) { const list = lunchflowTransactions(m[1]); return send(200, { transactions: list, total: list.length }); }
      return send(404, { error: "Not Found", message: "Account not found." });
    }
    send(404, "not here");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const feedOpts = () => ({ allowLocal: true, lunchflowBase: base + "/lf/api/v1" });
const setupToken = (claim) => Buffer.from(claim).toString("base64");

// A database that keeps rows in memory and speaks the query builder's subset
// the bank code uses, JSON paths included.
function memoryDb() {
  const tables = { data_cache: [], connections: [] };
  const get = (row, col) => {
    const m = String(col).match(/^(\w+)->>(\w+)$/);
    if (m) { const v = row[m[1]] && row[m[1]][m[2]]; return v == null ? null : String(v); }
    return row[col];
  };
  const copy = (v) => JSON.parse(JSON.stringify(v));
  return {
    tables,
    from(name) {
      const rows = tables[name] || (tables[name] = []);
      const filters = []; let op = "select", payload, conflict = [], order = null, range = null;
      const q = {
        select() { return q; },
        eq(c, v) { filters.push((r) => get(r, c) === v); return q; },
        in(c, vs) { filters.push((r) => vs.includes(get(r, c))); return q; },
        gte(c, v) { filters.push((r) => String(get(r, c)) >= v); return q; },
        lte(c, v) { filters.push((r) => String(get(r, c)) <= v); return q; },
        order(c, o) { order = [c, o && o.ascending === false ? -1 : 1]; return q; },
        range(a, b) { range = [a, b]; return q; },
        upsert(p, o) { op = "upsert"; payload = Array.isArray(p) ? p : [p]; conflict = String((o && o.onConflict) || "").split(","); return q; },
        update(p) { op = "update"; payload = p; return q; },
        delete() { op = "delete"; return q; },
        then(done, fail) {
          let data = null;
          if (op === "upsert") {
            for (const r of payload) {
              const hit = rows.find((x) => conflict.every((k) => x[k] === r[k]));
              if (hit) Object.assign(hit, copy(r)); else rows.push(copy(r));
            }
          } else {
            let hit = rows.filter((r) => filters.every((f) => f(r)));
            if (op === "update") hit.forEach((r) => Object.assign(r, copy(payload)));
            else if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
            else {
              if (order) hit = hit.slice().sort((a, b) => (get(a, order[0]) > get(b, order[0]) ? 1 : -1) * order[1]);
              if (range) hit = hit.slice(range[0], range[1] + 1);
              data = copy(hit);
            }
          }
          return Promise.resolve({ data, error: null }).then(done, fail);
        },
      };
      return q;
    },
  };
}

// The webapp's routes, mounted on a stand-in app.
function webapp(db, owner = "user-fixture") {
  const routes = {};
  require("../webapp/bank-connections").register({ post: (p, h) => { routes[p] = h; } }, { db, userId: () => owner, feedOpts: feedOpts() });
  return async (route, body) => {
    const res = { code: 200, body: null, set() {}, status(c) { this.code = c; return this; }, json(v) { this.body = v; } };
    await routes[route]({ body }, res);
    return res;
  };
}

// What the bot loads for a person: tokens opened, as user-store does.
function storeFrom(db, userId, marked = []) {
  const store = { userId, connections: {} };
  for (const r of db.tables.connections.filter((x) => x.user_id === userId)) {
    store.connections[r.service] = { tokens: tokens.decryptTokens(r.tokens), config: r.config, metadata: r.metadata };
  }
  store.markConnectionReconnectRequired = async (service, reason) => {
    const conn = store.connections[service];
    if (conn.metadata && conn.metadata.reconnect_required) return;
    conn.metadata = { ...(conn.metadata || {}), reconnect_required: true, reconnect_reason: reason };
    db.tables.connections.find((r) => r.user_id === userId && r.service === service).metadata = conn.metadata;
    marked.push(service);
  };
  return store;
}

function capture(fn) {
  const lines = [], saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(" "));
  return Promise.resolve().then(fn).then((v) => ({ v, lines }), (e) => ({ e, lines })).finally(() => Object.assign(console, saved));
}

const T0 = Date.parse("2026-10-11T09:00:00Z");
function bot(db, extra = {}) {
  const state = { now: T0, indexed: [], told: [], logs: [] };
  const sync = createBankSync({ db, now: () => state.now, random: () => 0.5, log: (l) => state.logs.push(l), feedOpts: feedOpts(),
    indexItems: async (...a) => { state.indexed.push(a); }, notify: async (u, s, text) => { state.told.push(text); }, ...extra });
  return { sync, state };
}
const rows = (db, source, type) => db.tables.data_cache.filter((r) => r.source === source && (!type || r.type === type));

// ----------------------------------------------------------------- tests

test("a Setup Token decodes to a public https claim address, and nothing else gets through", () => {
  assert.equal(feeds.decodeSetupToken(setupToken("https://bridge.example.org/simplefin/claim/abc")), "https://bridge.example.org/simplefin/claim/abc");
  assert.equal(feeds.decodeSetupToken(" " + setupToken("https://bridge.example.org/simplefin/claim/abc").replace(/(.{10})/, "$1\n") + " "), "https://bridge.example.org/simplefin/claim/abc", "pasted with line breaks");
  for (const bad of ["", "not base64!", setupToken("http://bridge.example.org/claim/x"), setupToken("https://10.0.0.2/claim/x"), setupToken("https://localhost/claim/x"),
    setupToken("https://user:pw@bridge.example.org/claim/x"), setupToken("ftp://bridge.example.org/x"), setupToken(`${base}/claim/good`)]) {
    assert.throws(() => feeds.decodeSetupToken(bad), (e) => e.kind === "token", bad);
  }
});

test("SimpleFIN: the token is claimed once, the Access URL is stored encrypted and never shown or logged", async () => {
  const db = memoryDb(), call = webapp(db);
  const token = setupToken(`${base}/claim/good`);
  const { v: res, lines } = await capture(() => call("/api/bank/simplefin", { setupToken: token }));
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.accounts, [{ name: "Everyday", institution: "Example Bank", currency: "USD", balance: 1520.4, status: null }]);
  const row = db.tables.connections[0];
  assert.equal(row.service, "simplefin");
  assert.match(row.tokens.access_url, /^enc:v1:/, "the Access URL is sealed at rest");
  assert.equal(tokens.decryptTokens(row.tokens).access_url, `http://${SF_USER}:${SF_PASS}@127.0.0.1:${server.address().port}/simplefin`);
  assert.equal(row.metadata.accounts[0].balance, 1520.4);
  assert.deepEqual(row.config.bank, {}, "no timetable yet, so the bot syncs it straight away");
  assert.equal(sf.requests.at(-1).query["balances-only"], "1", "the first look asks for balances only");
  const out = JSON.stringify(res.body) + lines.join("\n");
  for (const secret of [SF_PASS, SF_USER, token, "claim/good"]) assert.ok(!out.includes(secret), `${secret} leaked`);

  // The token works once; a second use is refused and the person is told it may be compromised.
  const again = await call("/api/bank/simplefin", { setupToken: token });
  assert.equal(again.code, 400);
  assert.match(again.body.error, /already been used\. If you didn't use it yourself, someone else may have it: disable it in SimpleFIN/);
  assert.equal(db.tables.connections.length, 1);
  const junk = await call("/api/bank/simplefin", { setupToken: "hello" });
  assert.equal(junk.code, 400);
  assert.match(junk.body.error, /doesn't look like a SimpleFIN Setup Token/);
});

test("Lunch Flow: the key is checked by listing accounts, stored encrypted, and a wrong one is refused in plain words", async () => {
  const db = memoryDb(), call = webapp(db);
  const wrong = await capture(() => call("/api/bank/lunchflow", { apiKey: "lf-not-the-right-key" }));
  assert.equal(wrong.v.code, 400);
  assert.equal(wrong.v.body.error, "Lunch Flow didn't accept that key. Copy it again from your REST API destination under Destinations in Lunch Flow and paste it here.");
  assert.equal(db.tables.connections.length, 0);
  assert.equal((await call("/api/bank/lunchflow", { apiKey: "  " })).code, 400);
  const { v: res, lines } = await capture(() => call("/api/bank/lunchflow", { apiKey: ` ${LF_KEY} ` }));
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.accounts.map((a) => a.name), ["Everyday", "Joint"]);
  const row = db.tables.connections[0];
  assert.match(row.tokens.api_key, /^enc:v1:/);
  assert.equal(tokens.decryptTokens(row.tokens).api_key, LF_KEY);
  assert.equal(lf.requests.at(-1).path, "/accounts");
  for (const text of [JSON.stringify(res.body), JSON.stringify(row.metadata), ...lines, ...wrong.lines]) assert.ok(!text.includes(LF_KEY) && !text.includes("lf-not-the-right-key"));
});

test("every copy of crypto-tokens seals the bank secrets", () => {
  for (const f of ["crypto-tokens.js", "webapp/crypto-tokens.js", "closedhand-com/lib/crypto-tokens.js"]) {
    const c = require(path.join(root, f));
    const sealed = c.encryptTokens({ access_url: "https://u:p@sfin.example/simplefin", api_key: "fixture-key" });
    assert.match(sealed.access_url, /^enc:v1:/, f);
    assert.match(sealed.api_key, /^enc:v1:/, f);
    assert.equal(c.decryptTokens(sealed).api_key, "fixture-key", f);
  }
  assert.equal(read("lib/bank-feeds.js"), read("webapp/bank-feeds.js"), "both services read banks the same way");
});

test("SimpleFIN sync: one request a run, deduplicated by id, pending replaced once booked, history kept", async () => {
  const db = memoryDb();
  sf.stage = 1; sf.claimed.clear();
  await webapp(db)("/api/bank/simplefin", { setupToken: setupToken(`${base}/claim/good`) });
  const { sync, state } = bot(db);
  const store = storeFrom(db, "user-fixture");
  const before = sf.requests.length;
  const first = await sync.syncConnection("user-fixture", store, "simplefin");
  assert.deepEqual(first, { ok: true, accounts: 1, transactions: 3 });
  assert.equal(sf.requests.length, before + 1);
  const q = sf.requests.at(-1).query;
  assert.equal(q.pending, "1");
  assert.equal(Number(q["start-date"]), Math.floor((T0 - 90 * DAY * 1000) / 1000), "the first run reads the Bridge's 90 days");
  assert.deepEqual(rows(db, "simplefin", "bank_transaction").map((r) => r.external_id).sort(), ["pending:ACT-1:P-1", "tx:ACT-1:T-1", "tx:ACT-1:T-2"]);
  const cafe = rows(db, "simplefin").find((r) => r.external_id === "tx:ACT-1:T-1");
  assert.equal(cafe.data.text, "Paid 12.40 USD to Example Cafe on 2026-10-03: CARD PAYMENT EXAMPLE CAFE (Example Bank Everyday)");
  assert.equal(cafe.received_at, "2026-10-03T00:00:00.000Z");
  assert.equal(rows(db, "simplefin", "bank_account")[0].data.balance, 1520.4);
  // Recall gets booked payments only, as short lines, with no summarising model.
  assert.deepEqual(state.indexed[0].slice(0, 3), ["user-fixture", "simplefin", "bank_transaction"]);
  assert.deepEqual(state.indexed[0][3].map((i) => i.external_id).sort(), ["tx:ACT-1:T-1", "tx:ACT-1:T-2"]);
  assert.ok(state.indexed[0][3].every((i) => i._skipEnrich === true));
  const conn = db.tables.connections[0];
  assert.equal(conn.config.bank.next_at, new Date(T0 + 6 * 3600e3 + 0.5 * 20 * 60e3).toISOString());

  // Not due yet: nothing is asked of SimpleFIN.
  state.now = T0 + 3 * 3600e3;
  assert.deepEqual(await sync.syncConnection("user-fixture", store, "simplefin"), { skipped: "not due" });
  assert.equal(sf.requests.length, before + 1);

  // Next run: the grocer payment has booked under a new id, so the pending row goes.
  sf.stage = 2;
  state.now = T0 + 7 * 3600e3;
  await sync.syncConnection("user-fixture", store, "simplefin");
  assert.equal(Number(sf.requests.at(-1).query["start-date"]), Math.floor((T0 - 7 * DAY * 1000) / 1000), "later runs overlap the last by a week");
  const ids = rows(db, "simplefin", "bank_transaction").map((r) => r.external_id).sort();
  assert.deepEqual(ids, ["pending:ACT-1:P-2", "tx:ACT-1:T-1", "tx:ACT-1:T-2", "tx:ACT-1:T-3"], "booked kept (T-2 is history outside this window), P-1 gone once booked as T-3, nothing doubled");
  assert.equal(conn.metadata.accounts[0].balance, 1475.3);
  assert.equal(conn.metadata.accounts[0].institution, "Example Bank", "version 2 names the bank through its connection");
  // SimpleFIN's own words reach the dashboard, and a bank to sign in to again is told once.
  const words = "SimpleFIN says: Sample Credit Union needs you to sign in again at SimpleFIN.";
  assert.deepEqual(conn.metadata.notices, [words]);
  assert.deepEqual(state.told, [words]);
  state.now += 7 * 3600e3;
  await sync.syncConnection("user-fixture", store, "simplefin");
  assert.equal(state.told.length, 1, "not told twice");
  assert.equal(rows(db, "simplefin", "bank_transaction").length, 4, "a repeated fetch rewrites the same rows");

  sf.stage = 3;
  state.now += 7 * 3600e3;
  await sync.syncConnection("user-fixture", store, "simplefin");
  assert.ok(rows(db, "simplefin").some((r) => r.external_id === "pending:ACT-1:P-2"), "half a list never clears a pending payment");
  assert.deepEqual(conn.metadata.notices, ["SimpleFIN says: Some transactions for Everyday are missing; try again later."]);
  assert.equal(state.told.length, 1, "a passing gap is shown on the dashboard, not sent to chat");
});

test("SimpleFIN stays within a few requests a day however often the bot looks", async () => {
  const db = memoryDb();
  sf.stage = 1; sf.claimed.clear();
  await webapp(db)("/api/bank/simplefin", { setupToken: setupToken(`${base}/claim/good`) });
  const { sync, state } = bot(db);
  const store = storeFrom(db, "user-fixture");
  const start = sf.requests.length;
  for (let m = 0; m < 24 * 60; m += 5) {
    state.now = T0 + m * 60e3;
    await sync.syncBanks("user-fixture", store);
  }
  assert.equal(sf.requests.length - start, 4, "every five minutes for a day is four requests, well under the Bridge's 24");
});

test("refused access marks the connection to be renewed, stops asking, and the person is told in plain words", async () => {
  const db = memoryDb(), marked = [];
  sf.stage = 1; sf.claimed.clear();
  await webapp(db)("/api/bank/simplefin", { setupToken: setupToken(`${base}/claim/good`) });
  const { sync, state } = bot(db);
  const store = storeFrom(db, "user-fixture", marked);
  sf.status = 403;
  try {
    assert.deepEqual(await sync.syncConnection("user-fixture", store, "simplefin"), { error: "auth" });
    assert.deepEqual(marked, ["simplefin"]);
    assert.equal(db.tables.connections[0].metadata.reconnect_required, true);
    const count = sf.requests.length;
    state.now += 2 * 86400e3;
    assert.deepEqual(await sync.syncConnection("user-fixture", store, "simplefin"), { skipped: "not connected" });
    assert.equal(sf.requests.length, count, "a refused connection waits for new access");
    assert.ok(state.logs.every((l) => !l.includes(SF_PASS)));
    assert.match(state.logs.join("\n"), /SimpleFIN sync for user-fixture failed: auth 403/);
  } finally { sf.status = 200; }

  // Pasting a new Setup Token mends it: fresh tokens, the flag gone.
  sf.claimed.clear();
  await webapp(db)("/api/bank/simplefin", { setupToken: setupToken(`${base}/claim/good`) });
  assert.equal(db.tables.connections.length, 1);
  assert.equal(db.tables.connections[0].metadata.reconnect_required, undefined);

  // A subscription to pay is not a refusal: wait a day, say so once.
  const fresh = storeFrom(db, "user-fixture", marked);
  sf.status = 402;
  try {
    assert.deepEqual(await sync.syncConnection("user-fixture", fresh, "simplefin"), { error: "payment" });
    assert.equal(marked.length, 1);
    assert.equal(db.tables.connections[0].config.bank.backoff_until, new Date(state.now + 86400e3).toISOString());
    assert.deepEqual(state.told, ["SimpleFIN says your SimpleFIN subscription needs paying, so your bank data isn't updating. Once it's paid, Closedhand picks it up again by itself."]);
  } finally { sf.status = 200; }
});

test("Lunch Flow sync: blank ids still dedupe, pending is replaced, a lost bank is told once, and 429 backs off", async () => {
  const db = memoryDb();
  lf.stage = 1;
  await webapp(db)("/api/bank/lunchflow", { apiKey: LF_KEY });
  const { sync, state } = bot(db);
  const store = storeFrom(db, "user-fixture");
  lf.requests.length = 0;
  await sync.syncConnection("user-fixture", store, "lunchflow");
  assert.deepEqual(lf.requests.map((r) => r.path), ["/accounts", "/accounts/101/balance", "/accounts/101/transactions", "/accounts/102/balance", "/accounts/102/transactions"]);
  assert.deepEqual(lf.requests[2].query, { include_pending: "true" }, "the first run takes all the history Lunch Flow holds");
  assert.ok(lf.requests.every((r) => r.key === LF_KEY));
  const tx = rows(db, "lunchflow", "bank_transaction");
  assert.equal(tx.length, 4, "two identical pending bakery payments stay two");
  assert.equal(tx.filter((r) => r.data.pending).length, 2);
  assert.ok(tx.some((r) => r.external_id === "tx:101:lf-1"));
  const gymId = tx.find((r) => r.data.payee === "Example Gym").external_id;
  assert.match(gymId, /^tx:101:h[0-9a-f]{16}$/, "a booked payment without an id is keyed by what it says");
  const conn = db.tables.connections[0];
  assert.deepEqual(conn.metadata.accounts.map((a) => [a.name, a.balance, a.status]), [["Everyday", 830.15, "ACTIVE"], ["Joint", 12, "DISCONNECTED"]]);
  assert.deepEqual(state.told, ["Lunch Flow has lost its connection to Sample Building Society (Joint), so that account isn't updating. Reconnect it under Connections in Lunch Flow and Closedhand will pick it up again by itself."]);

  lf.stage = 2;
  state.now = T0 + 7 * 3600e3;
  lf.requests.length = 0;
  await sync.syncConnection("user-fixture", store, "lunchflow");
  assert.equal(lf.requests[2].query.from, "2026-10-04", "later runs start a week before the last");
  const after2 = rows(db, "lunchflow", "bank_transaction");
  assert.equal(after2.length, 4, "one bakery payment booked (lf-2), one still pending, cafe and gym unchanged");
  assert.equal(after2.filter((r) => r.data.pending).length, 1);
  assert.ok(after2.some((r) => r.external_id === "tx:101:lf-2"));
  assert.ok(after2.some((r) => r.external_id === gymId), "the id-less booked row is rewritten, not doubled");
  assert.equal(state.told.length, 1, "the lost bank is told once");

  // Asked to slow down: wait as long as Lunch Flow says (at least 15 minutes), or six hours.
  lf.status = 429; lf.retryAfter = null;
  state.now = T0 + 14 * 3600e3;
  try {
    assert.deepEqual(await sync.syncConnection("user-fixture", store, "lunchflow"), { error: "rate" });
    assert.equal(conn.config.bank.backoff_until, new Date(state.now + 6 * 3600e3).toISOString());
    const asked = lf.requests.length;
    state.now += 5 * 3600e3;
    assert.deepEqual(await sync.syncConnection("user-fixture", store, "lunchflow"), { skipped: "not due" });
    assert.equal(lf.requests.length, asked);
    assert.equal(conn.metadata.reconnect_required, undefined, "slowing down is never a reason to reconnect");
  } finally { lf.status = 200; }
  state.now += 2 * 3600e3;
  assert.equal((await sync.syncConnection("user-fixture", store, "lunchflow")).ok, true);

  // A key deleted at Lunch Flow: marked for a new one, and not asked again.
  const marked = [];
  const revoked = storeFrom(db, "user-fixture", marked);
  revoked.connections.lunchflow.tokens.api_key = "lf-deleted-key-000000";
  revoked.connections.lunchflow.config.bank = {};
  assert.deepEqual(await sync.syncConnection("user-fixture", revoked, "lunchflow"), { error: "auth" });
  assert.deepEqual(marked, ["lunchflow"]);
  assert.ok(state.logs.every((l) => !l.includes("lf-deleted-key") && !l.includes(LF_KEY)));
});

test("the bank tools list balances and add up spending by currency, payee and month", async () => {
  const db = memoryDb();
  sf.stage = 1; sf.claimed.clear(); lf.stage = 2;
  await webapp(db)("/api/bank/simplefin", { setupToken: setupToken(`${base}/claim/good`) });
  await webapp(db)("/api/bank/lunchflow", { apiKey: LF_KEY });
  const { sync } = bot(db);
  const store = storeFrom(db, "user-fixture");
  await sync.syncBanks("user-fixture", store);

  const accounts = await sync.listAccounts("user-fixture");
  assert.deepEqual(accounts.accounts.map((a) => [a.provider, a.bank, a.account, a.balance, a.currency]),
    [["SimpleFIN", "Example Bank", "Everyday", 1520.4, "USD"], ["Lunch Flow", "Example Bank", "Everyday", 830.15, "GBP"], ["Lunch Flow", "Sample Building Society", "Joint", 12, "EUR"]]);
  assert.match(accounts.problems.join(" "), /lost its connection to Sample Building Society/);

  const out = await sync.queryTransactions("user-fixture", { from: "2026-09-01", to: "2026-10-11", direction: "out", group_by: "payee" });
  assert.equal(out.matched, 6);
  assert.deepEqual([...out.totals].sort((a, b) => a.currency.localeCompare(b.currency)), [
    { currency: "GBP", count: 4, money_out: 78.8, money_in: 0, net: -78.8 },
    { currency: "USD", count: 2, money_out: 57.5, money_in: 0, net: -57.5 },
  ], "totals per currency, never added across currencies");
  assert.deepEqual(out.groups.slice(0, 2).map((g) => [g.key, g.currency, g.money_out]), [["Example Gym", "GBP", 60], ["Corner Grocer", "USD", 45.1]]);
  assert.equal(out.transactions[0].date, "2026-10-10", "newest first");

  const cafe = await sync.queryTransactions("user-fixture", { from: "2026-10-01", text: "example CAFE" });
  assert.deepEqual(cafe.totals.map((t) => [t.currency, t.money_out]).sort(), [["GBP", 12.4], ["USD", 12.4]]);
  const booked = await sync.queryTransactions("user-fixture", { from: "2026-09-01", account: "everyday", include_pending: false, min_amount: 10 });
  assert.ok(booked.transactions.every((t) => !t.pending && Math.abs(t.amount) >= 10));
  const income = await sync.queryTransactions("user-fixture", { from: "2026-09-01", direction: "in", group_by: "month" });
  assert.deepEqual(income.groups, [{ key: "2026-10", currency: "USD", count: 1, money_out: 0, money_in: 2100, net: 2100 }]);
  assert.match(income.note, /negative for money out/);
  assert.deepEqual(await createBankSync({ db: memoryDb() }).listAccounts("nobody"), { error: "No bank is connected. Banks connect on the dashboard's Connections tab: US banks through SimpleFIN, UK and EU banks through Lunch Flow." });
});

test("the readable line says who, how much, when and where", () => {
  assert.equal(transactionText({ amount: 2100, currency: "USD", payee: "Acme Payroll", description: "Salary", date: "2026-10-01", institution: "Example Bank", account_name: "Everyday" }),
    "Received 2,100.00 USD from Acme Payroll on 2026-10-01: Salary (Example Bank Everyday)");
  assert.equal(transactionText({ amount: -3.2, currency: "GBP", payee: "Example Bakery", description: "Example Bakery", date: "2026-10-09", pending: true }),
    "Paid 3.20 GBP to Example Bakery on 2026-10-09, pending");
});

test("bank tools are read-only, offered only with a bank, and money questions load them up front", () => {
  const { READ_ONLY_TOOLS } = require("../lib/read-only-tools");
  const { INTERNAL_TOOLS } = require("../lib/tools/definitions");
  for (const name of ["bank_accounts", "bank_transactions"]) {
    assert.ok(READ_ONLY_TOOLS.has(name), name);
    assert.deepEqual(INTERNAL_TOOLS.find((t) => t.name === name).groups, ["bank"]);
  }
  const engine = read("lib/engine.js");
  assert.match(engine, /if \(g === "bank" && !hasBank\(\)\) return false;/);
  const box = {};
  vm.runInNewContext(engine.slice(engine.indexOf("const TOOL_FAMILIES"), engine.indexOf("\n}\n", engine.indexOf("function likelyOnDemandTools")) + 3) + "\nthis.likely = likelyOnDemandTools;", box);
  const tools = [{ name: "bank_accounts" }, { name: "bank_transactions" }, { name: "gmail_send" }];
  for (const ask of ["How much did I spend on coffee in September?", "what's my balance", "did the rent payment go out?", "show me last month's transactions"]) {
    assert.deepEqual([...box.likely(ask, [], tools)].sort(), ["bank_accounts", "bank_transactions"], ask);
  }
  assert.deepEqual([...box.likely("What's the weather like?", [], tools)], []);
  // The generic connection reader leaves bank rows to this sync, in both services.
  for (const f of ["../lib/services/recall-settings", "../webapp/recall-settings"]) {
    const { usesExistingReader } = require(f);
    assert.ok(usesExistingReader({ service: "simplefin" }) && usesExistingReader({ service: "lunchflow" }), f);
  }
});

test("one bank tile asks where the bank is, then opens a short form that says who sees the data and shows the accounts", async () => {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this.className = ""; this.attrs = {}; this.listeners = {}; this._text = ""; this.classList = new Set(); this.classList.remove = this.classList.delete; }
    set textContent(t) { this._text = String(t); this.children = []; }
    get textContent() { return this.hidden ? "" : this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(" "); }
    set innerHTML(h) { this._html = h; }
    append(...xs) { this.children.push(...xs); }
    replaceChildren() { this.children = []; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    click() { (this.listeners.click || this.onclick || (() => {}))(); }
    focus() {}
    scrollIntoView() {}
    all(pred, out = []) { for (const c of this.children) if (c instanceof El) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  }
  const ids = {};
  for (const id of ["catalogue-status", "catalogue-retry", "connection-catalogue-list", "catalogue-apps-heading", "catalogue-setup", "catalogue-browse", "mcp-section", "mcp-url-input"]) ids[id] = new El("div");
  let ready;
  const services = [
    { key: "simplefin", name: "US banks via SimpleFIN", description: "Bank balances and transactions, read-only", logoUrl: "/logos/bank.svg", connected: false, mode: "simplefin", scopes: [] },
    { key: "lunchflow", name: "UK and EU banks via Lunch Flow", description: "Bank balances and transactions, read-only", logoUrl: "/logos/bank.svg", connected: false, mode: "lunchflow", scopes: [] },
  ];
  const posts = [];
  const fetch = async (url, init) => {
    if (url === "/api/connection-catalogue") return { ok: true, json: async () => ({ services }) };
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ success: true, accounts: [{ name: "Everyday", institution: "Example Bank", currency: "USD", balance: 1520.4 }], notices: [] }) };
  };
  const document = { getElementById: (id) => ids[id], createElement: (tag) => new El(tag), querySelector: () => null, addEventListener: (t, fn) => { ready = fn; } };
  const window = {};
  vm.runInNewContext(read("webapp/public/connection-catalogue.js"), { window, document, fetch, setTimeout, navigator: {} });
  ready();
  await new Promise((r) => setImmediate(r));
  const tiles = ids["connection-catalogue-list"].all((e) => e.className === "catalogue-tile");
  assert.deepEqual(tiles.map((t) => t.textContent.trim()), ["Banks"], "one tile for banks, whichever service");
  const pick = (label) => {
    tiles[0].click();
    const choice = ids["catalogue-setup"].all((e) => e.className === "catalogue-action");
    assert.deepEqual(choice.map((b) => b.textContent), ["UK or EU bank", "US bank"]);
    assert.match(ids["catalogue-setup"].textContent, /Where is your bank\? UK and EU banks connect through Lunch Flow, US banks through SimpleFIN\./);
    choice.find((b) => b.textContent === label).click();
  };

  pick("UK or EU bank");
  let setup = ids["catalogue-setup"];
  assert.match(setup.textContent, /goes from your bank through Lunch Flow to Closedhand on your computer and never to closedhand\.com/);
  assert.match(setup.textContent, /can only read it: it can’t move money/);
  // Steps name the buttons Lunch Flow shows, so someone who has never heard of an API can follow them.
  assert.match(setup.textContent, /click “Add Destination” and pick “REST API”/);
  assert.match(setup.textContent, /under “Account Access”, switch on each account you want Closedhand to see/);
  // Setup describes the service; it doesn't sell it.
  assert.doesNotMatch(setup.textContent, /free trial|trial/i);
  assert.equal(setup.all((e) => e.className === "catalogue-deep")[0].href, "https://www.lunchflow.app/");

  pick("US bank");
  setup = ids["catalogue-setup"];
  assert.match(setup.textContent, /about \$15 a year paid to SimpleFIN/);
  assert.match(setup.textContent, /never to closedhand\.com/);
  assert.equal(setup.all((e) => e.className === "catalogue-deep")[0].href, "https://bridge.simplefin.org/simplefin/create");
  const form = setup.all((e) => e.className === "catalogue-form")[0];
  const input = form.all((e) => e.tag === "input")[0];
  assert.equal(input.type, "password");
  input.value = "c2V0dXAtdG9rZW4=";
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(posts, [{ url: "/api/bank/simplefin", body: { setupToken: "c2V0dXAtdG9rZW4=" } }]);
  assert.equal(input.value, "", "the token leaves the page once sent");
  assert.match(setup.textContent, /Connected\. Closedhand can now read this account:/);
  assert.match(setup.textContent, /Example Bank Everyday: 1,520\.40 USD/);
  assert.equal(typeof window.openBankConnection, "function", "a card whose access stopped opens the same form");

  // With one bank service connected, the tile goes straight to the other's form.
  services[0].connected = true;
  window.refreshConnectionCatalogue();
  await new Promise((r) => setImmediate(r));
  const left = ids["connection-catalogue-list"].all((e) => e.className === "catalogue-tile");
  assert.deepEqual(left.map((t) => t.textContent.trim()), ["Banks"]);
  left[0].click();
  assert.match(ids["catalogue-setup"].textContent, /goes from your bank through Lunch Flow/);
});

test("the dashboard card, the chat alert and the server wiring say what stopped and how to mend it", async () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /if \(BANK_CARDS\[c\.service\]\) return bankDrawerHtml\(c\);/);
  assert.match(dash, /openBankConnection\('\$\{c\.service\}'\)/);
  assert.match(dash, /escHtml\(notice\)/, "a provider's words are shown as text, never markup");
  const server = read("webapp/server.js");
  assert.match(server, /require\("\.\/bank-connections"\)\.register\(app, \{ db: supabase, userId: getUserIdFromRequest \}\);/);
  assert.match(server, /simplefin: \{\n    name: "US banks via SimpleFIN",[\s\S]{0,200}pasteForm: "simplefin"/);
  assert.match(server, /lunchflow: \{\n    name: "UK and EU banks via Lunch Flow",[\s\S]{0,200}pasteForm: "lunchflow"/);
  assert.match(read("webapp/connection-catalogue.js"), /mode:s\.pasteForm\?s\.pasteForm:/);
  assert.match(read("lib/services/data-sync.js"), /require\("\.\/bank-sync"\)\.syncBanks\(userId, store\)/);

  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const sent = [];
  stub("../lib/db", { supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [{ platform: "telegram", platform_user_id: "42" }] }) }) }) } });
  // Out of quiet hours: each chosen chat app gets it now (lib/proactive.js).
  stub("../lib/proactive", { deliverUnprompted: async (u, s, links, textFor) => { for (const t of links) sent.push([t.platform, t.platform_user_id, await textFor(t)]); return links.length > 0; } });
  stub("../lib/dashboard-links", { dashboardUrl: async (p, section) => `https://fixture.example/dashboard#${section}` });
  const alert = require("../lib/connection-alert");
  assert.equal(await alert.tellOwner("u", { connections: {} }, "simplefin"), true);
  assert.equal(sent[0][2], "SimpleFIN stopped accepting Closedhand's access to your bank data, so your balances and transactions are no longer updating. To fix it, make a new Setup Token under Apps in SimpleFIN and paste it on the dashboard: https://fixture.example/dashboard#connections");
  assert.equal(await alert.tellOwner("u", { connections: {} }, "lunchflow"), true);
  assert.equal(sent[1][2], "Your Lunch Flow key stopped working, so your balances and transactions are no longer updating. To fix it, add a new REST API destination under Destinations in Lunch Flow and paste its key on the dashboard: https://fixture.example/dashboard#connections");
  assert.equal(await alert.notify("u", {}, "Lunch Flow has lost its connection to Example Bank (Everyday)."), true);
  assert.equal(sent[2][2], "Lunch Flow has lost its connection to Example Bank (Everyday).");
});
