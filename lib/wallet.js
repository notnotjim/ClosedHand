// lib/wallet.js — cards the person added in Settings, typed into a checkout
// for them, never shown to the model.
//
// The number and security code live encrypted in wallet_cards. When the
// model asks for a card to be filled in, this module decrypts it here in
// the bot and hands the values straight to the browser helper in the sandbox,
// which types them into the card fields it can find on the current page,
// across frames (most payment forms sit in one). What comes back is which
// fields were filled, never what was typed. The pay button that follows is
// gated by spend-guard, with the card's own limits applied.

const { supabase } = require("./db");
const { decryptString } = require("../crypto-tokens");

// userId -> { cardId, last4, brand, label, limits, at } for the gate to use.
const _lastFill = new Map();

function noteCardFill(userId, card) {
  _lastFill.set(userId, { cardId: card.id, last4: card.last4, brand: card.brand, label: card.label, limits: card.limits || {}, at: Date.now() });
}

// A fill is spent by the purchase it was for: the next purchase needs a
// fresh fill_card, which reloads the card and its limits.
function clearCardFill(userId) {
  _lastFill.delete(userId);
}

function lastCardFill(userId) {
  const f = _lastFill.get(userId);
  if (!f || Date.now() - f.at > 20 * 60 * 1000) return null;
  return f;
}

async function listCards(userId) {
  const { data, error } = await supabase
    .from("wallet_cards")
    .select("id, label, brand, last4, exp_month, exp_year, holder, limits, is_default, created_at")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) { console.error("[wallet] list failed:", error.message); return []; }
  return data || [];
}

// ref: "default", a last4, a label, or an id.
async function findCard(userId, ref) {
  const cards = await listCards(userId);
  if (!cards.length) return null;
  const want = String(ref || "default").trim().toLowerCase();
  if (want === "default" || want === "") return cards.find((c) => c.is_default) || cards[0];
  return cards.find((c) => c.id === want)
    || cards.find((c) => c.last4 === want.replace(/\D/g, "").slice(-4) && want.replace(/\D/g, "").length >= 4)
    || cards.find((c) => String(c.label || "").toLowerCase() === want)
    || cards.find((c) => String(c.label || "").toLowerCase().includes(want) || String(c.brand || "").toLowerCase() === want)
    || null;
}

async function loadSecret(userId, cardId) {
  const { data, error } = await supabase
    .from("wallet_cards")
    .select("id, label, brand, last4, exp_month, exp_year, holder, enc_number, enc_cvc, billing, limits, is_default")
    .eq("user_id", userId)
    .eq("id", cardId)
    .single();
  if (error || !data) return null;
  const number = decryptString(data.enc_number);
  const cvc = data.enc_cvc ? decryptString(data.enc_cvc) : "";
  if (!number || /^enc:/.test(number)) return null; // no key to decrypt with
  return { ...data, number, cvc };
}

// The python that finds card fields on the current page, in any frame, and
// types the values. Values are embedded as JSON literals for this one run;
// the result only says which fields were filled.
function fillScript(card) {
  const exp2 = String(card.exp_month).padStart(2, "0");
  const yy = String(card.exp_year).slice(-2);
  const yyyy = String(card.exp_year).length === 2 ? "20" + card.exp_year : String(card.exp_year);
  const vals = {
    number: String(card.number).replace(/\s+/g, ""),
    exp: `${exp2}/${yy}`,
    exp_month: exp2,
    exp_year_2: yy,
    exp_year_4: yyyy,
    cvc: String(card.cvc || ""),
    name: String(card.holder || ""),
    postcode: String((card.billing && (card.billing.postcode || card.billing.zip)) || ""),
  };
  return `
import json
from browser_helper import _get_browser, _page
V = json.loads(${JSON.stringify(JSON.stringify(vals))})
FIELDS = [
  ("number", ['input[autocomplete="cc-number"]', 'input[name*="cardnumber" i]', 'input[name*="card_number" i]', 'input[name*="card-number" i]', 'input[id*="cardnumber" i]', 'input[id*="card_number" i]', 'input[id*="cardNumber"]', 'input[placeholder*="card number" i]', 'input[name="number"]', 'input[data-elements-stable-field-name="cardNumber"]', 'input[name="cardnumber"]']),
  ("exp", ['input[autocomplete="cc-exp"]', 'input[name*="exp" i][name*="date" i]', 'input[name="exp-date"]', 'input[placeholder*="MM" i][placeholder*="YY" i]', 'input[id*="expiry" i]', 'input[name*="expiry" i]']),
  ("exp_month", ['input[autocomplete="cc-exp-month"]', 'select[autocomplete="cc-exp-month"]', 'input[name*="exp" i][name*="month" i]', 'select[name*="exp" i][name*="month" i]']),
  ("exp_year", ['input[autocomplete="cc-exp-year"]', 'select[autocomplete="cc-exp-year"]', 'input[name*="exp" i][name*="year" i]', 'select[name*="exp" i][name*="year" i]']),
  ("cvc", ['input[autocomplete="cc-csc"]', 'input[name*="cvc" i]', 'input[name*="cvv" i]', 'input[name*="csc" i]', 'input[name*="security" i][name*="code" i]', 'input[id*="cvc" i]', 'input[id*="cvv" i]', 'input[placeholder*="CVC" i]', 'input[placeholder*="CVV" i]']),
  ("name", ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]', 'input[name*="card" i][name*="name" i]', 'input[id*="cardholder" i]', 'input[placeholder*="name on card" i]']),
  ("postcode", ['input[autocomplete="postal-code"]', 'input[name*="postal" i]', 'input[name*="postcode" i]', 'input[name*="zip" i]']),
]

def try_fill(fr, key, sel):
    try:
        el = fr.query_selector(sel)
        if not el or not el.is_visible():
            return False
        tag = (el.evaluate("e => e.tagName") or "").lower()
        if tag == "select":
            want = V["exp_month"] if key == "exp_month" else None
            if key == "exp_year":
                for w in (V["exp_year_4"], V["exp_year_2"]):
                    try:
                        el.select_option(value=w); return True
                    except Exception:
                        try:
                            el.select_option(label=w); return True
                        except Exception:
                            pass
                return False
            if want is None:
                return False
            for w in (want, str(int(want))):
                try:
                    el.select_option(value=w); return True
                except Exception:
                    try:
                        el.select_option(label=w); return True
                    except Exception:
                        pass
            return False
        val = V["number"] if key == "number" else V["exp"] if key == "exp" else V["exp_month"] if key == "exp_month" else V["exp_year_2"] if key == "exp_year" else V["cvc"] if key == "cvc" else V["name"] if key == "name" else V["postcode"]
        if not val:
            return False
        el.click()
        try:
            el.fill("")
        except Exception:
            pass
        el.type(val, delay=35)
        return True
    except Exception:
        return False

pw, browser, context = _get_browser()
try:
    page = _page(context)
    filled = {}
    frames = [page.main_frame] + [f for f in page.frames if f != page.main_frame]
    for key, sels in FIELDS:
        if key in ("exp_month", "exp_year") and filled.get("exp"):
            continue
        for fr in frames:
            done = False
            for sel in sels:
                if try_fill(fr, key, sel):
                    filled[key] = True; done = True; break
            if done:
                break
    page.wait_for_timeout(400)
    print(json.dumps({"filled": filled, "url": page.url, "title": page.title(), "frames": len(frames)}))
finally:
    browser.close()
    pw.stop()
`;
}

module.exports = { listCards, findCard, loadSecret, fillScript, noteCardFill, lastCardFill, clearCardFill };
