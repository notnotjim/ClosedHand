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
//
// Addresses are typed the same way: the card's billing address with the
// card, and the delivery address by fill_address. Unlike a card number, an
// address is not kept from the model (the checkout shows it back); typing
// it from Settings is what makes it exact.

const { supabase } = require("./db");
const { decryptString } = require("../crypto-tokens");

// userId -> { cardId, last4, brand, label, limits, at } for the gate to use.
const _lastFill = new Map();
// userId -> { label, line, at }: the delivery address typed for the purchase.
const _lastAddress = new Map();

function noteCardFill(userId, card) {
  _lastFill.set(userId, { cardId: card.id, last4: card.last4, brand: card.brand, label: card.label, limits: card.limits || {}, at: Date.now() });
}

function noteAddressFill(userId, address) {
  _lastAddress.set(userId, { label: address.label, line: oneLine(address), at: Date.now() });
}

// Fills are spent by the purchase they were for: the next purchase needs a
// fresh fill_card, which reloads the card and its limits, and its own
// delivery address.
function clearFills(userId) {
  _lastFill.delete(userId);
  _lastAddress.delete(userId);
}

function lastCardFill(userId) {
  const f = _lastFill.get(userId);
  if (!f || Date.now() - f.at > 20 * 60 * 1000) return null;
  return f;
}

function lastAddressFill(userId) {
  const f = _lastAddress.get(userId);
  if (!f || Date.now() - f.at > 20 * 60 * 1000) return null;
  return f;
}

function countryName(code) {
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(String(code).toUpperCase()) || ""; } catch { return ""; }
}

// "1 High Street, London, SW1A 1AA, United Kingdom"
function oneLine(a) {
  return [a.line1, a.line2, a.city, a.region, a.postcode, a.country ? countryName(a.country) : ""].filter(Boolean).join(", ");
}

// Addresses the person saved under Wallet, home first.
async function listAddresses(userId) {
  const { data, error } = await supabase
    .from("wallet_addresses")
    .select("id, label, name, line1, line2, city, region, postcode, country, phone, is_home")
    .eq("user_id", userId)
    .order("is_home", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) { console.error("[wallet] addresses failed:", error.message); return []; }
  return data || [];
}

// ref: "home" (or nothing), a label, or an id. Returns every address too, so
// a miss can say which ones there are.
async function findAddress(userId, ref) {
  const all = await listAddresses(userId);
  const want = String(ref || "home").trim().toLowerCase();
  const home = all.find((a) => a.is_home) || all[0] || null;
  if (want === "home" || want === "default") return { address: home, all };
  const address = all.find((a) => a.id === want)
    || all.find((a) => String(a.label).toLowerCase() === want)
    || all.find((a) => String(a.label).toLowerCase().includes(want))
    || null;
  return { address, all };
}

