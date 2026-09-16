// lib/fx.js -- one currency into another, for spending limits.
//
// Limits are set in one currency and checkouts arrive in whatever the shop
// charges. They used to be compared as bare numbers, so a £20 limit refused a
// 300,000 dong lunch and waved through a £45 basket against a $50 limit.
// Rates come from a keyless daily source, are kept for a day, and when none
// can be had the comparison is left to the person rather than guessed.
const SOURCE = "https://open.er-api.com/v6/latest/USD";
const KEEP_MS = 24 * 3600 * 1000;
let _rates = null, _at = 0, _inflight = null;
async function rates() {
  if (_rates && Date.now() - _at < KEEP_MS) return _rates;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const { body, statusCode } = await require("./http").httpGet(SOURCE, { "User-Agent": "ClosedHand/1.0", "Accept": "application/json" });
      const data = statusCode < 400 ? JSON.parse(body) : null;
      if (data?.result === "success" && data.rates?.USD === 1) { _rates = data.rates; _at = Date.now(); }
    } catch (e) { console.warn(`[fx] rates unavailable: ${e.message}`); }
    finally { _inflight = null; }
    return _rates;
  })();
  return _inflight;
}
// Returns the amount in `to`, or null when it cannot be known.
async function convert(amount, from, to) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  const f = String(from || "").toUpperCase(), t = String(to || "").toUpperCase();
  if (!f || !t || f === t) return Number(amount);
  const r = await rates();
  if (!r || !r[f] || !r[t]) return null;
  return Number(amount) / r[f] * r[t];
}
function _setRatesForTests(r) { _rates = r; _at = r ? Date.now() : 0; }
module.exports = { convert, rates, _setRatesForTests };
