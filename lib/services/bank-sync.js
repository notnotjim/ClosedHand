// lib/services/bank-sync.js: balances and transactions from SimpleFIN and
// Lunch Flow, read-only, into data_cache a few times a day, and the reads the
// assistant's bank tools make.
//
// Each connection keeps its own timetable in connections.config.bank: next_at
// (the next run), backoff_until (after a request to slow down, a payment
// problem or an outage), last_ok_at (where the next window starts) and told
// (the notices already sent to the person). What the dashboard shows lives in
// connections.metadata: the accounts with their balances, when they were last
// updated, and the provider's own notices in plain words.
//
// Rows: source simplefin | lunchflow, type bank_account (external_id
// acct:<account>) and bank_transaction (tx:<account>:<id> once booked,
// pending:<account>:<id> while pending). A booked row is keyed by the
// provider's transaction id, or by a hash of what it says when there is none
// (Lunch Flow sends pending rows without one, and some banks never give one),
// with a count for identical rows in one fetch. A repeated fetch therefore
// rewrites the same rows instead of adding copies. Pending rows are replaced
// as a set whenever an account is fetched in full: a payment that has since
// booked simply stops being pending, whatever id its booked form carries.
// Nothing ages out: bank history stays until the person disconnects and asks
// for it to be deleted.

const crypto = require("crypto");
const feeds = require("../bank-feeds");

const BANK_SOURCES = ["simplefin", "lunchflow"];
const NAMES = { simplefin: "SimpleFIN", lunchflow: "Lunch Flow" };
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// Four runs a day. The SimpleFIN Bridge asks for 24 requests a day or fewer
// and a run is one request; Lunch Flow refreshes its data once a day.
const EVERY_MS = 6 * HOUR;
// Plus a random few minutes, as the Bridge asks, so runs avoid the top of the hour.
const JITTER_MS = 20 * MINUTE;
const FIRST_WINDOW_DAYS = 90; // the Bridge's limit for one request
const OVERLAP_DAYS = 7;       // late bookings and payments that booked land inside it

const time = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : 0; };
const iso = (ms) => new Date(ms).toISOString();
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const round = (n) => Math.round(n * 100) / 100;
const money = (n, currency) => `${Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ""}`.trim();

// One line a person would write about it, for recall and search.
function transactionText(t) {
  const who = t.payee || t.description || "an unnamed payee";
  const what = t.amount < 0 ? `Paid ${money(t.amount, t.currency)} to ${who}` : `Received ${money(t.amount, t.currency)} from ${who}`;
  const detail = t.description && t.description !== who ? `: ${t.description}` : "";
  const where = [t.institution, t.account_name].filter(Boolean).join(" ");
  return `${what} on ${t.date}${detail}${where ? ` (${where})` : ""}${t.pending ? ", pending" : ""}`;
}

async function mustWrite(query, what) {
  const { data, error } = await query;
  if (error) throw new Error(`could not ${what} (${error.message})`);
  return data;
}

