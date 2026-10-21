// While Closedhand answers with its Managed Models (included-ai.js),
// what is left on its key is looked at every half hour. When most of it is
// used the person is told once, where they get their updates, so it never
// runs out mid-task unannounced; when it has run out, the chat says so as
// each message arrives (engine.js).
const included = require("./included-ai");
const { getAdminUserId } = require("./admin");

const EVERY = 30 * 60 * 1000;

async function check() {
  const { UserStore } = require("../user-store");
  const userId = getAdminUserId();
  const store = await UserStore.load(userId);
  const settings = store?.profile?.settings || {};
  if (!included.inUse(settings) || settings.included_ai?.warned) return false;
  const credit = await included.credit(settings);
  if (!credit || credit.used < credit.limit * included.NEARLY_USED) return false;
  const told = await require("./connection-alert").notifyAboutAi(userId, store, (link, web) => included.nearlyUsedText(link, web));
  if (!told) return false;
  const { supabase } = require("./db");
  await require("./settings-patch").patchSettings(supabase, userId, { set: { included_ai: { ...settings.included_ai, warned: new Date().toISOString() } } });
  return true;
}

function start() {
  const run = () => check().catch(e => console.error("[included ai] credit check:", e.message));
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, EVERY).unref?.();
}

module.exports = { start, check };
