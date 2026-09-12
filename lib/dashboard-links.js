const { dashboardBase } = require("./config");

async function dashboardUrl(platform, section = "agents") {
  const path = `/dashboard#${encodeURIComponent(section)}`;
  if (platform === "web") return path;
  const base = await dashboardBase();
  return base ? base + path : null;
}

async function agentLinkNotice(platform, label = "You can watch it run on your dashboard") {
  const url = await dashboardUrl(platform);
  return url ? `${label}: ${url}`
    : "To open your dashboard from your phone, turn on Your phone in the dashboard's Settings on your computer.";
}

async function canvasUrl(platform, id) {
  if (!id) return null;
  const dashboard = await dashboardUrl(platform);
  return dashboard ? dashboard.replace(/\/dashboard#[^#]*$/, `/canvas/${encodeURIComponent(id)}`) : null;
}

module.exports = { dashboardUrl, agentLinkNotice, canvasUrl };
