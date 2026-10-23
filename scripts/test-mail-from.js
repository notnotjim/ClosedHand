// Mail can go from one of a Gmail mailbox's send-as addresses, with every
// Gmail tool, and the card before a send says who it is from as the
// recipient will see it. Without this a draft was rewritten through Gmail's
// raw API to set an alias, which moved it out of its thread, and the card
// still named the mailbox, so the person had to ask which address it was.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const handlers = read("lib/tools/handlers.js");
const fnSrc = (name) => { const a = handlers.indexOf(`async function ${name}(`); return handlers.slice(a, handlers.indexOf("\n}\n", a) + 2); };
const block = (name) => handlers.slice(handlers.indexOf(`case "${name}": {`), handlers.indexOf('\n    case "', handlers.indexOf(`case "${name}": {`) + 10));

const SEND_AS = { sendAs: [
  { sendAsEmail: "office@harbour.test", displayName: "", isPrimary: true },
  { sendAsEmail: "ana@harbour.test", displayName: "Ana Ruiz", verificationStatus: "accepted" },
  { sendAsEmail: "press@harbour.test", displayName: "Press", verificationStatus: "pending" },
] };
const gApi = async (method, url) => {
  if (url.endsWith("/settings/sendAs")) return SEND_AS;
  if (url.includes("/messages/m-1?")) return { payload: { headers: [{ name: "Subject", value: "Court photos" }, { name: "From", value: "Mara <mara@harbourpost.example>" }, { name: "Message-ID", value: "<shoot-1@harbourpost.example>" }] } };
  throw new Error(`unexpected ${method} ${url}`);
};
const gmailFrom = new Function(fnSrc("gmailFrom") + "\nreturn gmailFrom;")();
const sendHeadersFor = new Function("gmailFrom", fnSrc("sendHeadersFor") + "\nreturn sendHeadersFor;")(gmailFrom);

