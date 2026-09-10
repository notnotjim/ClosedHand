// lib/spend-guard.js — money is put to the person first, in code, not in prose.
//
// ClosedHand drives a real browser with the person's own logged-in sessions,
// so on a site with a saved card it can reach Pay and click it. Until now the
// only thing between it and a purchase was a sentence in the system prompt.
// This module is the gate: it recognises a click, submit or script that would
// pay, reads the checkout page for the merchant and the total, checks the
// person's limits and the ledger, and hands the engine what it needs to ask
// properly ("I'm about to pay £87.40 at trainline.com"). Every purchase, asked
// or automatic, lands in spend_ledger.

const { supabase } = require("./db");

// Words on a button or in a script that mean "this spends money".
const PAY_WORDS = /\b(pay(?:\s*now)?|pay\s*&\s*book|place\s+(?:your\s+|my\s+)?order|buy\s*now|buy\s+ticket|complete\s+(?:purchase|order|booking|payment|checkout)|confirm\s+(?:and\s+pay|purchase|order|booking|payment|subscription)|book\s*(?:now|and\s+pay)|check\s*out|checkout|purchase|subscribe|start\s+(?:free\s+)?trial|order\s*now|submit\s+(?:order|payment)|proceed\s+to\s+pay(?:ment)?|make\s+payment|reserve\s*(?:now|and\s+pay)|confirm\s+reservation|add\s+funds|top\s*up)\b/i;

// A URL that is a checkout, where any submit is probably a purchase.
const CHECKOUT_URL = /checkout|payment|\/pa(?:y(?:ing|ment|ments)?|id)\b|basket|cart|order(?:s)?\/(?:review|confirm|summary|new|place)|book(?:ing)?\/(?:review|confirm|pay)|purchase|billing|subscribe|review-and-pay|secure/i;

// Never: a password reset or change form, which is how one agent finished a
// purchase it had no business finishing.
const PASSWORD_FORM = /reset[-_\s]?password|forgot[-_\s]?password|change[-_\s]?password|password[-_\s]?reset|new[-_\s]?password|update[-_\s]?password|recover[-_\s]?(?:account|password)/i;

// userId -> { url, title, at } from the last browser action, so a click on a
// checkout page can be recognised without another round trip.
const _lastPage = new Map();

function notePage(userId, url, title) {
  if (!userId || !url) return;
  _lastPage.set(userId, { url: String(url), title: String(title || ""), at: Date.now() });
}

function lastPage(userId) {
  const p = _lastPage.get(userId);
  if (!p || Date.now() - p.at > 30 * 60 * 1000) return null;
  return p;
}

