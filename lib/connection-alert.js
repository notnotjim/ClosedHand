// When Google or Microsoft stops accepting ClosedHand's sign-in for an
// account, say so once, where the person gets their updates. An added Gmail
// once died an hour after it was connected and nobody was told: its mail
// stopped arriving, the dashboard still called it connected, and the chat
// went on reporting it as synced.

const PROVIDERS = { google: "Google", microsoft: "Microsoft" };

function providerOf(service) {
  const base = String(service || "").replace(/_extra_.*$/, "");
  return PROVIDERS[base] || null;
}

function alertText(service, email, link) {
  const provider = providerOf(service) || "The provider";
  const who = email || "one of your accounts";
  return `${provider} stopped accepting ClosedHand's sign-in for ${who}, so its mail and calendar are no longer updating and I can't send or change anything there. `
    + (link ? `Sign in again from the dashboard to fix it: ${link}` : "Sign in again from the dashboard's Connections tab to fix it.");
}

async function tellOwner(userId, store, service) {
  if (!providerOf(service)) return false;
  try {
    const { supabase } = require("./db");
    const { data: links } = await supabase.from("chat_links").select("platform, platform_user_id").eq("user_id", userId);
    const targets = await require("./proactive").getProactiveTargets(userId, store, links || []);
    if (!targets.length) return false;
    const email = store?.connections?.[service]?.metadata?.email || null;
    const { sendToPlatform } = require("./messaging");
    for (const t of targets) {
      const link = await require("./dashboard-links").dashboardUrl(t.platform, "connections");
      await sendToPlatform(t.platform, t.platform_user_id, alertText(service, email, link));
    }
    console.log(`[connections] told ${userId} that ${service} needs signing in again`);
    return true;
  } catch (e) {
    console.error(`[connections] could not tell ${userId} about ${service}: ${e.message}`);
    return false;
  }
}

module.exports = { tellOwner, alertText, providerOf };
