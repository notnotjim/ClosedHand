// lib/confirmation.js — Confirmation system for destructive actions

const ctx = require("./context");
const { saveStore } = require("./storage");
const { getConversation } = require("./conversation");
const { handleInternalTool } = require("./tools/handlers");
const { callMCPTool } = require("./mcp");
const { ledgerUpdate } = require("./spend-guard");
const { sendTyping } = require("./messaging");

const ACTIONS_NEEDING_CONFIRMATION = [
  "delegate_email_thread",
  "send_mail",
  "reply_to_mail",
  "gmail_send",
  "gmail_reply",
  "outlook_send",
  "outlook_reply",
  "outlook_cal_delete_event",
  "outlook_cal_update_event",
  "delete_event",
  "edit_event",
  "gcal_delete_event",
  "gcal_update_event",
  "disconnect_service",
  "gmail_send_draft",
  "outlook_send_draft",
  "send_mail_draft",
  // A connected service's API, written to directly: anything but a read is
  // asked about first (engine.js lets GETs and read-only GraphQL through).
  "api_request",
  "sandbox_gateway",
];

// A reply to "Reply yes or no": people write "Yes, send it." or "ok go
// ahead", not a bare "yes". It counts as an answer only when every word in it
// is a plain yes (or a plain no) word; anything more, such as "yes but change
// the subject" or "send it to Sam instead", is not an answer and goes to the
// conversation as usual.
const YES_CORE = new Set(["yes", "y", "yep", "yeah", "yup", "sure", "ok", "okay", "go", "confirm", "confirmed", "do", "send", "approve", "approved", "always"]);
const YES_WORDS = new Set([...YES_CORE, "ahead", "it", "please", "thanks", "thank", "you", "now"]);
const NO_CORE = new Set(["no", "n", "nope", "nah", "cancel", "stop", "don't", "dont", "not", "skip", "never"]);
const NO_WORDS = new Set([...NO_CORE, "do", "send", "it", "please", "thanks", "thank", "you", "now", "mind"]);
function confirmationAnswer(response) {
  const words = String(response || "").toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return null;
  const all = (set) => words.every((w) => set.has(w));
  const any = (set) => words.some((w) => set.has(w));
  if (any(NO_CORE) && all(NO_WORDS)) return "no";
  if (any(YES_CORE) && all(YES_WORDS)) return words.length === 1 && words[0] === "always" ? "always" : "yes";
  return null;
}