function textOf(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

// Does this tool call touch a password form? Returns a reason or null.
function touchesPasswordForm(toolName, input) {
  if (!/^(sandbox_browse|bridge_browser_|bridge_input_|bridge_ax_)/.test(toolName)) return null;
  const blob = [input.url, input.selector, input.text, input.script, textOf(input.steps), input.value].map(textOf).join(" ");
  if (PASSWORD_FORM.test(blob)) return "That is a password reset or change form. ClosedHand never resets or changes a password; ask the user to do it themselves.";
  const page = lastPage(input._userId);
  if (page && PASSWORD_FORM.test(page.url + " " + page.title) && /^(sandbox_browse|bridge_browser_)/.test(toolName) && /click|fill|press|batch|eval_js|type|execute/.test(input.action || toolName)) {
    return "This page is a password reset or change form. ClosedHand never resets or changes a password; ask the user to do it themselves.";
  }
  return null;
}

// Would this tool call spend money? Returns { kind, why } or null.
function spendIntent(toolName, input) {
  if (!input || typeof input !== "object") return null;
  const page = lastPage(input._userId);
  const onCheckout = !!(page && CHECKOUT_URL.test(page.url + " " + page.title));

  if (toolName === "sandbox_browse") {
    const a = input.action;
    const sel = textOf(input.selector);
    const at = input.url ? String(input.url) : null;
    if (a === "click" || a === "press" || (a === "fill" && input.submit)) {
      if (PAY_WORDS.test(sel) || PAY_WORDS.test(textOf(input.text))) return { kind: "click", why: "the button says it pays", at };
      if ((onCheckout || (at && CHECKOUT_URL.test(at))) && (a === "press" ? /enter/i.test(textOf(input.key)) : /submit|button|btn|pay|order|confirm|continue|complete|book/i.test(sel))) return { kind: "click", why: "a submit on a checkout page", at };
    }
    if (a === "eval_js") {
      const s = textOf(input.script);
      if (/\.(click|submit|requestSubmit)\(/.test(s) && (PAY_WORDS.test(s) || onCheckout)) return { kind: "script", why: "a script that presses pay", at };
    }
    if (a === "batch" && Array.isArray(input.steps)) {
      // The page the paying step lands on is the last address the sequence
      // opens before it, so the checkout can be read there and not on
      // whatever page the browser was left on.
      let where = at;
      for (const st of input.steps) {
        if (!st || typeof st !== "object") continue;
        if (st.url) where = String(st.url);
        const s = textOf(st);
        const stepUrl = textOf(st.url);
        if (/"action":"(click|press|fill)"/.test(JSON.stringify(st)) && (PAY_WORDS.test(textOf(st.selector)) || PAY_WORDS.test(textOf(st.text)))) return { kind: "click", why: "a step in this sequence pays", at: where };
        if (/"action":"(click|press)"|"submit":true/.test(JSON.stringify(st)) && (onCheckout || CHECKOUT_URL.test(stepUrl) || (where && CHECKOUT_URL.test(where)))) return { kind: "click", why: "a submit on a checkout page within this sequence", at: where };
        if (/\.(click|submit|requestSubmit)\(/.test(s) && PAY_WORDS.test(s)) return { kind: "script", why: "a script in this sequence presses pay", at: where };
      }
    }
    return null;
  }

  if (toolName === "sandbox_exec") {
    const code = textOf(input.code);
    const drivesBrowser = /connect_over_cdp|browser_helper|playwright|puppeteer|selenium|CDP_URL|chrome-remote|localhost:9222/i.test(code);
    const acts = /\.(click|submit|requestSubmit|press|tap)\s*\(/.test(code) || /keyboard\.press\(\s*["']Enter/i.test(code);
    if (drivesBrowser && acts && (PAY_WORDS.test(code) || CHECKOUT_URL.test(code) || onCheckout)) return { kind: "script", why: "a script driving the browser through a payment", at: (code.match(/https?:\/\/[^\s"'\\)]+/i) || [null])[0] };
    const sendsRequest = /\bcurl\b|\bwget\b|fetch\s*\(|requests\.(post|put|patch)|\.post\s*\(|http\.request|axios|urllib|XMLHttpRequest|Invoke-WebRequest|httpx/i.test(code);
    const writes = /-X\s*(POST|PUT|PATCH)|--data|\s-d\s|method\s*[:=]\s*["']?(POST|PUT|PATCH)|requests\.(post|put|patch)|\.post\s*\(|axios\.(post|put)|body\s*[:=]/i.test(code);
    let sameHost = false;
    try { sameHost = !!(page && new URL(page.url).host && code.includes(new URL(page.url).host)); } catch { /* no page */ }
    if (sendsRequest && writes && (PAY_WORDS.test(code) || CHECKOUT_URL.test(code) || (onCheckout && sameHost) || /stripe\.com|paypal\.com|adyen|braintree|klarna/i.test(code))) return { kind: "api", why: "a direct request to a payment endpoint", hard: true };
    return null;
  }

  if (/^bridge_(browser|input|ax)_/.test(toolName)) {
    const blob = [input.selector, input.text, input.script, input.value, input.label].map(textOf).join(" ");
    if (PAY_WORDS.test(blob)) return { kind: "click", why: "the button says it pays" };
    if (onCheckout && /click|key|press|execute|submit/.test(toolName)) return { kind: "click", why: "an action on a checkout page" };
    return null;
  }

  if (toolName === "api_request" || toolName === "sandbox_gateway") {
    const m = String(input.method || "GET").toUpperCase();
    if (m === "GET") return null;
    const u = textOf(input.url);
    if (/stripe\.com\/v1\/(charges|payment_intents|checkout|subscriptions|invoices\/[^/]+\/pay)|paypal\.com\/v[12]\/(checkout|payments|orders)|api\.(square|adyen|braintree|klarna)|\/checkout|\/payments?\b|\/orders?\b.*confirm|\/purchase/i.test(u)) return { kind: "api", why: "a payment request to a provider", hard: true };
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the checkout page
// ---------------------------------------------------------------------------

const AMOUNT_RE = /(?:£|€|\$|US\$|CA\$|A\$|USD|GBP|EUR|CHF|¥|kr)\s?\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{2})?|\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{2})?\s?(?:GBP|EUR|USD|CHF|SEK|NOK|DKK|PLN|zł|kr|€|£)/g;
const TOTAL_LINE = /\b(grand\s+total|order\s+total|total\s+(?:to\s+pay|due|cost|price|amount)|amount\s+due|you\s+pay|to\s+pay|total)\b/i;

function parseAmount(s) {
  const m = String(s || "").match(/([£€$¥]|US\$|CA\$|A\$|USD|GBP|EUR|CHF|SEK|NOK|DKK|PLN|zł|kr)?\s?(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{2})?)\s?([£€$]|USD|GBP|EUR|CHF|SEK|NOK|DKK|PLN|zł|kr)?/);
  if (!m) return null;
  let num = m[2];
  // 1.234,56 (continental) vs 1,234.56
  if (/,\d{2}$/.test(num) && !/\.\d{2}$/.test(num)) num = num.replace(/\./g, "").replace(",", ".");
  else num = num.replace(/,/g, "");
  const value = Number(num);
  if (!Number.isFinite(value)) return null;
  const sym = (m[1] || m[3] || "").replace(/\s/g, "");
  const currency = { "£": "GBP", "€": "EUR", "$": "USD", "US$": "USD", "CA$": "CAD", "A$": "AUD", "¥": "JPY", "zł": "PLN", "kr": "SEK" }[sym] || sym.toUpperCase() || null;
  return { value, currency, text: m[0].trim() };
}

// Pull the total out of page text: the last line that says "total" and
// carries an amount, else the largest amount on the page.
function extractTotal(text) {
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let best = null;
  const seen = [];
  for (const line of lines) {
    const amounts = line.match(AMOUNT_RE) || [];
    if (!amounts.length) continue;
    for (const a of amounts) { const p = parseAmount(a); if (p && p.value > 0) seen.push(p); }
    if (TOTAL_LINE.test(line)) {
      const p = parseAmount(amounts[amounts.length - 1]);
      if (p && p.value > 0) best = p;
    }
  }
  if (!best && seen.length) best = seen.reduce((a, b) => (b.value > a.value ? b : a));
  return { total: best, amounts: seen.slice(-6) };
}

// What the browser is looking at right now: url, title and the total, read
// through the same helper the browse tool uses. One round trip, only paid
// when a purchase is in front of us.
async function readCheckout(userId, navigateTo) {
  try {
    const { ensureSandbox, sandboxExec } = require("./sandbox");
    await ensureSandbox(userId);
    const target = navigateTo && /^https?:\/\//i.test(String(navigateTo)) ? JSON.stringify(String(navigateTo)) : "None";
    const code = `
import json
from browser_helper import _get_browser, _page
pw, browser, context = _get_browser()
try:
    page = _page(context, ${target})
    out = {"url": page.url, "title": page.title()}
    try:
        out["text"] = page.inner_text("body")[:30000]
    except Exception as e:
        out["text"] = ""
        out["text_error"] = str(e)
    print(json.dumps(out))
finally:
    browser.close()
    pw.stop()
`;
    const r = await sandboxExec(userId, "python", code, 30000);
    if (!r || !r.stdout) return null;
    const parsed = JSON.parse(r.stdout);
    const { total, amounts } = extractTotal(parsed.text || "");
    let host = null;
    try { host = new URL(parsed.url).hostname.replace(/^www\./, ""); } catch { /* not a url */ }
    return { url: parsed.url, title: parsed.title, host, total, amounts };
  } catch (e) {
    console.error("[spend-guard] could not read the checkout page:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Limits and the ledger
// ---------------------------------------------------------------------------

function limitsFor(userStore) {
  const s = (userStore && userStore.profile && userStore.profile.settings) || {};
  const l = s.spend_limits || {};
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    per_purchase: num(l.per_purchase),
    per_day: num(l.per_day),
    per_month: num(l.per_month),
    auto_under: num(l.auto_under),
    currency: l.currency || null,
    always_ask: l.always_ask !== false,
  };
}

async function spentSince(userId, sinceIso) {
  const { data, error } = await supabase
    .from("spend_ledger")
    .select("amount")
    .eq("user_id", userId)
    .in("status", ["approved", "auto", "completed"])
    .gte("created_at", sinceIso);
  if (error) { console.error("[spend-guard] ledger read failed:", error.message); return 0; }
  return (data || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
}

async function recentSame(userId, host, amount) {
  if (!host) return null;
  const since = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("spend_ledger")
    .select("id, amount, status, created_at")
    .eq("user_id", userId)
    .eq("host", host)
    .in("status", ["approved", "auto", "completed"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) return null;
  return (data || []).find((r) => amount == null || r.amount == null || Math.abs(Number(r.amount) - amount) < 0.005) || null;
}

async function ledgerInsert(row) {
  const { data, error } = await supabase.from("spend_ledger").insert(row).select("id").single();
  if (error) { console.error("[spend-guard] ledger insert failed:", error.message); return null; }
  return data ? data.id : null;
}

async function ledgerUpdate(id, patch) {
  if (!id) return;
  const { data, error } = await supabase.from("spend_ledger").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("user_id").single();
  if (error) console.error("[spend-guard] ledger update failed:", error.message);
  // Once a purchase is over, the card filled for it is spent too.
  if (data && data.user_id && /^(completed|failed|declined|refused)$/.test(String(patch.status || ""))) {
    try { require("./wallet").clearCardFill(data.user_id); } catch { /* wallet optional */ }
  }
}

// The decision for one would-be purchase. Returns:
//   { action: "refuse", message }        over a limit, or the same purchase again within minutes without the person asking
//   { action: "allow", ledgerId, card }  under the auto threshold
//   { action: "ask", ledgerId, card }    put it to the person; card is the text to show
async function assess({ userId, userStore, toolName, source, intent, page }) {
  const wallet = require("./wallet");
  let fill = wallet.lastCardFill(userId);
  if (fill) {
    // The card's rules as they are now, not as they were when it was filled.
    const fresh = (await wallet.listCards(userId)).find((c) => c.id === fill.cardId);
    fill = fresh ? { ...fill, limits: fresh.limits || {}, label: fresh.label, brand: fresh.brand } : null;
  }
  if (intent && intent.hard) {
    await ledgerInsert({ user_id: userId, status: "refused", source, tool: toolName, note: intent.why });
    return { action: "refuse", message: "Not done. Paying for anything happens in the browser, on the page, with the user's yes, never by calling a site or a payment provider directly. Open the checkout in the browser and press its own button." };
  }
  const limits = limitsFor(userStore);
  // A card's own limits win over the general ones where the card sets them.
  if (fill && fill.limits) {
    for (const k of ["per_purchase", "per_day", "per_month", "auto_under"]) {
      const v = fill.limits[k];
      if (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))) limits[k] = Number(v);
    }
    if (fill.limits.always_ask === false) limits.always_ask = false;
    if (fill.limits.always_ask === true) limits.always_ask = true;
  }
  const total = page && page.total ? page.total : null;
  const amount = total ? total.value : null;
  const host = page && page.host ? page.host : null;
  const merchant = host ? host.split(".").slice(-2, -1)[0] : null;
  const where = host ? `${host}${page.title ? ` ("${String(page.title).slice(0, 60)}")` : ""}` : "this site";

  const base = {
    user_id: userId, host, url: page && page.url ? String(page.url).slice(0, 500) : null, title: page && page.title ? String(page.title).slice(0, 200) : null,
    merchant, amount, currency: total ? total.currency : null, amount_text: total ? total.text : null, tool: toolName, source,
    card_id: fill ? fill.cardId : null,
  };
  const cardLine = fill ? `Card: ${fill.brand ? fill.brand + " " : ""}ending ${fill.last4}${fill.label ? ` (${fill.label})` : ""}, from your Wallet` : null;

  if (amount != null && limits.per_purchase != null && amount > limits.per_purchase) {
    await ledgerInsert({ ...base, status: "refused", note: `over per-purchase limit ${limits.per_purchase}` });
    return { action: "refuse", message: `Not done. This would pay ${total.text} at ${where}, and your limit for one purchase is ${limits.per_purchase}${limits.currency ? " " + limits.currency : ""}. Raise it in Settings if you want this to go through.` };
  }
  if (limits.per_day != null) {
    const day = await spentSince(userId, new Date(Date.now() - 24 * 3600000).toISOString());
    if ((amount || 0) + day > limits.per_day) {
      await ledgerInsert({ ...base, status: "refused", note: `over daily limit ${limits.per_day} (spent ${day})` });
      return { action: "refuse", message: `Not done. With ${total ? total.text : "this"} at ${where} you would pass your daily limit of ${limits.per_day}${limits.currency ? " " + limits.currency : ""} (${day.toFixed(2)} already today). Raise it in Settings if you want this to go through.` };
    }
  }
  if (limits.per_month != null) {
    const month = await spentSince(userId, new Date(Date.now() - 30 * 86400000).toISOString());
    if ((amount || 0) + month > limits.per_month) {
      await ledgerInsert({ ...base, status: "refused", note: `over monthly limit ${limits.per_month} (spent ${month})` });
      return { action: "refuse", message: `Not done. With ${total ? total.text : "this"} at ${where} you would pass your monthly limit of ${limits.per_month}${limits.currency ? " " + limits.currency : ""} (${month.toFixed(2)} in the last 30 days). Raise it in Settings if you want this to go through.` };
    }
  }

  const dupe = await recentSame(userId, host, amount);

  if (!limits.always_ask && amount != null && limits.auto_under != null && amount < limits.auto_under && !dupe) {
    const ledgerId = await ledgerInsert({ ...base, status: "auto", approved_via: "auto" });
    return { action: "allow", ledgerId, card: `Paying ${total.text} at ${where}, under your no-questions amount of ${limits.auto_under}.` };
  }

  const lines = [`Just to confirm, I'm about to pay at ${where}:`, ""];
  if (total) lines.push(`Total: ${total.text}`);
  else lines.push("Total: I could not read it from the page. Check it yourself before saying yes.");
  if (page && page.amounts && page.amounts.length > 1 && total) {
    const others = page.amounts.filter((a) => a.text !== total.text).map((a) => a.text);
    if (others.length) lines.push(`Also on the page: ${[...new Set(others)].slice(0, 4).join(", ")}`);
  }
  if (cardLine) lines.push(cardLine);
  lines.push(`How: ${intent && intent.why ? intent.why : "a purchase"}${cardLine ? "" : ", using whatever card the site already has"}.`);
  if (dupe) lines.push(`\nThis looks like the same purchase as ${Math.round((Date.now() - new Date(dupe.created_at).getTime()) / 60000)} minutes ago. Say yes only if you want it twice.`);
  lines.push(`\nReply "yes" to confirm or "no" to cancel.`);
  const ledgerId = await ledgerInsert({ ...base, status: "asked" });
  return { action: "ask", ledgerId, card: lines.join("\n") };
}

// A purchase reached from an automation or a scheduled task: the run cannot
// wait for an answer, so the purchase is parked as a pending confirmation,
// the person is asked in chat, and when they say yes confirmation.js runs
// the held call and tells them what happened. The run itself carries on
// with a note. One held purchase at a time.
async function holdForUser({ userId, platform, chatId, toolName, toolInput, verdict, source, label, extra }) {
  const ctx = require("./context");
  if (!ctx.pendingConfirmations) ctx.pendingConfirmations = {};
  if (ctx.pendingConfirmations[userId]) {
    await ledgerUpdate(verdict.ledgerId, { status: "refused", note: "another confirmation was already waiting" });
    return { error: "Not done. Another action is already waiting for the user's answer. Say in the report what needs paying and how much; they can do it in chat." };
  }
  let target = { platform, chatId };
  if (!target.platform || !target.chatId || target.platform === "dashboard") {
    const { data: links } = await supabase.from("chat_links").select("platform, platform_user_id").eq("user_id", userId).limit(1);
    if (links && links.length) target = { platform: links[0].platform, chatId: links[0].platform_user_id };
  }
  const toolUseId = "held_" + Date.now().toString(36);
  const clean = {};
  for (const [k, v] of Object.entries(toolInput || {})) if (!k.startsWith("_")) clean[k] = v;
  ctx.pendingConfirmations[userId] = {
    toolName,
    toolInput: { ...toolInput, _userId: userId, _chatId: target.chatId, _platform: target.platform },
    toolUseId,
    spend: verdict.ledgerId ? { ledgerId: verdict.ledgerId } : null,
    ...(extra || {}),
    heldFrom: source,
    messages: [
      { role: "user", content: `[${label || "A background task"} reached a purchase. It was held for your yes and you said yes. Tell the user plainly what happened.]` },
      { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: toolName, input: clean }] },
    ],
    otherToolResults: [],
    isInternal: true,
  };
  const intro = `${label || "A background task"} ${verdict.ledgerId ? "wants to make a purchase" : "wants to send data somewhere new"}. ${verdict.card}`;
  try {
    if (target.platform && target.chatId) await require("./messaging").sendToPlatform(target.platform, target.chatId, intro);
    else console.error("[spend-guard] no chat to put the purchase to");
  } catch (e) { console.error("[spend-guard] could not send the purchase question:", e.message); }
  return { held: true, note: "The purchase has been put to the user in chat. If they say yes it goes through and they are told; carry on with the rest of the task, and say in the report that it is waiting on them." };
}

module.exports = {
  spendIntent,
  holdForUser,
  touchesPasswordForm,
  notePage,
  lastPage,
  readCheckout,
  extractTotal,
  parseAmount,
  assess,
  limitsFor,
  ledgerUpdate,
  ledgerInsert,
  PAY_WORDS,
  CHECKOUT_URL,
};