function createBankSync(deps = {}) {
  const db = typeof deps.db === "function" ? deps.db : deps.db ? () => deps.db : () => require("../db").supabase;
  const now = deps.now || (() => Date.now());
  const random = deps.random || Math.random;
  const log = deps.log || ((line) => console.log(line));
  const feedOpts = deps.feedOpts || {};
  const indexItems = deps.indexItems || ((...a) => require("./usi").indexItems(...a));
  const notify = deps.notify || ((userId, store, text) => require("../connection-alert").notify(userId, store, text));
  const running = new Set();

  async function fetchSimplefin(accessUrl, state, t) {
    const since = Math.max(t - FIRST_WINDOW_DAYS * DAY, state.last_ok_at ? time(state.last_ok_at) - OVERLAP_DAYS * DAY : 0);
    const r = await feeds.simplefinAccounts(accessUrl, { start: Math.floor(since / 1000), pending: true }, feedOpts);
    // An account or bank SimpleFIN could not read in full keeps its pending payments.
    const partAccounts = new Set(r.errors.filter((e) => /^act\./.test(e.code) && e.accountId).map((e) => e.accountId));
    const partConns = new Set(r.errors.filter((e) => /^con\./.test(e.code) && e.connId).map((e) => e.connId));
    return {
      accounts: r.accounts.map((a) => ({
        id: a.id, name: a.name, institution: a.institution, currency: a.currency, balance: a.balance, available: a.available, as_of: a.asOf, status: null,
        transactions: a.transactions.map((x) => ({ ...x, currency: a.currency })),
        complete: !partAccounts.has(a.id) && !(a.connId && partConns.has(a.connId)),
      })),
      // SimpleFIN's own words, shown on the dashboard; a bank that needs
      // signing in to again at SimpleFIN is also told in chat, once.
      notices: r.errors.map((e) => ({
        key: "simplefin:" + hash([e.code, e.connId, e.accountId, e.message].join("|")),
        text: `SimpleFIN says: ${e.message}`,
        tell: /^(con|gen)\.auth/.test(e.code),
      })),
    };
  }

  async function fetchLunchflow(apiKey, state, t) {
    const from = state.last_ok_at ? feeds.isoDay(time(state.last_ok_at) - OVERLAP_DAYS * DAY) : null;
    const list = await feeds.lunchflowAccounts(apiKey, feedOpts);
    const accounts = [], notices = [];
    for (const a of list) {
      let balance = { amount: null, currency: null }, transactions = [], complete = true;
      try { balance = await feeds.lunchflowBalance(apiKey, a.id, feedOpts); }
      catch (e) { if (e.kind === "auth" || e.kind === "rate") throw e; }
      try { transactions = await feeds.lunchflowTransactions(apiKey, a.id, { from, includePending: true }, feedOpts); }
      catch (e) { if (e.kind === "auth" || e.kind === "rate") throw e; complete = false; }
      const currency = a.currency || balance.currency || (transactions[0] && transactions[0].currency) || "";
      accounts.push({ id: a.id, name: a.name, institution: a.institution, currency, balance: balance.amount, available: null, as_of: null, status: a.status,
        transactions: transactions.map((x) => ({ ...x, currency: x.currency || currency })), complete });
      if (a.status && a.status !== "ACTIVE") {
        const which = a.institution ? `${a.institution} (${a.name})` : a.name;
        notices.push({ key: `lunchflow:${a.id}:${a.status}`, tell: true,
          text: `Lunch Flow has lost its connection to ${which}, so that account isn't updating. Reconnect it under Connections in Lunch Flow and Closedhand will pick it up again by itself.` });
      }
    }
    if (!list.length) notices.push({ key: "lunchflow:none", tell: false,
      text: "Lunch Flow is sharing no accounts with Closedhand yet. In Lunch Flow, link a bank under Connections, then switch its accounts on under Account Access in your REST API destination." });
    return { accounts, notices };
  }

  function rowsFor(userId, service, accounts, t) {
    const rows = [], booked = [], pendingByAccount = new Map();
    for (const a of accounts) {
      const account = { account_id: a.id, name: a.name, institution: a.institution, currency: a.currency, balance: a.balance, available: a.available, as_of: a.as_of, status: a.status, provider: NAMES[service] };
      account.text = `${[a.institution, a.name].filter(Boolean).join(" ")}: balance ${a.balance === null ? "unknown" : (a.balance < 0 ? "-" : "") + money(a.balance, a.currency)}`;
      rows.push({ user_id: userId, source: service, type: "bank_account", external_id: `acct:${a.id}`, data: account, synced_at: iso(t), received_at: a.as_of ? `${a.as_of}T00:00:00.000Z` : iso(t) });
      const counts = new Map(), seen = new Set(), pending = new Set();
      for (const x of a.transactions) {
        let id;
        if (x.id) id = `${x.pending ? "pending" : "tx"}:${a.id}:${x.id}`;
        else {
          const base = `${x.pending ? "pending" : "tx"}:${a.id}:h${hash([a.id, x.date, x.amount, x.currency, x.payee, x.description].join("|"))}`;
          const n = (counts.get(base) || 0) + 1;
          counts.set(base, n);
          id = n === 1 ? base : `${base}:${n}`;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        const data = { account_id: a.id, account_name: a.name, institution: a.institution, provider: NAMES[service], date: x.date, amount: x.amount, currency: x.currency,
          payee: x.payee || "", description: x.description || "", memo: x.memo || "", pending: !!x.pending };
        data.text = transactionText(data);
        const row = { user_id: userId, source: service, type: "bank_transaction", external_id: id, data, synced_at: iso(t), received_at: `${x.date}T00:00:00.000Z` };
        rows.push(row);
        if (x.pending) pending.add(id); else booked.push(row);
      }
      if (a.complete) pendingByAccount.set(a.id, pending);
    }
    return { rows, booked, pendingByAccount };
  }

  async function writeRows(userId, service, built) {
    for (const [accountId, keep] of built.pendingByAccount) {
      const stored = await mustWrite(db().from("data_cache").select("external_id").eq("user_id", userId).eq("source", service)
        .eq("type", "bank_transaction").eq("data->>account_id", accountId).eq("data->>pending", "true"), "read pending payments");
      const stale = (stored || []).map((r) => r.external_id).filter((id) => !keep.has(id));
      for (let i = 0; i < stale.length; i += 200) {
        await mustWrite(db().from("data_cache").delete().eq("user_id", userId).eq("source", service).in("external_id", stale.slice(i, i + 200)), "clear payments that are no longer pending");
      }
    }
    for (let i = 0; i < built.rows.length; i += 200) {
      await mustWrite(db().from("data_cache").upsert(built.rows.slice(i, i + 200), { onConflict: "user_id,source,external_id" }), "save bank data");
    }
  }

  async function save(userId, service, conn, metadata, bank) {
    const config = { ...(conn.config || {}), bank };
    await mustWrite(db().from("connections").update({ metadata, config }).eq("user_id", userId).eq("service", service), "save the bank connection");
    conn.metadata = metadata;
    conn.config = config;
  }

  async function failed(userId, store, service, conn, state, e, t) {
    const name = NAMES[service];
    log(`[bank] ${name} sync for ${userId} failed: ${e.kind || "error"}${e.status ? " " + e.status : ""}`);
    // Refused access never mends by waiting: the person pastes a new Setup
    // Token or key, and is told so once.
    if (e.kind === "auth") {
      await store.markConnectionReconnectRequired(service, `${name} refused access`);
      return { error: "auth" };
    }
    const failures = (state.failures || 0) + 1;
    let wait, notice = null;
    if (e.kind === "rate") wait = Math.min(Math.max(e.retryAfterMs || 6 * HOUR, 15 * MINUTE), DAY);
    else if (e.kind === "payment") {
      wait = DAY;
      notice = { key: `${service}:payment`, text: `${name} says your ${name} subscription needs paying, so your bank data isn't updating. Once it's paid, Closedhand picks it up again by itself.` };
    } else wait = Math.min(15 * MINUTE * 2 ** (failures - 1), 6 * HOUR);
    const told = state.told || [];
    const bank = { ...state, backoff_until: iso(t + wait), failures, ...(notice ? { told: [...new Set([...told, notice.key])] } : {}) };
    const metadata = notice ? { ...(conn.metadata || {}), notices: [notice.text] } : (conn.metadata || {});
    try { await save(userId, service, conn, metadata, bank); }
    catch (err) { log(`[bank] ${name} could not record the wait for ${userId}: ${err.message}`); }
    if (notice && !told.includes(notice.key)) await notify(userId, store, notice.text);
    return { error: e.kind || "error" };
  }

  async function syncConnection(userId, store, service) {
    const conn = store && store.connections && store.connections[service];
    if (!conn || !conn.tokens || (conn.metadata && conn.metadata.reconnect_required)) return { skipped: "not connected" };
    const state = (conn.config && conn.config.bank) || {};
    const t = now();
    if (t < time(state.next_at) || t < time(state.backoff_until)) return { skipped: "not due" };
    const lock = userId + ":" + service;
    if (running.has(lock)) return { skipped: "already running" };
    running.add(lock);
    try {
      let got, built;
      try {
        got = service === "simplefin" ? await fetchSimplefin(conn.tokens.access_url, state, t) : await fetchLunchflow(conn.tokens.api_key, state, t);
        built = rowsFor(userId, service, got.accounts, t);
        await writeRows(userId, service, built);
      } catch (e) {
        return await failed(userId, store, service, conn, state, e, t);
      }
      const told = new Set(state.told || []);
      const tell = got.notices.filter((n) => n.tell && !told.has(n.key));
      const { notices: _old, ...kept } = conn.metadata || {};
      const metadata = { ...kept, updated_at: iso(t), notices: got.notices.map((n) => n.text),
        accounts: got.accounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, currency: a.currency, balance: a.balance, available: a.available, as_of: a.as_of, status: a.status })) };
      const bank = { next_at: iso(t + EVERY_MS + Math.floor(random() * JITTER_MS)), last_ok_at: iso(t), told: got.notices.filter((n) => n.tell).map((n) => n.key) };
      await save(userId, service, conn, metadata, bank);
      for (const n of tell) await notify(userId, store, n.text);
      try {
        await indexItems(userId, service, "bank_transaction", built.booked.map((r) => ({
          external_id: r.external_id, text: r.data.text, _skipEnrich: true,
          metadata: { source: service, date: r.data.date, amount: r.data.amount, currency: r.data.currency, payee: r.data.payee, account: r.data.account_name },
        })), { scoped: true });
      } catch (e) { log(`[bank] ${NAMES[service]} recall indexing for ${userId} failed: ${e.message}`); }
      const count = built.rows.filter((r) => r.type === "bank_transaction").length;
      log(`[bank] ${NAMES[service]}: ${got.accounts.length} account(s), ${count} transaction(s) for ${userId}`);
      return { ok: true, accounts: got.accounts.length, transactions: count };
    } finally {
      running.delete(lock);
    }
  }

  async function syncBanks(userId, store) {
    const out = {};
    for (const service of BANK_SOURCES) {
      if (!store || !store.connections || !store.connections[service]) continue;
      try { out[service] = await syncConnection(userId, store, service); }
      catch (e) { log(`[bank] ${NAMES[service]} sync for ${userId} stopped: ${e.message}`); out[service] = { error: "error" }; }
    }
    return out;
  }

  // ------------------------------------------------------- the bank tools

  async function connections(userId) {
    return (await mustWrite(db().from("connections").select("service, metadata").eq("user_id", userId).in("service", BANK_SOURCES), "read the bank connections")) || [];
  }
  const NONE = "No bank is connected. Banks connect on the dashboard's Connections tab: US banks through SimpleFIN, UK and EU banks through Lunch Flow.";

  function problemsOf(rows) {
    const problems = [];
    for (const r of rows) {
      const m = r.metadata || {};
      if (m.reconnect_required) problems.push(`${NAMES[r.service]} stopped accepting Closedhand's access, so nothing from it is current. The person fixes it on the dashboard's Connections tab by pasting a new ${r.service === "simplefin" ? "Setup Token" : "key"}.`);
      for (const n of m.notices || []) problems.push(n);
    }
    return problems;
  }
  const lastUpdate = (rows) => rows.map((r) => r.metadata && r.metadata.updated_at).filter(Boolean).sort().pop() || null;

  async function listAccounts(userId) {
    const rows = await connections(userId);
    if (!rows.length) return { error: NONE };
    const accounts = [];
    for (const r of rows) {
      const m = r.metadata || {};
      for (const a of m.accounts || []) {
        accounts.push({ provider: NAMES[r.service], bank: a.institution || null, account: a.name, account_id: a.id, currency: a.currency, balance: a.balance,
          ...(a.available != null ? { available: a.available } : {}), ...(a.as_of ? { balance_date: a.as_of } : {}), ...(a.status ? { status: a.status } : {}), updated: m.updated_at || null });
      }
    }
    const problems = problemsOf(rows);
    return {
      count: accounts.length, accounts, ...(problems.length ? { problems } : {}),
      note: accounts.length ? "Balances are as of each account's 'updated' time (Closedhand fetches a few times a day), not live. Closedhand can read these accounts but never move money."
        : "Connected, but no accounts have arrived yet. The first update comes a few minutes after connecting.",
    };
  }

  async function queryTransactions(userId, input = {}) {
    const rows = await connections(userId);
    if (!rows.length) return { error: NONE };
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const t = now();
    const to = DATE.test(input.to || "") ? input.to : feeds.isoDay(t);
    const from = DATE.test(input.from || "") ? input.from : feeds.isoDay(t - 30 * DAY);
    const found = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const page = await mustWrite(db().from("data_cache").select("source, data, received_at").eq("user_id", userId).in("source", BANK_SOURCES)
        .eq("type", "bank_transaction").gte("received_at", from + "T00:00:00.000Z").lte("received_at", to + "T23:59:59.999Z")
        .order("received_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + 999), "read bank transactions");
      found.push(...(page || []));
      if (!page || page.length < 1000) break;
    }
    const terms = String(input.text || "").toLowerCase().split(/\s+/).filter(Boolean);
    const account = String(input.account || "").trim().toLowerCase();
    const min = Number.isFinite(Number(input.min_amount)) && input.min_amount !== "" && input.min_amount != null ? Math.abs(Number(input.min_amount)) : null;
    const max = Number.isFinite(Number(input.max_amount)) && input.max_amount !== "" && input.max_amount != null ? Math.abs(Number(input.max_amount)) : null;
    const matched = found.map((r) => r.data || {}).filter((d) => {
      if (typeof d.amount !== "number" || !d.date) return false;
      if (input.include_pending === false && d.pending) return false;
      if (input.direction === "out" && !(d.amount < 0)) return false;
      if (input.direction === "in" && !(d.amount > 0)) return false;
      if (min !== null && Math.abs(d.amount) < min) return false;
      if (max !== null && Math.abs(d.amount) > max) return false;
      if (account && String(d.account_id).toLowerCase() !== account && !`${d.institution || ""} ${d.account_name || ""}`.toLowerCase().includes(account)) return false;
      if (terms.length) {
        const hay = `${d.payee || ""} ${d.description || ""} ${d.memo || ""}`.toLowerCase();
        if (!terms.every((w) => hay.includes(w))) return false;
      }
      return true;
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const add = (map, key, d) => {
      const k = key + "\u0000" + d.currency;
      const g = map.get(k) || { key, currency: d.currency, count: 0, money_out: 0, money_in: 0 };
      g.count++;
      if (d.amount < 0) g.money_out += -d.amount; else g.money_in += d.amount;
      map.set(k, g);
    };
    const finish = (g) => ({ ...g, money_out: round(g.money_out), money_in: round(g.money_in), net: round(g.money_in - g.money_out) });
    const totals = new Map(), groups = new Map();
    for (const d of matched) {
      add(totals, "all", d);
      if (input.group_by === "payee") add(groups, d.payee || d.description || "Unnamed", d);
      if (input.group_by === "month") add(groups, d.date.slice(0, 7), d);
    }
    const limit = Math.min(Math.max(parseInt(input.limit, 10) || 40, 1), 200);
    const shown = matched.slice(0, limit).map((d) => ({ date: d.date, amount: d.amount, currency: d.currency, payee: d.payee || null, description: d.description || null,
      account: [d.institution, d.account_name].filter(Boolean).join(" ") || null, ...(d.pending ? { pending: true } : {}) }));
    const groupList = [...groups.values()].map(finish).sort((a, b) => input.group_by === "month" ? (a.key < b.key ? -1 : 1) : (b.money_out - a.money_out) || (b.money_in - a.money_in));
    const problems = problemsOf(rows);
    return {
      range: { from, to },
      matched: matched.length,
      pending: matched.filter((d) => d.pending).length,
      totals: [...totals.values()].map(({ key, ...g }) => finish(g)),
      ...(input.group_by === "payee" || input.group_by === "month" ? { groups: groupList.slice(0, 30), group_count: groupList.length } : {}),
      transactions: shown,
      updated: lastUpdate(rows),
      ...(problems.length ? { problems } : {}),
      note: "Amounts are negative for money out. Totals cover every matching transaction, not only the ones listed; pending payments are included and marked unless include_pending is false. 'updated' is when the bank data was last fetched.",
    };
  }

  return { syncConnection, syncBanks, listAccounts, queryTransactions };
}

const live = createBankSync();
module.exports = {
  createBankSync, transactionText, BANK_SOURCES, NAMES, EVERY_MS,
  syncBanks: live.syncBanks, listAccounts: live.listAccounts, queryTransactions: live.queryTransactions,
};
