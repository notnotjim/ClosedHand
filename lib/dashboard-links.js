const { dashboardBase } = require("./config");

async function dashboardUrl(platform, section = "tasks") {
  const path = `/dashboard#${encodeURIComponent(section)}`;
  if (platform === "web") return path;
  const base = await dashboardBase();
  return base ? base + path : null;
}

async function agentLinkNotice(platform, label) {
  const url = await dashboardUrl(platform);
  // The web chat shows links on words, so the label carries the link there.
  if (url && platform === "web") return `[${label}](${url})`;
  return url ? `${label}: ${url}`
    : "To open your dashboard from your phone, claim your personal URL in the dashboard's Settings on the computer running Closedhand.";
}

// A page Closedhand made (webapp/report-page.js). Chat apps reach it through
// the personal URL; with none, the dashboard line stands in.
async function reportUrl(platform, id) {
  if (!id) return null;
  const path = `/page/${encodeURIComponent(id)}`;
  if (platform === "web") return path;
  const base = await dashboardBase();
  return base ? base + path : null;
}
async function reportLinkNotice(platform, id) {
  const url = await reportUrl(platform, id);
  if (!url) return agentLinkNotice(platform, "Open the page");
  return platform === "web" ? `[Open the page](${url})` : `Open the page: ${url}`;
}

async function canvasUrl(platform, id) {
  if (!id) return null;
  const dashboard = await dashboardUrl(platform);
  return dashboard ? dashboard.replace(/\/dashboard#[^#]*$/, `/canvas/${encodeURIComponent(id)}`) : null;
}

// A link to a page of this Closedhand for a chat: in the web chat it stays on
// the address already open; in a chat app on a phone it is the personal URL,
// since this computer's own address (localhost) doesn't open there.
async function closedhandLink(platform, path) {
  if (platform === "web") return path;
  const base = (await dashboardBase()) || process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000";
  return base.replace(/\/+$/, "") + path;
}

module.exports = { dashboardUrl, agentLinkNotice, canvasUrl, reportUrl, reportLinkNotice, closedhandLink };
