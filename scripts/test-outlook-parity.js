// Outlook does what Google does: mail with files (a large one uploaded in
// pieces, as Outlook takes only 3 MB in one request), one draft per thread,
// drafts rewritten with their pictures kept, events with attendees, files and
// a OneDrive link, and a background send saved as a real draft first. Its
// invitations are sends, asked about first, and a draft read live counts as
// seen. Microsoft is played here by a stand-in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const handlers = read("lib/tools/handlers.js");
const src = (name) => {
  const a = handlers.search(new RegExp(`(async )?function ${name}\\(`));
  return handlers.slice(a, handlers.indexOf("\n}\n", a) + 2);
};
const block = (name) => handlers.slice(handlers.indexOf(`case "${name}": {`), handlers.indexOf('\n    case "', handlers.indexOf(`case "${name}": {`) + 10));

// The Outlook helpers, run against a stand-in Graph that records each call.
function outlook({ failAttach = false, failSend = false } = {}) {
  const calls = [];
  const msApi = async (method, url, body) => {
    calls.push({ method, url, body });
    if (failAttach && /\/attachments$/.test(url)) throw new Error("Graph 413");
    if (failSend && /\/send$/.test(url)) throw new Error("Graph 503");
    if (/createUploadSession$/.test(url)) return { uploadUrl: "https://outlook.example/upload/s1" };
    if (method === "POST" && /\/me\/messages(\/[^/]+\/createReply)?$/.test(url)) return { id: "AAMk-9", changeKey: "ck-1" };
    if (method === "GET" && /\/me\/messages\/AAMk-9\?/.test(url)) return { id: "AAMk-9", changeKey: "ck-2" };
    return {};
  };
  const puts = [];
  const fetch = async (url, opts) => { puts.push({ url, range: opts.headers["Content-Range"], size: opts.body.length, auth: opts.headers.Authorization }); return { ok: true, status: 200 }; };
  let files = [];
  const deps = {
    microsoftReqFor: () => msApi,
    resolveOutgoingAttachments: async () => ({ attachments: files, missing: [] }),
    liveOutlookMessage: (api, id) => api("GET", `https://graph.microsoft.com/v1.0/me/messages/${id}?$select=changeKey`),
    outlookRecipients: (text) => String(text).split(",").map((address) => ({ emailAddress: { address: address.trim() } })),
    fetch,
  };
  const names = Object.keys(deps);
  const lib = new Function(...names, [src("addOutlookAttachments"), src("createOutlookDraft"), src("sendOutlookDraft"), src("deleteOutlookDraft"), src("sendOutlookMessage")].join("\n")
    + "\nconst OUTLOOK_ONE_REQUEST = 3 * 1024 * 1024;\nreturn { addOutlookAttachments, createOutlookDraft, sendOutlookMessage };")(...names.map((n) => deps[n]));
  return { ...lib, calls, puts, setFiles: (f) => { files = f; } };
}