test("from is one of the mailbox's own send-as addresses, with the name Gmail shows", async () => {
  assert.equal(await gmailFrom(gApi, "ana@harbour.test"), '"Ana Ruiz" <ana@harbour.test>');
  assert.equal(await gmailFrom(gApi, "Ana <ANA@harbour.test>"), '"Ana Ruiz" <ana@harbour.test>', "written any way");
  assert.equal(await gmailFrom(gApi, "office@harbour.test"), "office@harbour.test");
  await assert.rejects(gmailFrom(gApi, "press@harbour.test"), /not one of this mailbox's send-as addresses \(office@harbour\.test, ana@harbour\.test, press@harbour\.test\)/, "not yet verified in Gmail");
  await assert.rejects(gmailFrom(gApi, "boss@elsewhere.example"), /not one of this mailbox's send-as addresses/);
  await assert.rejects(gmailFrom(gApi, "Ana"), /must be an email address/);
});

test("a new email, a reply and a new draft carry it", async () => {
  const fresh = await sendHeadersFor("gmail_send", { to: "mara@harbourpost.example", subject: "Racquets", from: "ana@harbour.test" }, gApi);
  assert.deepEqual(fresh.headerLines, ['From: "Ana Ruiz" <ana@harbour.test>', "To: mara@harbourpost.example", "Subject: Racquets"]);
  const reply = await sendHeadersFor("gmail_reply", { message_id: "m-1", thread_id: "t-1", from: "ana@harbour.test" }, gApi);
  assert.equal(reply.headerLines[0], 'From: "Ana Ruiz" <ana@harbour.test>');
  assert.equal(reply.threadId, "t-1");
  assert.deepEqual((await sendHeadersFor("gmail_send", { to: "mara@harbourpost.example", subject: "Racquets" }, gApi)).headerLines, ["To: mara@harbourpost.example", "Subject: Racquets"], "none asked, none set");
  for (const name of ["gmail_send", "gmail_reply"]) assert.match(block(name), /const \{ headerLines \} = await sendHeadersFor\("gmail_\w+", toolInput, gApi\);/, name);
  assert.match(fnSrc("createGmailDraft"), /await sendHeadersFor\(toolName, toolInput, gApi\)/);
});

test("a draft's From changes in place, with or without new wording", () => {
  const update = block("gmail_draft_update");
  assert.match(update, /if \(toolInput\.from\) raw = setHeader\(raw, "From", await gmailFrom\(dApi, toolInput\.from\)\);/);
  assert.match(update, /if \(typeof toolInput\.body === "string"\) \{[\s\S]*\} else if \(!toolInput\.to && !toolInput\.cc && !toolInput\.subject && !toolInput\.from\) \{/);
  assert.match(update, /threadId \? \{ threadId \} : \{\}/, "still in its thread");
  const { setHeader } = require("../lib/gmail-draft");
  const raw = "From: office@harbour.test\r\nTo: mara@harbourpost.example\r\nSubject: Re: Court photos\r\n\r\nSee the court";
  assert.equal(setHeader(raw, "From", '"Ana Ruiz" <ana@harbour.test>'), 'From: "Ana Ruiz" <ana@harbour.test>\r\nTo: mara@harbourpost.example\r\nSubject: Re: Court photos\r\n\r\nSee the court');

  const defs = require("../lib/tools/definitions").INTERNAL_TOOLS;
  for (const name of ["gmail_send", "gmail_reply", "gmail_create_draft", "gmail_draft_update"]) {
    assert.match(defs.find((t) => t.name === name).input_schema.properties.from?.description || "", /send-as address/, name);
  }
  assert.deepEqual(defs.find((t) => t.name === "gmail_draft_update").input_schema.required, ["draft_id"], "the wording can stay as it is");
});

test("the card before a send says who it is from as the recipient sees it", async () => {
  const describe = new Function("draftAccountFor", "liveGmailDraft", "googleReqFor", "gmailPlainText", fnSrc("describeGmailDraft") + "\nreturn describeGmailDraft;")(
    async () => "office@harbour.test",
    async () => ({ draftId: "r-draft-1", draft: { message: { payload: { headers: [{ name: "From", value: '"Ana Ruiz" <ana@harbour.test>' }, { name: "To", value: "mara@harbourpost.example" }, { name: "Subject", value: "Re: Court photos" }] } } } }),
    () => null, () => "See the court");
  const shown = await describe({ draft_id: "r-draft-1" });
  assert.equal(shown.from, '"Ana Ruiz" <ana@harbour.test>');
  assert.equal(shown.account, "office@harbour.test");

  const engine = read("lib/engine.js");
  assert.match(engine, /if \(block\.input\.from\) confirmSummary \+= `From: \$\{block\.input\.from\}\\n`;\n\s*else if \(block\.input\.account\) confirmSummary \+= `From account: \$\{block\.input\.account\}\\n`;/);
  const { mailSendQuestion } = require("../lib/send-gate");
  assert.match(mailSendQuestion("gmail_send_draft", { to: "mara@harbourpost.example", ...shown }), /From: "Ana Ruiz" <ana@harbour\.test>/, "background sends too");
  assert.match(mailSendQuestion("gmail_send", { to: "mara@harbourpost.example", account: "office@harbour.test" }), /From: office@harbour\.test/);
});

// Outlook takes a From too, from the addresses Microsoft lists for the
// account. Tried against a stand-in only: no Microsoft account here.
const plainSrc = (name) => { const a = handlers.indexOf(`function ${name}(`); return handlers.slice(a, handlers.indexOf("\n}\n", a) + 2); };
const ME = { displayName: "Ana Ruiz", mail: "ana@kestrel.test", userPrincipalName: "ana@kestrel.test", proxyAddresses: ["SMTP:ana@kestrel.test", "smtp:bookings@kestrel.test", "X500:/o=ExchangeLabs/cn=ana"] };
const outlookFrom = new Function(fnSrc("outlookFrom") + "\nreturn outlookFrom;")();

test("Outlook: from is one of the account's own addresses, and the draft keeps its version", async () => {
  const msApi = async (method, url) => { if (url.includes("/me?$select=")) return ME; throw new Error(`unexpected ${method} ${url}`); };
  assert.deepEqual(await outlookFrom(msApi, "Bookings <BOOKINGS@kestrel.test>"), { emailAddress: { address: "bookings@kestrel.test", name: "Ana Ruiz" } });
  await assert.rejects(outlookFrom(msApi, "boss@elsewhere.example"), /not one of this mailbox's addresses \(ana@kestrel\.test, bookings@kestrel\.test\)/);

  const calls = [];
  const api = async (method, url, body) => {
    calls.push([method, url.replace("https://graph.microsoft.com/v1.0/", ""), body]);
    if (url.includes("/me?$select=")) return ME;
    if (method === "POST") return { id: "AAMk-9", changeKey: "ck-1" };
    if (method === "PATCH") return { changeKey: "ck-2" };
    throw new Error(`unexpected ${method} ${url}`);
  };
  const create = new Function("microsoftReqFor", "resolveOutgoingAttachments", "outlookRecipients", "outlookFrom", "deleteOutlookDraft", "addOutlookAttachments", "liveOutlookMessage",
    fnSrc("createOutlookDraft") + "\nreturn createOutlookDraft;")(() => api, async () => ({ attachments: [], missing: [] }), (t) => [{ emailAddress: { address: t } }], outlookFrom, async () => {}, null, null);
  const made = await create({ to: "mara@harbourpost.example", subject: "Racquets", body: "Two land Tuesday.", from: "bookings@kestrel.test" });
  assert.deepEqual(made, { draftId: "AAMk-9", changeKey: "ck-2" }, "the version after the From is set, so it is not mistaken for the person's edit");
  assert.deepEqual(calls.at(-1)[2], { from: { emailAddress: { address: "bookings@kestrel.test", name: "Ana Ruiz" } } });

  const update = block("outlook_draft_update");
  assert.match(update, /\.\.\.\(toolInput\.from \? \{ from: await outlookFrom\(msApi, toolInput\.from\) \} : \{\}\),/);
  assert.match(update, /const seen = rewording \? await draftSeenVersions\(live\.id\) : null;/, "a change to the headers alone keeps the wording as it stands");
  assert.match(update, /\.\.\.\(body \? \{ body \} : \{\}\),/);
  assert.match(plainSrc("liveOutlookMessage"), /\$select=id,isDraft,changeKey,subject,from,/);
  assert.match(fnSrc("describeOutlookDraft"), /if \(m\.from\?\.emailAddress\?\.address\) out\.from = /, "its card shows who it is from");
});
