// Mail goes out only after the person says yes. Two emails once went out
// straight from Gmail drafts: Closedhand called Gmail's "send this draft"
// address through api_request, which was not on the confirmation list, so
// nothing asked. Now: every write through the API tools is asked about, any
// raw send address is refused (a draft's included), and sending a draft is
// its own tool, asked about with the draft as it stands in Gmail.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { isMailSendUrl } = require("../lib/mail-send-url");

test("the confirmation list covers the API tools' writes and sending a draft", () => {
  const conf = read("lib/confirmation.js");
  const list = conf.slice(conf.indexOf("const ACTIONS_NEEDING_CONFIRMATION = ["), conf.indexOf("];", conf.indexOf("const ACTIONS_NEEDING_CONFIRMATION")));
  for (const name of ["gmail_send", "gmail_reply", "gmail_send_draft", "api_request", "sandbox_gateway"]) assert.match(list, new RegExp(`"${name}"`), name);
  const engine = read("lib/engine.js");
  assert.match(engine, /&& !\(block\.name === "api_request" && \(block\.input\.method \|\| "GET"\)\.toUpperCase\(\) === "GET"\)/, "reads still run without asking");
});

test("every address that sends mail is known, and nothing else is", () => {
  for (const url of [
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
    "https://gmail.googleapis.com/gmail/v1/users/someone%40example.com/drafts/send?alt=json",
    "https://graph.microsoft.com/v1.0/me/sendMail",
    "https://graph.microsoft.com/v1.0/me/messages/AAMkAD123/send",
  ]) assert.ok(isMailSendUrl(url), url);
  for (const url of [
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-draft-1",
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:harbour",
    "https://graph.microsoft.com/v1.0/me/messages/AAMkAD123",
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  ]) assert.ok(!isMailSendUrl(url), url);
});

test("a raw send through the API is refused in the chat and in background tasks", () => {
  const engine = read("lib/engine.js");
  const refuse = engine.indexOf('require("./send-gate").isMailSendUrl(block.input?.url)');
  assert.ok(refuse > 0 && refuse < engine.indexOf("let needsConfirmation = (ACTIONS_NEEDING_CONFIRMATION.includes(block.name)"), "refused before anything else");
  const agents = read("lib/agents.js");
  assert.match(agents, /sendGate\.isMailSendUrl\(block\.input\?\.url\)\) \{\n\s*toolResults\.push\(\{ type: "tool_result", tool_use_id: block\.id, content: JSON\.stringify\(\{ error: sendGate\.RAW_SEND_REFUSAL \}\) \}\);/);
  assert.doesNotMatch(agents, /function isMailSendUrl/, "one definition");
  assert.deepEqual([...require("../lib/send-gate").MAIL_SEND_TOOLS], ["gmail_send", "gmail_reply", "outlook_send", "outlook_reply", "send_mail", "reply_to_mail", "gmail_send_draft", "outlook_send_draft", "send_mail_draft"]);
});

test("sending a draft is asked about with what Gmail holds now, the person's edits included", async () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /if \(needsConfirmation && require\("\.\/send-gate"\)\.DRAFT_SEND_TOOLS\.has\(block\.name\)\) \{\n\s*try \{ Object\.assign\(block\.input, await require\("\.\/tools\/handlers"\)\.describeDraft\(block\.name, block\.input\)\); \}/);
  assert.match(engine, /gmail_send_draft: "Send this draft \(Gmail\)",/);
  assert.equal((engine.match(/require\("\.\/send-gate"\)\.MAIL_SEND_TOOLS\.has\(block\.name\)/g) || []).length, 2, "it is a send: the bulk-sender switch and the claims check treat it as one");
  // The card's facts come from the live draft.
  const handlers = read("lib/tools/handlers.js");
  const src = (name) => { const a = handlers.indexOf(`async function ${name}(`); return handlers.slice(a, handlers.indexOf("\n}\n", a) + 2); };
  const live = { id: "r-draft-1", message: { id: "msg-77", payload: { mimeType: "multipart/alternative",
    headers: [{ name: "To", value: "editor@harbourpost.example" }, { name: "Subject", value: "Racquets for the shoot" }],
    parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Hi Mara,\nTwo racquets land Monday.").toString("base64url") } }, { mimeType: "text/html", body: { data: "" } }] } } };
  const plain = new Function(handlers.slice(handlers.indexOf("function gmailPlainText("), handlers.indexOf("\n}\n", handlers.indexOf("function gmailPlainText(")) + 2) + "\nreturn gmailPlainText;")();
  const describe = new Function("draftAccountFor", "googleReqFor", "liveGmailDraft", "gmailPlainText", src("describeGmailDraft") + "\nreturn describeGmailDraft;")(
    async () => "hi@kestrelpadel.example",
    () => async () => live,
    async (api, id) => ({ draftId: "r-draft-1", draft: await api("GET", id) }), plain);
  assert.deepEqual(await describe({ draft_id: "msg-77" }), { draft_id: "r-draft-1", to: "editor@harbourpost.example", subject: "Racquets for the shoot",
    body: "Hi Mara,\nTwo racquets land Monday.", account: "hi@kestrelpadel.example" });
});

test("the tool tells the model it is only for when the person says to send", () => {
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /name: "gmail_send_draft",\n\s*groups: \["gmail"\],\n\s*description: "Send a Gmail draft as it now stands in Gmail, with any changes the person made to it there\. Use it when they say to send a draft, never on your own judgement: they are always asked first/);
});
