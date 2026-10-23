// lib/send-gate.js: what counts as sending something to other people, so the
// chat, background tasks and schedules all wait for the person's yes on the
// same things while "Ask before sending emails" is ticked. Each used to keep
// its own list: schedules asked about no send at all, background tasks not
// about a connected server's, and none about a Send button pressed in a
// browser.
const { isMailSendUrl } = require("./mail-send-url");

// Closedhand's own tools that send mail, for every mail service.
const MAIL_SEND_TOOLS = new Set(["gmail_send", "gmail_reply", "gmail_send_draft", "outlook_send", "outlook_reply", "send_mail", "reply_to_mail"]);

// Pressing Send: in webmail, a chat site or a mail app on the Mac. Read from
// what the press names (its selector, text or title, or the label the page
// outline gave the element), so a click at bare screen coordinates cannot be
// read. Ctrl or Cmd with Enter sends in Gmail, Outlook and most chat sites,
// and Cmd+Shift+D in Apple Mail.
const SEND_LABEL = /(^|[^a-z])send($|[^a-z])/i;
const PRESSES = /\.(click|submit|requestSubmit)\s*\(/;
const text = (v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
function sendKeys(...given) {
  const k = new Set(given.map(text).join("+").toLowerCase().split(/[\s,+"[\]]+/).filter(Boolean));
  const has = (...names) => names.some((n) => k.has(n));
  if (has("ctrl", "control", "cmd", "command", "meta") && has("enter", "return")) return true;
  return has("cmd", "command", "meta") && has("shift") && has("d");
}

// Where a tool call presses Send: "sandbox", "mac" or null. label(ref) turns
// a numbered element from the sandbox browser's outline into its label.
function browserSend(toolName, input, label = () => "") {
  if (!input || typeof input !== "object") return null;
  if (toolName === "sandbox_browse") {
    const steps = input.action === "batch" && Array.isArray(input.steps) ? input.steps : [input];
    for (const st of steps) {
      if (!st || typeof st !== "object") continue;
      if (st.action === "click" && SEND_LABEL.test(`${text(st.selector)} ${text(st.text)} ${label(st.ref)}`)) return "sandbox";
      if (st.action === "fill" && st.submit && SEND_LABEL.test(`${text(st.selector)} ${label(st.ref)}`)) return "sandbox";
      if (st.action === "press" && sendKeys(st.key)) return "sandbox";
      if (st.action === "eval_js" && PRESSES.test(text(st.script)) && SEND_LABEL.test(text(st.script))) return "sandbox";
    }
    return null;
  }
  if (toolName === "sandbox_exec") {
    const code = text(input.code);
    const drivesBrowser = /connect_over_cdp|browser_helper|playwright|puppeteer|selenium|CDP_URL|localhost:9222/i.test(code);
    return drivesBrowser && (PRESSES.test(code) || /\.press\s*\(/.test(code)) && SEND_LABEL.test(code) ? "sandbox" : null;
  }
  if (toolName === "bridge_browser_click") return SEND_LABEL.test(`${text(input.selector)} ${text(input.text)}`) ? "mac" : null;
  if (toolName === "bridge_browser_execute_js") return PRESSES.test(text(input.javascript)) && SEND_LABEL.test(text(input.javascript)) ? "mac" : null;
  if (toolName === "bridge_ax_click") return SEND_LABEL.test(`${text(input.title)} ${text(input.description)} ${text(input.name)}`) ? "mac" : null;
  if (toolName === "bridge_input_key_press" || toolName === "bridge_input_key_combo") return sendKeys(input.combo, input.modifiers, input.key) ? "mac" : null;
  return null;
}

// The question for a Send pressed in a browser or app.
function browserSendCard(where) {
  const machine = where === "mac" ? "on your Mac" : "on Closedhand's sandbox computer";
  return `I'm about to press Send ${machine}, which sends a message to whoever it is addressed to.\n\nReply "yes" to send it or "no" to leave it unsent.`;
}

// Plain-language "about to send" line naming recipient, subject and attachments,
// so the user knows exactly what they are approving.
function mailSendQuestion(toolName, input) {
  const i = input || {};
  const isReply = /reply/.test(toolName);
  const lines = [`I'm about to ${isReply ? "reply to an email" : "send an email"}. Reply "yes" to send it or "no" to skip.`, ""];
  if (i.to) lines.push(`To: ${i.to}`);
  if (i.account) lines.push(`From: ${i.account}`);
  if (i.subject) lines.push(`Subject: ${i.subject}`);
  if (Array.isArray(i.attachment_ids) && i.attachment_ids.length) {
    const names = i.attachment_ids.map((id) => {
      const stored = require("./context").store?.attachments || {};
      for (const uid of Object.keys(stored)) {
        const a = (stored[uid] || []).find((x) => x.id === id);
        if (a) return a.fileName || id;
      }
      return id;
    });
    lines.push(`Attaching: ${names.join(", ")}`);
  }
  if (i.body) lines.push(`\n${String(i.body).substring(0, 400)}${String(i.body).length > 400 ? "..." : ""}`);
  return lines.join("\n");
}

// For runs nobody is watching (schedules and automations): what to do before
// this call, the same as the chat would. { refuse } stops it, { card } holds it
// for the person's yes, null lets it run.
async function unattended(toolName, input, userId, store) {
  if ((toolName === "api_request" || toolName === "sandbox_gateway") && isMailSendUrl(input?.url)) return { refuse: RAW_SEND_REFUSAL };
  const userMcp = require("./user-mcp");
  if (userMcp.isUserMcpTool(toolName) && userMcp.needsMcpConfirmation(userId, toolName)) return { card: userMcp.mcpQuestion(userId, toolName, input), isInternal: false };
  if (store?.profile?.settings?.require_send_confirmation === false) return null;
  if (MAIL_SEND_TOOLS.has(toolName)) {
    if (require("./self-send").sendsOnlyToSelf(toolName, input, store)) return null;
    let shown = input;
    if (toolName === "gmail_send_draft") {
      try { shown = { ...input, ...(await require("./tools/handlers").describeGmailDraft(input)) }; }
      catch (e) { return { refuse: `Could not read that draft: ${e.message}` }; }
    }
    return { card: mailSendQuestion(toolName, shown), isInternal: true };
  }
  const spend = require("./spend-guard");
  const at = browserSend(toolName, input, (ref) => spend.refLabel(userId, ref));
  if (at && !spend.spendIntent(toolName, { ...input, _userId: userId })) return { card: browserSendCard(at), isInternal: true };
  return null;
}

// Said when a raw API call would send mail, wherever it is refused.
const RAW_SEND_REFUSAL = "Refused. Never send email by calling a mail service's API directly. Use the mail tools, which ask the person first: gmail_send_draft for a Gmail draft, gmail_send or gmail_reply otherwise, outlook_send or outlook_reply for Outlook, send_mail or reply_to_mail for other mail. Attach files with attachment_ids.";

module.exports = { MAIL_SEND_TOOLS, isMailSendUrl, browserSend, browserSendCard, mailSendQuestion, unattended, RAW_SEND_REFUSAL, SEND_LABEL };