// Where a card is billed: the address it names, else home. A card added
// before addresses existed may carry only its postcode.
async function billingFor(userId, card) {
  const all = await listAddresses(userId);
  const id = card.billing && card.billing.address_id;
  const address = (id && all.find((a) => a.id === id)) || all.find((a) => a.is_home) || all[0];
  if (address) return address;
  const postcode = card.billing && (card.billing.postcode || card.billing.zip);
  return postcode ? { postcode: String(postcode) } : null;
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

// Names shops use for a country besides the one Intl gives.
const COUNTRY_ALIASES = { GB: ["UK", "Great Britain"], US: ["USA", "United States of America"] };

// An address as the fill script reads it: the name split for forms that ask
// first and last apart, and the country as its code plus the names a
// dropdown may list it by.
function addressValues(a, name) {
  const full = String(name || a.name || "").trim();
  const sp = full.lastIndexOf(" ");
  const code = String(a.country || "").toUpperCase();
  return {
    name: full, first: sp > 0 ? full.slice(0, sp) : full, last: sp > 0 ? full.slice(sp + 1) : "",
    line1: a.line1 || "", line2: a.line2 || "", city: a.city || "", region: a.region || "",
    postcode: a.postcode || "", phone: a.phone || "",
    country: code, country_names: code ? [countryName(code), ...(COUNTRY_ALIASES[code] || [])].filter(Boolean) : [],
  };
}

// The python that types an address into the page, shared by the card fill
// (billing) and fill_address (delivery). A field is recognised by its
// autocomplete token, else by the words in its name, id, placeholder and
// label; one marked for the other kind of address is left alone. The
// billing pass also leaves unmarked fields that already hold something,
// since on a one-page checkout those are the delivery address. Country goes
// first, because changing it redraws the rest of many forms.
const ADDRESS_PY = String.raw`
import re

INFO_JS = """e => {
  const norm = s => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([a-zA-Z])([0-9])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ').toLowerCase().trim();
  const label = e.labels && e.labels[0] ? e.labels[0].innerText : '';
  return { tag: e.tagName.toLowerCase(), type: (e.getAttribute('type') || '').toLowerCase(),
    ac: (e.getAttribute('autocomplete') || '').toLowerCase(),
    words: norm([e.name, e.id, e.getAttribute('placeholder'), e.getAttribute('aria-label'), label].join(' ')),
    value: e.value || '' };
}"""

def _rx(words):
    return re.compile("(?<![a-z])(?:" + words + ")(?![a-z])")

AC = {"address-line1": "line1", "street-address": "line1", "address-line2": "line2", "address-level2": "city",
      "address-level1": "region", "postal-code": "postcode", "country": "country", "country-name": "country",
      "name": "name", "given-name": "first", "family-name": "last", "tel": "phone", "tel-national": "phone"}
SKIP = _rx("card|cc|cvc|cvv|expiry|expiration|search|coupon|promo|voucher|gift|discount|email|e mail|password|company|organisation|organization|business|vat|tax|note|notes|instructions|comment|message")
WORDS = [
    ("line2", _rx("address 2|address line 2|line 2|apartment|apt|suite|flat|unit|building")),
    ("line1", _rx("address 1|address line 1|line 1|street|street address|address")),
    ("postcode", _rx("postcode|post code|postal|postal code|zip|zipcode|zip code|eircode")),
    ("city", _rx("city|town|locality|suburb")),
    ("country", _rx("country")),
    ("region", _rx("state|county|province|region")),
    ("first", _rx("first name|firstname|given name|forename|fname")),
    ("last", _rx("last name|lastname|surname|family name|lname")),
    ("name", _rx("full name|fullname|recipient|name")),
    ("phone", _rx("phone|mobile|telephone|tel|phone number")),
]
SHIP = _rx("ship|shipping|delivery|deliver")
BILL = _rx("bill|billing")

def _part(info):
    toks = info["ac"].split()
    for t in toks:
        if t in AC:
            return AC[t]
    if SKIP.search(info["words"]) or SKIP.search(info["ac"].replace("-", " ")):
        return None
    for part, rx in WORDS:
        if rx.search(info["words"]):
            return part
    return None

def _section(info):
    toks = info["ac"].split()
    if "shipping" in toks or SHIP.search(info["words"]):
        return "shipping"
    if "billing" in toks or BILL.search(info["words"]):
        return "billing"
    return ""

def _fields(page, kind, only_empty_plain):
    other = "billing" if kind == "shipping" else "shipping"
    best = {}
    for fr in [page.main_frame] + [f for f in page.frames if f != page.main_frame]:
        try:
            els = fr.query_selector_all("input, select, textarea")
        except Exception:
            continue
        for el in els:
            try:
                if not el.is_visible():
                    continue
                info = el.evaluate(INFO_JS)
            except Exception:
                continue
            if info["tag"] == "input" and info["type"] not in ("", "text", "tel", "number"):
                continue
            part = _part(info)
            sec = _section(info)
            if not part or sec == other:
                continue
            if sec == "" and only_empty_plain and info["value"].strip():
                continue
            rank = 0 if sec == kind else 1
            if part not in best or rank < best[part][0]:
                best[part] = (rank, el, info)
    return best

def _norm(s):
    return re.sub("[^a-z0-9]+", " ", str(s).lower()).strip()

def _put(el, info, val, alts=()):
    if info["tag"] == "select":
        want = [_norm(w) for w in (val,) + tuple(alts) if w]
        try:
            opts = el.evaluate("e => Array.from(e.options).map(o => [o.value, o.text])")
        except Exception:
            return False
        for v, t in opts:
            nv, nt = _norm(v), _norm(t)
            if any(w == nv or w == nt or (len(w) > 3 and nt.startswith(w)) for w in want):
                try:
                    el.select_option(value=v)
                    return True
                except Exception:
                    return False
        return False
    try:
        el.click()
        try:
            el.fill("")
        except Exception:
            pass
        el.type(val, delay=20)
        return True
    except Exception:
        return False

def fill_address(page, A, kind, only_empty_plain):
    filled = []
    if A.get("country"):
        f = _fields(page, kind, only_empty_plain).get("country")
        if f and _put(f[1], f[2], A["country"], tuple(A.get("country_names") or ())):
            filled.append("country")
            page.wait_for_timeout(500)
    fields = _fields(page, kind, only_empty_plain)
    for part in ("name", "first", "last", "line1", "line2", "city", "region", "postcode", "phone"):
        f = fields.get(part)
        if f and A.get(part) and _put(f[1], f[2], A[part]):
            filled.append(part)
    left = {p: A[p] for p in ("name", "line1", "line2", "city", "region", "postcode", "country", "phone") if A.get(p) and p not in filled}
    if any(p in filled for p in ("name", "first", "last")):
        left.pop("name", None)
    if kind == "billing":
        # The card's own name field takes the name, and billing never needs a phone.
        left.pop("name", None)
        left.pop("phone", None)
    return {"filled": filled, "not_placed": left}
`;

// The python that finds card fields on the current page, in any frame, and
// types the values, then the card's billing address where the page asks for
// one. Values are embedded as JSON literals for this one run; the result
// says which fields were filled, and which parts of the address found no
// field. engine: the sandbox computer's browser the checkout is open in,
// visible or hidden (lib/browse-engine.js).
function fillScript(card, engine = "visible", billing = null) {
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
  };
  const bill = billing ? addressValues(billing, card.holder) : null;
  return `
import json
from browser_helper import _get_browser, _page
V = json.loads(${JSON.stringify(JSON.stringify(vals))})
B = json.loads(${JSON.stringify(JSON.stringify(bill))})
${ADDRESS_PY}
FIELDS = [
  ("number", ['input[autocomplete="cc-number"]', 'input[name*="cardnumber" i]', 'input[name*="card_number" i]', 'input[name*="card-number" i]', 'input[id*="cardnumber" i]', 'input[id*="card_number" i]', 'input[id*="cardNumber"]', 'input[placeholder*="card number" i]', 'input[name="number"]', 'input[data-elements-stable-field-name="cardNumber"]', 'input[name="cardnumber"]']),
  ("exp", ['input[autocomplete="cc-exp"]', 'input[name*="exp" i][name*="date" i]', 'input[name="exp-date"]', 'input[placeholder*="MM" i][placeholder*="YY" i]', 'input[id*="expiry" i]', 'input[name*="expiry" i]']),
  ("exp_month", ['input[autocomplete="cc-exp-month"]', 'select[autocomplete="cc-exp-month"]', 'input[name*="exp" i][name*="month" i]', 'select[name*="exp" i][name*="month" i]']),
  ("exp_year", ['input[autocomplete="cc-exp-year"]', 'select[autocomplete="cc-exp-year"]', 'input[name*="exp" i][name*="year" i]', 'select[name*="exp" i][name*="year" i]']),
  ("cvc", ['input[autocomplete="cc-csc"]', 'input[name*="cvc" i]', 'input[name*="cvv" i]', 'input[name*="csc" i]', 'input[name*="security" i][name*="code" i]', 'input[id*="cvc" i]', 'input[id*="cvv" i]', 'input[placeholder*="CVC" i]', 'input[placeholder*="CVV" i]']),
  ("name", ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]', 'input[name*="card" i][name*="name" i]', 'input[id*="cardholder" i]', 'input[placeholder*="name on card" i]']),
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
        val = V["number"] if key == "number" else V["exp"] if key == "exp" else V["exp_month"] if key == "exp_month" else V["exp_year_2"] if key == "exp_year" else V["cvc"] if key == "cvc" else V["name"]
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

pw, browser, context = _get_browser(${JSON.stringify(engine === "headless" ? "headless" : "visible")})
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
    billing = fill_address(page, B, "billing", True) if B else None
    page.wait_for_timeout(400)
    print(json.dumps({"filled": filled, "billing_address": billing, "url": page.url, "title": page.title(), "frames": len(frames)}))
finally:
    browser.close()
    pw.stop()
`;
}

// The python that types a saved address into the delivery form on the
// current page.
function addressScript(address, engine = "visible") {
  return `
import json
from browser_helper import _get_browser, _page
A = json.loads(${JSON.stringify(JSON.stringify(addressValues(address)))})
${ADDRESS_PY}
pw, browser, context = _get_browser(${JSON.stringify(engine === "headless" ? "headless" : "visible")})
try:
    page = _page(context)
    out = fill_address(page, A, "shipping", False)
    page.wait_for_timeout(400)
    out.update({"url": page.url, "title": page.title()})
    print(json.dumps(out))
finally:
    browser.close()
    pw.stop()
`;
}

module.exports = {
  listCards, findCard, loadSecret, fillScript, noteCardFill, lastCardFill, clearFills,
  listAddresses, findAddress, billingFor, addressScript, noteAddressFill, lastAddressFill, oneLine, countryName,
};
