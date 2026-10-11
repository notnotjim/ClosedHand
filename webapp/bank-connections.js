// Bank connections the person chooses to add on the dashboard: SimpleFIN for
// US banks (they paste a Setup Token) and Lunch Flow for UK and EU banks
// (they paste an API key). Both are read-only and optional. The webapp only
// claims or checks the access and saves it encrypted; the bot fetches
// balances and transactions a few times a day (lib/services/bank-sync.js).
// Nothing here returns, logs or echoes the Access URL or the key: logs carry
// the kind of failure and the provider's status code, nothing more.

const feeds = require("./bank-feeds");
const { encryptTokens } = require("./crypto-tokens");

const SECRET = { simplefin: "access_url", lunchflow: "api_key" };
const NO_ACCOUNTS = "Lunch Flow is sharing no accounts with Closedhand yet. In Lunch Flow, link a bank under Connections, then switch its accounts on under Account Access in your REST API destination.";

async function mustWrite(query, what) {
  const { error } = await query;
  if (error) throw new Error(`could not ${what}`);
}

const outcome = (e) => `${e.kind || "error"}${e.status ? " " + e.status : ""}`;
const shown = (accounts) => accounts.map((a) => ({ name: a.name, institution: a.institution || null, currency: a.currency || null, balance: a.balance, status: a.status || null }));

function register(app, { db, userId, feedOpts = {} }) {
  const busy = new Set();

  // A new connection, or new access for one that stopped: fresh tokens,
  // fresh metadata (which clears "sign in again") and a sync due now.
  async function save(owner, service, tokens, accounts, notices) {
    const sealed = encryptTokens(tokens);
    if (!String(sealed[SECRET[service]] || "").startsWith("enc:v1:")) throw new Error("encrypted storage is unavailable");
    await mustWrite(db.from("connections").upsert({
      user_id: owner, service, tokens: sealed,
      config: { bank: {} },
      metadata: { accounts, notices },
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service" }), "save the connection");
  }

  // Runs once at a time per person and service: a Setup Token works once,
  // and a double click must not spend it on a second claim.
  function once(service, handler) {
    return async (req, res) => {
      res.set("Cache-Control", "no-store");
      const owner = userId(req);
      if (!owner) return res.status(401).json({ error: "Sign in to connect a bank." });
      const lock = owner + ":" + service;
      if (busy.has(lock)) return res.status(409).json({ error: "Closedhand is already connecting this. Wait a moment." });
      busy.add(lock);
      try { await handler(owner, req, res); }
      finally { busy.delete(lock); }
    };
  }

  app.post("/api/bank/simplefin", once("simplefin", async (owner, req, res) => {
    let claimUrl, access;
    try { claimUrl = feeds.decodeSetupToken(req.body && req.body.setupToken, feedOpts); }
    catch (_) { return res.status(400).json({ error: "That doesn't look like a SimpleFIN Setup Token. Copy the whole token from SimpleFIN and paste it again." }); }
    try { access = await feeds.claimSimplefin(claimUrl, feedOpts); }
    catch (e) {
      console.log(`[bank] SimpleFIN claim failed: ${outcome(e)}`);
      // The protocol asks apps to say a refused token may be in someone else's hands.
      if (e.kind === "claimed") return res.status(400).json({ error: "SimpleFIN says this Setup Token has already been used. If you didn't use it yourself, someone else may have it: disable it in SimpleFIN, then make a new Setup Token and paste that here." });
      if (e.kind === "unavailable" && !e.status) return res.status(503).json({ error: "Couldn't reach SimpleFIN. Check the computer running Closedhand is online, then try again with the same Setup Token." });
      return res.status(503).json({ error: "SimpleFIN didn't hand over access. Make a new Setup Token in SimpleFIN and try again." });
    }
    let accounts = [], notices = [];
    try {
      const first = await feeds.simplefinAccounts(access, { balancesOnly: true }, feedOpts);
      accounts = first.accounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, currency: a.currency, balance: a.balance, available: a.available, as_of: a.asOf, status: null }));
      notices = first.errors.map((e) => `SimpleFIN says: ${e.message}`);
    } catch (e) {
      // The access is claimed either way; the bot's first sync tries again.
      console.log(`[bank] SimpleFIN first look failed: ${outcome(e)}`);
    }
    try { await save(owner, "simplefin", { access_url: access }, accounts, notices); }
    catch (e) {
      console.error(`[bank] SimpleFIN connection not saved: ${e.message}`);
      return res.status(500).json({ error: "Closedhand couldn't save the connection, and a Setup Token only works once. Make a new one in SimpleFIN and paste it here." });
    }
    res.json({ success: true, accounts: shown(accounts), notices });
  }));

  app.post("/api/bank/lunchflow", once("lunchflow", async (owner, req, res) => {
    const key = typeof (req.body && req.body.apiKey) === "string" ? req.body.apiKey.trim() : "";
    if (!feeds.validLunchflowKey(key)) return res.status(400).json({ error: "Paste the key Lunch Flow shows in your REST API destination." });
    let list;
    try { list = await feeds.lunchflowAccounts(key, feedOpts); }
    catch (e) {
      console.log(`[bank] Lunch Flow key check failed: ${outcome(e)}`);
      if (e.kind === "auth") return res.status(400).json({ error: "Lunch Flow didn't accept that key. Copy it again from your REST API destination under Destinations in Lunch Flow and paste it here." });
      if (e.kind === "rate") return res.status(429).json({ error: "Lunch Flow asked Closedhand to slow down. Try again in a few minutes." });
      if (e.kind === "payment") return res.status(400).json({ error: "Lunch Flow says your Lunch Flow subscription needs paying. Once it's paid, paste the key again." });
      return res.status(503).json({ error: "Couldn't reach Lunch Flow. Check the computer running Closedhand is online, then try again." });
    }
    const accounts = list.map((a) => ({ id: a.id, name: a.name, institution: a.institution, currency: a.currency, balance: null, available: null, as_of: null, status: a.status }));
    const notices = accounts.length ? [] : [NO_ACCOUNTS];
    try { await save(owner, "lunchflow", { api_key: key }, accounts, notices); }
    catch (e) {
      console.error(`[bank] Lunch Flow connection not saved: ${e.message}`);
      return res.status(500).json({ error: "Closedhand couldn't save the connection. Try again." });
    }
    res.json({ success: true, accounts: shown(accounts), notices });
  }));
}

module.exports = { register };