test("Outlook mail carries files, and a large one goes up in pieces", async () => {
  const o = outlook();
  o.setFiles([
    { fileName: "racquet-list.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(2000, 1) },
    { fileName: "shoot-photos.zip", mimeType: "application/zip", buffer: Buffer.alloc(4 * 1024 * 1024, 2) },
  ]);
  const r = await o.sendOutlookMessage({ to: "editor@harbourpost.example", subject: "Racquets for the shoot", body: "Two land Monday.", attachment_ids: ["a1", "a2"] });
  assert.deepEqual(r, { success: true });
  const steps = o.calls.map((c) => `${c.method} ${c.url.replace("https://graph.microsoft.com/v1.0/", "")}`);
  assert.deepEqual(steps, [
    "POST me/messages",
    "POST me/messages/AAMk-9/attachments",
    "POST me/messages/AAMk-9/attachments/createUploadSession",
    "GET me/messages/AAMk-9?$select=changeKey",
    "POST me/messages/AAMk-9/send",
  ]);
  assert.equal(o.calls[1].body.contentBytes, Buffer.alloc(2000, 1).toString("base64"), "a small file in one request");
  assert.deepEqual(o.calls[2].body, { AttachmentItem: { attachmentType: "file", name: "shoot-photos.zip", size: 4194304, contentType: "application/zip" } });
  assert.deepEqual(o.puts.map((p) => p.range), ["bytes 0-3276799/4194304", "bytes 3276800-4194303/4194304"], "the large one in pieces");
  assert.ok(o.puts.every((p) => !p.auth), "the upload address carries its own permission");
  assert.deepEqual(o.calls[0].body.toRecipients, [{ emailAddress: { address: "editor@harbourpost.example" } }]);
});

test("a reply is written in its thread, and nothing is left behind when a step fails", async () => {
  const reply = outlook();
  await reply.sendOutlookMessage({ message_id: "AAMk-orig", body: "Thanks Mara." });
  assert.equal(reply.calls[0].url, "https://graph.microsoft.com/v1.0/me/messages/AAMk-orig/createReply");
  assert.deepEqual(reply.calls[0].body, { comment: "Thanks Mara." });

  const attachFails = outlook({ failAttach: true });
  attachFails.setFiles([{ fileName: "list.pdf", buffer: Buffer.alloc(10) }]);
  assert.match((await attachFails.sendOutlookMessage({ to: "a@harbourpost.example", subject: "s", body: "b", attachment_ids: ["x"] })).error, /413/);
  assert.equal(attachFails.calls.at(-1).method, "DELETE", "the half-made draft is taken away");
  assert.ok(!attachFails.calls.some((c) => /\/send$/.test(c.url)), "nothing sent without its file");

  const sendFails = outlook({ failSend: true });
  assert.match((await sendFails.sendOutlookMessage({ to: "a@harbourpost.example", subject: "s", body: "b" })).error, /503/);
  assert.equal(sendFails.calls.at(-1).method, "DELETE");
});

test("Outlook's mail tools are built on the same draft, and keep one draft per thread", () => {
  assert.match(block("outlook_send"), /await sendOutlookMessage\(\{ \.\.\.toolInput, message_id: undefined \}\)/);
  assert.match(block("outlook_reply"), /await sendOutlookMessage\(toolInput\)/);
  const create = block("outlook_create_draft");
  assert.match(create, /const existing = await draftOnThread\(orig\?\.\[0\]\?\.data\?\.threadId\);/);
  assert.match(create, /Edit it with outlook_draft_update/);
  assert.match(block("gmail_create_draft"), /const existing = await draftOnThread\(toolInput\.thread_id\);/, "Gmail uses the same guard");
  assert.match(block("create_mail_draft"), /const existing = await draftOnThread\(orig\?\.\[0\]\?\.data\?\.threadId\);/, "and other mail");
});

test("a rewritten draft keeps the pictures its wording placed, unless asked to drop them", () => {
  const { withInlineImages, textToHtml, replaceTextParts } = require("../lib/gmail-draft");
  const before = '<div>Hi Mara</div><img src="cid:court-1" alt="court"><div>Two land Monday</div>';
  const kept = withInlineImages(before, textToHtml("Hi Mara,\nThree land Monday."));
  assert.match(kept, /<div>Hi Mara,<\/div>\n<div>Three land Monday\.<\/div>\n<div><img src="cid:court-1" alt="court"><\/div>$/);
  assert.equal(withInlineImages(before, "<p>No pictures</p>", false), "<p>No pictures</p>");
  assert.equal(withInlineImages(before, '<p>See <img src="cid:court-1"></p>'), '<p>See <img src="cid:court-1"></p>', "not twice");
  // Gmail's rewrite still does the same through it.
  const raw = ['Content-Type: multipart/alternative; boundary="b1"', "", "--b1", "Content-Type: text/plain", "", "Old", "--b1", "Content-Type: text/html", "", before, "--b1--", ""].join("\r\n");
  const out = replaceTextParts(raw, "New wording", null, true);
  assert.equal(out.replaced, 2);
  const html = Buffer.from(out.raw.split("--b1")[2].split("\r\n\r\n")[1], "base64").toString();
  assert.match(html, /<div>New wording<\/div>\n<div><img src="cid:court-1" alt="court"><\/div>/);
  const update = block("outlook_draft_update");
  assert.match(update, /withInlineImages\(wasHtml \? live\.body\.content : "", toolInput\.body_html \|\| textToHtml\(toolInput\.body\), keepImages\)/);
  assert.match(update, /for \(const p of \(parts \|\| \[\]\)\.filter\(\(x\) => x\.isInline\)\)/);
  assert.match(read("lib/services/imap-mail.js"), /withInlineImages\(p\.html \|\| "", body_html \|\| textToHtml\(body\), keep_inline_images\)/);
});

test("Outlook events take the same fields as Google's, with attendees, files and a OneDrive link", () => {
  const fields = new Function("ctx", "require", src("outlookEventFields") + "\nreturn outlookEventFields;")(
    { store: { profile: { timezone: "Asia/Tokyo" } } }, (m) => require(m === "../timezone" ? "../lib/timezone" : m));
  const f = fields({ summary: "Shoot at the courts", start: "2026-11-02T10:00:00+09:00", end: "2026-11-02T12:00:00+09:00", description: "Bring racquets", location: "Harbour courts", attendees: "mara@harbourpost.example, ellie@harbourpost.example" });
  assert.equal(f.subject, "Shoot at the courts");
  assert.deepEqual(f.start, { dateTime: "2026-11-02T01:00:00", timeZone: "UTC" });
  assert.deepEqual(f.body, { contentType: "Text", content: "Bring racquets" });
  assert.deepEqual(f.attendees.map((a) => a.emailAddress.address), ["mara@harbourpost.example", "ellie@harbourpost.example"]);
  const create = block("outlook_cal_create_event");
  assert.match(create, /if \(attachments\.length\) await addOutlookAttachments\(msApi, `me\/events\/\$\{encodeURIComponent\(result\.id\)\}`, attachments\);/);
  assert.match(create, /oneDriveFile\(toolInput\.account, toolInput\.onedrive_file_id\)/);
  assert.match(block("outlook_cal_update_event"), /delete patch\.attendees;/, "an update never re-invites unasked");
  assert.match(block("outlook_cal_delete_event"), /microsoftReqFor\(toolInput\.account\)/, "any connected Microsoft account");
});

test("an invitation is a send: asked about first, under the same tick box", async () => {
  const gate = require("../lib/send-gate");
  assert.equal(gate.invites("outlook_cal_create_event", { attendees: "mara@harbourpost.example" }), true);
  assert.equal(gate.invites("outlook_cal_create_event", { attendees: " " }), false);
  assert.equal(gate.invites("gcal_create_event", { attendees: "mara@harbourpost.example" }), false, "Google adds attendees without emailing them");
  assert.match(gate.sendQuestion("outlook_cal_create_event", { summary: "Shoot", start: "2026-11-02T10:00:00+09:00", attendees: "mara@harbourpost.example" }),
    /^I'm about to create an Outlook event, which emails an invitation to each attendee[\s\S]*Event: Shoot[\s\S]*Invites: mara@harbourpost\.example$/);
  const engine = read("lib/engine.js");
  assert.match(engine, /if \(!needsConfirmation && require\("\.\/send-gate"\)\.invites\(block\.name, block\.input\)\n\s*&& ctx\.activeUserStore\?\.profile\?\.settings\?\.require_send_confirmation !== false\) needsConfirmation = true;/);
  assert.match(engine, /if \(block\.input\.attendees\) confirmSummary \+= `Invites: \$\{block\.input\.attendees\}\\n`;/);
  assert.match(read("lib/agents.js"), /if \(sendGate\.sendsToOthers\(block\.name, block\.input\) && sendConfirmRequired\(userStore\)/);
  const conf = read("lib/confirmation.js");
  assert.match(conf.slice(conf.indexOf("ACTIONS_NEEDING_CONFIRMATION"), conf.indexOf("];")), /"outlook_cal_update_event"/, "changing an event asks, as Google's does");
});

test("a background send is saved as a real draft first, in every mailbox", () => {
  const predraft = src("predraft");
  for (const name of ["gmail_send", "gmail_reply", "outlook_send", "outlook_reply", "send_mail", "reply_to_mail"]) assert.match(predraft, new RegExp(name));
  const agents = read("lib/agents.js");
  assert.match(agents, /\/\^\(gmail_send\|gmail_reply\|outlook_send\|outlook_reply\|send_mail\|reply_to_mail\)\$\/\.test\(pendingSend\.name\)/);
  assert.match(agents, /result = await require\("\.\/tools\/handlers"\)\.sendPredraft\(pending\.toolName, pending\.sendAccount, pending\.draftId\);/);
  assert.match(agents, /await require\("\.\/tools\/handlers"\)\.dropPredraft\(pending\.toolName, pending\.sendAccount, pending\.draftId\);/);
  assert.match(agents, /It's saved as a draft in \$\{require\("\.\/tools\/handlers"\)\.predraftHome\(pendingSend\.name\)\}/);
});

test("a draft read live through the API tools counts as seen", () => {
  const seen = new Map();
  const note = new Function("draftLastSeen", src("noteDraftRead") + "\nreturn noteDraftRead;")(seen);
  note("https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-1", { id: "r-1", message: { id: "msg-5" } });
  note("https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-2?format=minimal", { id: "r-2", message: { id: "msg-6" } });
  note("https://graph.microsoft.com/v1.0/me/messages/AAMk-1", { id: "AAMk-1", isDraft: true, changeKey: "ck-7", body: { content: "Hi" } });
  note("https://graph.microsoft.com/v1.0/me/messages/AAMk-2?$select=changeKey", { id: "AAMk-2", isDraft: true, changeKey: "ck-8" });
  note("https://graph.microsoft.com/v1.0/me/messages/AAMk-3", { id: "AAMk-3", isDraft: false, changeKey: "ck-9", body: {} });
  assert.deepEqual([...seen], [["r-1", "msg-5"], ["AAMk-1", "ck-7"]], "only reads that show the wording, and only drafts");
  assert.equal((handlers.match(/if \(method === "GET"\) noteDraftRead\((url|apiUrl), result\);/g) || []).length, 3, "every API read passes by");
});

test("Outlook's tools take what Google's take, but for what is Google's own", () => {
  const { INTERNAL_TOOLS } = require("../lib/tools/definitions");
  const props = (n) => Object.keys(INTERNAL_TOOLS.find((t) => t.name === n).input_schema.properties);
  const inherent = new Set(["thread_id", "drive_file_id"]); // Outlook finds the thread itself; OneDrive has its own id
  for (const [g, o] of [["gmail_send", "outlook_send"], ["gmail_reply", "outlook_reply"], ["gmail_create_draft", "outlook_create_draft"], ["gmail_draft_update", "outlook_draft_update"],
    ["gmail_send_draft", "outlook_send_draft"], ["gcal_create_event", "outlook_cal_create_event"], ["gcal_update_event", "outlook_cal_update_event"], ["gcal_delete_event", "outlook_cal_delete_event"]])
    assert.deepEqual(props(g).filter((p) => !props(o).includes(p) && !inherent.has(p)), [], `${o} lacks what ${g} takes`);
});
