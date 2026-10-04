// Pages ClosedHand sends on Telegram open inside Telegram, signed in there by
// Telegram's proof of who opened them: only a fresh proof for the Telegram
// account linked to this ClosedHand, only for ClosedHand's own pages, and only
// as a session in Telegram's browser.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const server = read("webapp/server.js");
const fn = (name) => { const s = server.indexOf(`function ${name}`); return server.slice(s, server.indexOf("\n}\n", s) + 2); };

const TOKEN = "123456:test-token";
function proof(user, authDate, token = TOKEN) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "q1", user: JSON.stringify(user) });
  const check = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("a proof counts only when Telegram signed it with this bot's key, recently", () => {
  const box = { crypto, Buffer, Date, URLSearchParams, JSON, Number, parseInt, console: { error() {} } };
  vm.runInNewContext(fn("validateTelegramInitData") + "\nthis.f = validateTelegramInitData;", box);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(box.f(proof({ id: 42 }, now), TOKEN, 3600).id, 42);
  assert.equal(box.f(proof({ id: 42 }, now), "999:other", 3600), null, "another bot's key");
  assert.equal(box.f(proof({ id: 42 }, now - 7200), TOKEN, 3600), null, "older than an hour");
  assert.equal(box.f(proof({ id: 42 }, now).replace(/hash=[0-9a-f]{4}/, "hash=0000"), TOKEN, 3600), null, "altered");
  assert.equal(box.f(proof({ id: 42 }, now), null, 3600), null, "no key, no proof");
  assert.match(fn("validateTelegramInitData"), /crypto\.timingSafeEqual\(given, expected\)/);
  assert.match(server, /return TELEGRAM_BOT_TOKEN \|\| \(await getRuntimeConf\("TELEGRAM_BOT_TOKEN"\)\) \|\| null;/, "the key the setup page saved");
});

test("only ClosedHand's own pages open this way, never another site", () => {
  const box = {};
  vm.runInNewContext(fn("telegramTarget") + "\nthis.f = telegramTarget;", box);
  assert.equal(box.f("/report/236bf8e1-b53d-4d8e-a9d8-2791e0a99615"), "/report/236bf8e1-b53d-4d8e-a9d8-2791e0a99615");
  assert.equal(box.f("/dashboard#schedules"), "/dashboard#schedules");
  assert.equal(box.f("/canvas/abc123"), "/canvas/abc123");
  for (const bad of ["//evil.example/x", "https://evil.example", "/report/../../x", "/api/agents", "javascript:alert(1)", ""]) {
    assert.equal(box.f(bad), "/", bad);
  }
});

test("the session needs a fresh proof from the linked account, lasts 12 hours, and lives in Telegram's browser", () => {
  const route = server.slice(server.indexOf('app.post("/api/telegram/session"'), server.indexOf("// --- The gate: everything registered below needs the session"));
  assert.match(route, /validateTelegramInitData\(\(req\.body \|\| \{\}\)\.initData, await telegramBotToken\(\), TELEGRAM_PROOF_MAX_AGE_SEC\)/);
  assert.match(route, /\.eq\("platform", "telegram"\)\.eq\("platform_user_id", String\(tgUser\.id\)\)/);
  assert.match(route, /link\[0\]\.user_id !== getAdminUserId\(\)/, "only the account linked to this ClosedHand");
  assert.match(route, /setAdminSessionCookie\(res, TELEGRAM_SESSION_SEC\);/);
  assert.match(server, /const TELEGRAM_SESSION_SEC = 12 \* 60 \* 60;\nconst TELEGRAM_PROOF_MAX_AGE_SEC = 60 \* 60;/);
  assert.ok(server.indexOf('app.post("/api/telegram/session"') < server.indexOf("// --- The gate: everything registered below needs the session"), "reachable before a session exists");
  const page = server.slice(server.indexOf('app.get("/tg/open"'), server.indexOf('app.post("/api/telegram/session"'));
  assert.match(page, /body: JSON\.stringify\(\{ initData: proof \}\)/, "the proof travels in a request body, never in a link");
  assert.match(page, /if \(!proof\) \{ location\.replace\(to\); return; \}/, "outside Telegram it is just the normal login");
});

