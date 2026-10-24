// When Google or Microsoft stops accepting Closedhand's sign-in for an
// account, say so once, where the person gets their updates. An added Gmail
// once died an hour after it was connected and nobody was told: its mail
// stopped arriving, the dashboard still called it connected, and the chat
// went on reporting it as synced. A bank connection that stops working is
// told the same way, with what to paste to mend it.

const PROVIDERS = { google: "Google", microsoft: "Microsoft", simplefin: "SimpleFIN", lunchflow: "Lunch Flow" };

function providerOf(service) {
  const base = String(service || "").replace(/_extra_.*$/, "");
  return PROVIDERS[base] || null;
}

function alertText(service, email, link) {
  const where = link ? `on the dashboard: ${link}` : "on the dashboard's Connections tab";
  if (service === "simplefin") {
    return `SimpleFIN stopped accepting Closedhand's access to your bank data, so your balances and transactions are no longer updating. To fix it, make a new Setup Token under Apps in SimpleFIN and paste it ${where}`;
  }
  if (service === "lunchflow") {
    return `Your Lunch Flow key stopped working, so your balances and transactions are no longer updating. To fix it, add a new REST API destination under Destinations in Lunch Flow and paste its key ${where}`;
  }
  const provider = providerOf(service) || "The provider";
  const who = email || "one of your accounts";
  return `${provider} stopped accepting Closedhand's sign-in for ${who}, so its mail and calendar are no longer updating and I can't send or change anything there. `
    + (link ? `Sign in again from the dashboard to fix it: ${link}` : "Sign in again from the dashboard's Connections tab to fix it.");
}

// One message to every place the person gets updates, held in quiet hours
// (lib/proactive.js); textFor(link, web) writes it with that place's link to
// the dashboard section (web: the web chat, which shows links on words).
async function send(userId, store, textFor, what, section = "connections") {
  try {
    const { supabase } = require("./db");
    const { data: links } = await supabase.from("chat_links").select("platform, platform_user_id").eq("user_id", userId);
    const told = await require("./proactive").deliverUnprompted(userId, store, links || [],
      async (t) => textFor(await require("./dashboard-links").dashboardUrl(t.platform, section), t.platform === "web"));
    if (!told) return false;
    console.log(`[connections] told ${userId} that ${what}`);
    return true;
  } catch (e) {
    console.error(`[connections] could not tell ${userId} that ${what}: ${e.message}`);
    return false;
  }
}

async function tellOwner(userId, store, service) {
  if (!providerOf(service)) return false;
  const email = store?.connections?.[service]?.metadata?.email || null;
  return send(userId, store, (link) => alertText(service, email, link), `${service} needs signing in again`);
}

// A notice in the provider's own words (a bank to reconnect there, a
// subscription to pay), sent as it is.
async function notify(userId, store, text) {
  return send(userId, store, () => text, "a connection needs attention");
}

// A notice about the AI Closedhand uses, linking to the dashboard's Settings.
async function notifyAboutAi(userId, store, textFor) {
  return send(userId, store, textFor, "its AI needs attention", "settings");
}

// A report the person sent is fixed (bug-reports.js), in its own words.
async function tellAboutReport(userId, store, text) {
  return send(userId, store, () => text, "a report they sent is fixed");
}

// A notice closedhand.com sent this account (included-ai-setup.js keeps it,
// included-credit.js delivers it), in its own words.
async function notifyFromClosedhand(userId, store, text) {
  return send(userId, store, () => text, "closedhand.com sent a notice");
}

// A sign-in to do again, told once it can be: reconnect_told is kept only
// once the message has gone or is held. Raised while no chat app was chosen,
// it was lost: the flag stopped any second try.
async function tellOwnerOnce(userId, store, service) {
  const conn = store?.connections?.[service];
  if (!conn?.metadata?.reconnect_required || conn.metadata.reconnect_told) return false;
  if (!(await tellOwner(userId, store, service))) return false;
  conn.metadata = { ...conn.metadata, reconnect_told: true };
  const { error } = await require("./db").supabase.from("connections").update({ metadata: conn.metadata }).eq("user_id", userId).eq("service", service);
  if (error) console.error(`[connections] could not note that ${service} was told:`, error.message);
  return true;
}

// Every half hour, any sign-in still waiting to be told about.
function start() {
  const run = async () => {
    try {
      const userId = require("./admin").getAdminUserId();
      const store = await require("../user-store").UserStore.load(userId);
      for (const service of Object.keys(store.connections || {})) await tellOwnerOnce(userId, store, service);
    } catch (e) { console.error("[connections] sign-in sweep:", e.message); }
  };
  setTimeout(run, 3 * 60 * 1000).unref?.();
  setInterval(run, 30 * 60 * 1000).unref?.();
}

module.exports = { tellOwner, tellOwnerOnce, start, notify, notifyAboutAi, tellAboutReport, notifyFromClosedhand, alertText, providerOf };