async function handleConfirmation(userId, chatId, response, opts = {}) {
  const pending = ctx.pendingConfirmations[userId];
  if (!pending) return false;
  const origin = pending.toolInput || {};
  if ((origin._platform === "email" || ctx.activePlatform === "email") &&
      (origin._platform !== ctx.activePlatform || origin._chatId !== chatId)) {
    return "Please answer that approval in the conversation where I asked it.";
  }

  // A job waiting for a sign-in: "done" carries it on, "no" carries it on
  // without the site, "not yet" keeps it waiting (lib/sign-in-wall.js).
  const signIn = pending.kind === "sign_in" ? require("./sign-in-wall").signInAnswer(response) : null;
  const answer = pending.kind === "sign_in" ? { done: "yes", no: "no" }[signIn] || null : confirmationAnswer(response);
  const isYes = answer === "yes" || answer === "always";
  const isNo = answer === "no";
  if (signIn === "wait" && !require("./confirmation-lifetime").isLapsed(pending)) {
    const waiting = "OK, I'll wait. Reply done when you've signed in.";
    getConversation(userId).push({ role: "user", content: String(response) }, { role: "assistant", content: waiting });
    saveStore();
    return waiting;
  }

  // A question older than a day is over: a late "yes" must not fire it.
  // Anything else is a new message, and the caller drops the question.
  if (require("./confirmation-lifetime").isLapsed(pending)) {
    if (!isYes && !isNo) return false;
    await dropPending(userId, "lapsed");
    const lapsed = "That question is from more than a day ago and has lapsed, so nothing was done. Ask again if you still want it.";
    getConversation(userId).push({ role: "user", content: String(response) }, { role: "assistant", content: lapsed });
    saveStore();
    return lapsed;
  }
  if (!isYes && !isNo) return false;

  delete ctx.pendingConfirmations[userId];
  const conversation = getConversation(userId);

  // "always": allow this once and remember the place for next time.
  if (answer === "always" && pending.outbound && pending.outbound.host) {
    await require("./outbound-guard").approveHost(ctx.activeUserStore, pending.outbound.host);
  }

  // A background agent paused for a send confirmation: resume it rather than
  // carrying on in the chat below. On yes it sends and carries on;
  // on no it is told the send was declined.
  if (pending.isAgent) {
    const { resumeAgentAfterConfirmation } = require("./agents");
    if (pending.spend && pending.spend.ledgerId) await ledgerUpdate(pending.spend.ledgerId, isYes ? { status: "approved", approved_via: "agent" } : { status: "declined" });
    const verb = pending.spend ? "pay for it" : "send it";
    conversation.push({ role: "user", content: pending.kind === "sign_in" ? String(response) : isYes ? `Yes, ${verb}.` : `No, do not ${verb}.` });
    const ack = await resumeAgentAfterConfirmation(pending, !!isYes, chatId);
    conversation.push({ role: "assistant", content: ack });
    saveStore();
    return ack;
  }

  // A "no" is not the end of the turn. "Cancelled." on its own once left the
  // person's actual question unanswered, so the turn carries on with the
  // change marked declined, the way a "yes" carries on with it done.
  sendTyping(chatId);
  let result;
  if (isNo) {
    if (pending.spend && pending.spend.ledgerId) await ledgerUpdate(pending.spend.ledgerId, { status: "declined" });
    result = { declined: true, note: "The person said no, so this was not done. Do not do it or offer it again now. If their message asked anything else, answer that; otherwise say in a few words that you left it as it was." };
  } else {
    console.log(`Confirmed, calling tool: ${pending.toolName}`);
    if (pending.isInternal) {
      result = await handleInternalTool(pending.toolName, pending.toolInput);
    } else {
      result = await callMCPTool(pending.toolName, pending.toolInput);
    }
    if (pending.spend && pending.spend.ledgerId) {
      await ledgerUpdate(pending.spend.ledgerId, { status: result && result.error ? "failed" : "completed", approved_via: pending.isAgent ? "agent" : "chat" });
    }
  }

  // Carry on as the chat does, from where the question was asked, with the
  // held call's result. Every check the chat makes applies to what comes
  // next, and the next thing that needs a yes is put with its own card at
  // once. A loop of its own here once refused anything that needed a yes,
  // even a read, so the model asked in its own words first and the person
  // was asked twice for every step.
  const said = isNo ? "No, cancel that." : "Yes, go ahead.";
  const held = { type: "tool_result", tool_use_id: pending.toolUseId, content: JSON.stringify(result.content || result) };
  // Lazy require to avoid circular dep with engine.js
  return require("./engine").ask(userId, pending.request || said, null, chatId, false, {
    ...opts,
    platform: origin._platform || opts.platform || ctx.activePlatform,
    resume: { said, messages: [...pending.messages, { role: "user", content: [...(pending.otherToolResults || []), held] }] },
  });
}

// The user answered something else, or the question lapsed: forget the held
// action and mark the task so it stops waiting. Nothing is written into the
// conversation as said: an "OK, cancelled." once stood there that the person
// never saw, after they had only asked which address the email was from.
// Instead the reply to their message is told (the note returned), so it can
// say so, or ask afresh if they still want it.
async function dropPending(userId, reason) {
  const pending = ctx.pendingConfirmations[userId];
  if (!pending) return null;
  delete ctx.pendingConfirmations[userId];
  if (pending.isAgent) await require("./agents").dropConfirmation(pending, reason);
  return "HELD ACTION NOT DONE: your last message asked them to reply yes or no before an action. Their message is not a yes or no, so it was not done, and they have not been told. Answer their message. If it still wants the action, call the tool again so they get a fresh question; otherwise say in a few words that you left it undone.";
}

module.exports = { ACTIONS_NEEDING_CONFIRMATION, handleConfirmation, dropPending, confirmationAnswer };
