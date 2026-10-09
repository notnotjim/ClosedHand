// The Telegram bot's name follows the name Closedhand goes by. BotFather asks
// for a name when the bot is made, often after Closedhand was already named in
// another chat app, and without this the chat header and Closedhand disagree.
// Only a name the person gave is shown: until they give one, the BotFather
// name stays. Runs when the bot starts and whenever Closedhand is renamed.
const ctx = require("./context");
const { supabase } = require("../user-store");
const { ensureAdmin } = require("./admin");

async function givenName() {
  const id = await ensureAdmin();
  const { data } = await supabase.from("profiles").select("settings").eq("id", id).single();
  return data?.settings?.bot_name || null;
}

async function showName(name) {
  try {
    if (!ctx.bot) return;
    const wanted = String(name || (await givenName()) || "").trim().slice(0, 64);
    if (!wanted) return;
    const current = await ctx.bot.getMyName();
    if (current?.name === wanted) return;
    await ctx.bot.setMyName({ name: wanted });
    console.log(`[telegram] The bot is now called ${wanted}, the name Closedhand goes by.`);
  } catch (e) {
    console.error("[telegram] Could not set the bot's name:", e.message);
  }
}

module.exports = { showName };