function loadInApp(base, titles = {}) {
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /telegram-in-app\.js$/.test(parent.filename)) {
      if (request === "./config") return { dashboardBase: async () => base };
      if (request === "../user-store") {
        const query = { select: () => query, in: async (col, ids) => ({ data: ids.filter((id) => titles[id]).map((id) => ({ id, title: titles[id] })), error: null }) };
        return { supabase: { from: () => query } };
      }
    }
    return load.call(this, request, parent, ...rest);
  };
  try { delete require.cache[require.resolve("../lib/telegram-in-app")]; return require("../lib/telegram-in-app"); }
  finally { Module._load = load; }
}

function fakeBot(sent) {
  return {
    sendMessage: async (chat, text, options) => { sent.push({ text, options }); return { message_id: sent.length }; },
    editMessageText: async (text, options) => { sent.push({ text, options, edit: true }); return true; },
    sendPhoto: async () => {},
  };
}

const BASE = "https://sam.closedhand.ai";
const SAIGON = "236bf8e1-b53d-4d8e-a9d8-2791e0a99615";
const NEWCASTLE = "61c0eae2-5248-4acd-832d-460391d764c6";
const open = (path) => `${BASE}/tg/open?to=${encodeURIComponent(path)}`;

test("a report link becomes an Open report button, and in-app buttons go through the sign-in", async () => {
  const { telegramInApp } = loadInApp(BASE);
  const { splitTelegram } = require("../lib/follow-on");
  const sent = [];
  const bot = splitTelegram(telegramInApp(fakeBot(sent)));
  await bot.sendMessage(7, `Three good ones below.\n[[next]]\nThe full list is in the report.\n\nFull report: ${BASE}/report/${SAIGON}`);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].options.reply_markup, undefined, "no button on the part without the link");
  assert.equal(sent[1].text, "The full list is in the report.");
  assert.deepEqual(sent[1].options.reply_markup.inline_keyboard[0][0], { text: "Open report", web_app: { url: open(`/report/${SAIGON}`) } });

  await bot.sendMessage(7, "Flights", { reply_markup: { inline_keyboard: [[{ text: "View flights", web_app: { url: `${BASE}/dashboard#schedules` } }]] } });
  assert.equal(sent.at(-1).options.reply_markup.inline_keyboard[0][0].web_app.url, open("/dashboard#schedules"));
  await bot.sendMessage(7, "Elsewhere", { reply_markup: { inline_keyboard: [[{ text: "Site", web_app: { url: "https://example.com/x" } }]] } });
  assert.equal(sent.at(-1).options.reply_markup.inline_keyboard[0][0].web_app.url, "https://example.com/x", "other sites are left alone");
  assert.equal((read("index.js").match(/splitTelegram\(require\("\.\/lib\/telegram-in-app"\)\.telegramInApp\(new TelegramBot\(/g) || []).length, 2, "both places the bot is made, parts split before buttons are added");
});

test("links written for the web chat open in Telegram, as buttons named after each report", async () => {
  const { telegramInApp } = loadInApp(BASE, { [SAIGON]: "Saigon move, Wednesday 7 October", [NEWCASTLE]: "Newcastle and the Champions League" });
  const sent = [];
  const bot = telegramInApp(fakeBot(sent));
  await bot.sendMessage(7, `Two to pick from:\n\n**Saigon move document** (flight, airport transfer): /report/${SAIGON}\n\n**Newcastle Champions League chances**: /report/${NEWCASTLE}\n\nWhich one were you after?`);
  const { text, options } = sent[0];
  assert.equal(text, "Two to pick from:\n\n<b>Saigon move document</b> (flight, airport transfer)\n\n<b>Newcastle Champions League chances</b>\n\nWhich one were you after?");
  assert.equal(options.parse_mode, "HTML");
  assert.deepEqual(options.reply_markup.inline_keyboard, [
    [{ text: "Saigon move, Wednesday 7 October", web_app: { url: open(`/report/${SAIGON}`) } }],
    [{ text: "Newcastle and the Champions League", web_app: { url: open(`/report/${NEWCASTLE}`) } }],
  ]);

  await bot.sendMessage(7, `Here you go: [Newcastle's Champions League chances](/report/${NEWCASTLE})`);
  assert.equal(sent.at(-1).text, "Here you go: Newcastle's Champions League chances");
  assert.equal(sent.at(-1).options.reply_markup.inline_keyboard[0][0].text, "Newcastle's Champions League chances", "the model's own words for it");

  await bot.sendMessage(7, `I'm on it.\n\nYou can watch it run on your dashboard: ${BASE}/dashboard#agents`);
  assert.equal(sent.at(-1).text, "I'm on it.\n\nYou can watch it run on your dashboard");
  assert.deepEqual(sent.at(-1).options.reply_markup.inline_keyboard[0][0], { text: "Open dashboard", web_app: { url: open("/dashboard#agents") } });

  await bot.editMessageText(`Done: /report/${SAIGON}`, { chat_id: 7, message_id: 3 });
  assert.equal(sent.at(-1).edit, true);
  assert.equal(sent.at(-1).options.reply_markup.inline_keyboard[0][0].text, "Saigon move, Wednesday 7 October", "a reply edited into place gets it too");
});

test("Markdown shows as Telegram formatting, and plain text when Telegram refuses it", async () => {
  const { telegramInApp, telegramHtml } = loadInApp(BASE);
  assert.equal(telegramHtml("## Odds\n**10/1** for *top four*, 5*3 < 20 & [source](https://example.com/a_b?x=1&y=2) `a<b`"),
    '<b>Odds</b>\n<b>10/1</b> for <i>top four</i>, 5*3 &lt; 20 &amp; <a href="https://example.com/a_b?x=1&amp;y=2">source</a> <code>a&lt;b</code>');
  assert.equal(telegramHtml("* one\n* two"), "* one\n* two", "list markers are not italics");
  const sent = [];
  const bot = telegramInApp({
    sendMessage: async (chat, text, options) => {
      if (options?.parse_mode) throw new Error("ETELEGRAM: 400 Bad Request: can't parse entities: Unsupported start tag");
      sent.push({ text, options }); return { message_id: 1 };
    },
  });
  await bot.sendMessage(7, "**Bold** words");
  assert.deepEqual(sent, [{ text: "**Bold** words", options: {} }]);
});

test("with no personal URL, the page link says how to reach pages from a phone", async () => {
  const { pageButtons } = loadInApp(null);
  const shaped = await pageButtons(null, `Full report: /report/${SAIGON}`);
  assert.deepEqual(shaped.buttons, []);
  assert.match(shaped.text, /turn on Your phone in the dashboard's Settings/);
});

test("WhatsApp gets the full personal URL for every ClosedHand page", () => {
  const { absolutePageLinks } = require("../lib/page-links");
  assert.equal(absolutePageLinks(`See /report/${SAIGON} and [the dashboard](/dashboard#agents), not https://example.com/report/${SAIGON}`, BASE),
    `See ${BASE}/report/${SAIGON} and [the dashboard](${BASE}/dashboard#agents), not https://example.com/report/${SAIGON}`);
  assert.match(read("lib/platforms/whatsapp-linked.js"), /formatWhatsApp\(require\("\.\.\/page-links"\)\.absolutePageLinks\(message, base\)\)/);
  assert.match(read("lib/messaging.js"), /formatWhatsApp\(require\("\.\/page-links"\)\.absolutePageLinks\(text, base\)\)/);
});
