// lib/services-config.js — Connectable services registry + token generation

const crypto = require("crypto");

const CONNECTABLE_SERVICES = {
  google: { name: "Google", provides: "Gmail, Calendar, Drive", isSignup: true },
  imap: { name: "Email (IMAP)", provides: "Any mailbox via app password: read, send, drafts" },
  ics_calendar: { name: "Calendar feed (ICS)", provides: "Read-only calendar via a secret iCal URL" },
  microsoft: { name: "Microsoft 365", provides: "Outlook, Calendar, OneDrive", isSignup: true },
  shopify: { name: "Shopify", provides: "Orders, products, inventory", needsStoreDomain: true },
  meta_ads: { name: "Meta Ads", provides: "Facebook & Instagram ad campaigns" },
  slack: { name: "Slack", provides: "Channels, messages" },
  notion: { name: "Notion", provides: "Pages, databases" },
  github: { name: "GitHub", provides: "Repos, issues, PRs" },
  stripe: { name: "Stripe", provides: "Payments, customers" },
  hubspot: { name: "HubSpot", provides: "CRM, contacts, deals" },
  asana: { name: "Asana", provides: "Tasks, projects" },
  dropbox: { name: "Dropbox", provides: "File storage" },
  salesforce: { name: "Salesforce", provides: "CRM" },
  mailchimp: { name: "Mailchimp", provides: "Email campaigns" },
  spotify: { name: "Spotify", provides: "Music" },
  zoom: { name: "Zoom", provides: "Meetings" },
  gitlab: { name: "GitLab", provides: "Repos, CI/CD" },
};

function generateBotConnectToken(userId, service, storeDomain) {
  const payload = JSON.stringify({
    userId, service, storeDomain: storeDomain || null,
    exp: Date.now() + 15 * 60 * 1000,
  });
  const sig = crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_KEY)
    .update(payload).digest("hex");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

module.exports = { CONNECTABLE_SERVICES, generateBotConnectToken };
