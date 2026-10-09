// The Telegram bot is called what Closedhand is called. BotFather asks for a
// name when the bot is made; once the person has named Closedhand, Telegram
// shows that name, when the bot starts and whenever Closedhand is renamed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

function loadWith({ bot, given }) {
  const ctx = { bot };
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /telegram-name\.js$/.test(parent.filename)) {
      if (request === "./context") return ctx;
      if (request === "./admin") return { ensureAdmin: async () => "owner" };
      if (request === "../user-store") {
        const query = { select: () => query, eq: () => query, single: async () => ({ data: { settings: given ? { bot_name: given } : {} } }) };
        return { supabase: { from: () => query } };
      }
    }
    return load.call(this, request, parent, ...rest);
  };
  try { delete require.cache[require.resolve("../lib/telegram-name")]; return require("../lib/telegram-name"); }
  finally { Module._load = load; }
}

function fakeBot(name) {
  const set = [];
  return { set, getMyName: async () => ({ name }), setMyName: async (form) => { set.push(form.name); } };
}

test("Telegram takes the name Closedhand goes by, and only changes when it differs", async () => {
  const bot = fakeBot("Petey");
  await loadWith({ bot, given: "Pete" }).showName();
  assert.deepEqual(bot.set, ["Pete"], "the name from settings when the bot starts");

  const same = fakeBot("Pete");
  await loadWith({ bot: same, given: "Pete" }).showName();
  assert.deepEqual(same.set, [], "already right, left alone");

  const renamed = fakeBot("Pete");
  await loadWith({ bot: renamed, given: "Pete" }).showName("Max");
  assert.deepEqual(renamed.set, ["Max"], "a rename goes straight through");
});

test("before Closedhand has a name, the BotFather name stays", async () => {
  const bot = fakeBot("Petey");
  await loadWith({ bot, given: null }).showName();
  assert.deepEqual(bot.set, []);
  await loadWith({ bot: null, given: "Pete" }).showName();
});

test("a failure from Telegram never reaches the chat", async () => {
  const bot = { getMyName: async () => { throw new Error("429 Too Many Requests"); } };
  const errors = [];
  const error = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try { await loadWith({ bot, given: "Pete" }).showName(); } finally { console.error = error; }
  assert.match(errors[0], /Could not set the bot's name: 429/);
});

test("it runs when the bot starts and at every rename, and setup says so", () => {
  assert.match(read("lib/platforms/telegram.js"), /require\("\.\.\/telegram-name"\)\.showName\(\);\n\}\n\nmodule\.exports = \{ setup \};/);
  assert.match(read("lib/onboarding.js"), /await saveProfileSetting\("bot_name", got\.bot\);\n\s*have\.bot = got\.bot;\n\s*require\("\.\/telegram-name"\)\.showName\(got\.bot\);/);
  assert.match(read("lib/tools/handlers.js"), /if \(toolInput\.bot_name\) require\("\.\.\/telegram-name"\)\.showName\(toolInput\.bot_name\);/);
  const setup = read("webapp/views/setup.html");
  assert.match(setup, /Any name will do: once you&rsquo;ve told Closedhand what to call it, the bot takes that name\./);
  assert.doesNotMatch(setup, /coming soon/i, "nothing promised that is not there");
});
