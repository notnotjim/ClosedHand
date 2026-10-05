// A booking made in a WhatsApp chat was missed: a search that named no source
// searched mail alone, and the chat was stored under a number, so nothing
// said it was with a dental clinic. Searches with no source now carry every
// synced source, chats are named as messages arrive, and chats already stored
// are named and their day summaries renamed. All names and numbers invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { rememberName, learnContact } = require("../lib/whatsapp-names");
const { withOtherSources } = require("../lib/search-route");

test("a search that names no source also brings back WhatsApp and the rest", async () => {
  const mail = { results: [{ subject: "Your order" }] };
  const others = async (query, max) => [{ _source: "whatsapp", text: `next ${query} is at 9am`, max }];
  const all = await withOtherSources({ query: "appointment" }, mail, others);
  assert.deepEqual(all.results, mail.results, "mail stays the results");
  assert.equal(all.other_sources[0]._source, "whatsapp");
  assert.equal(all.other_sources[0].max, 20);
  for (const input of [{ query: "appointment", source: "gmail" }, { query: "appointment", type: "email" },
    { query: "appointment", unread_only: true }, { query: "appointment", has_attachment: true }, { query: "*" }, { query: "" }]) {
    assert.equal(await withOtherSources(input, mail, others), mail, `${JSON.stringify(input)} stays a mail search`);
  }
  assert.equal(await withOtherSources({ query: "x" }, mail, async () => { throw new Error("down"); }), mail, "a failed side search never loses the mail");
  assert.match(read("lib/tools/handlers.js"), /return await require\("\.\.\/search-route"\)\.withOtherSources\(toolInput, mail,/);
  assert.match(read("lib/tools/definitions.js"), /With no source or type it searches all of them: mail as the results, everything else under other_sources\./);
});

test("a chat is named by its contact, group or the business itself, never by a number", () => {
  const names = {};
  rememberName(names, "111@lid", "Harbour Dental", { weak: true });
  assert.equal(names["111@lid"], "Harbour Dental", "the name a business gives itself fills a gap");
  rememberName(names, "111@lid", "Dr Lee's clinic");
  assert.equal(names["111@lid"], "Dr Lee's clinic", "a saved contact name wins");
  rememberName(names, "111@lid", "Someone else", { weak: true });
  assert.equal(names["111@lid"], "Dr Lee's clinic", "a self-given name never replaces a saved one");
  rememberName(names, "222@lid", "+44 7700 900123");
  assert.equal(names["222@lid"], undefined, "a number is not a name");
  learnContact(names, { id: "447700900456@s.whatsapp.net", lid: "333@lid", verifiedName: "Lakeside Tours" });
  assert.equal(names["333@lid"], "Lakeside Tours", "a contact is found under its private id too");
  const linked = read("lib/platforms/whatsapp-linked.js");
  assert.match(linked, /async function ingestMessages\(userId, entries, chatNames = _chatNames\)/, "live messages are stored with names");
  assert.match(linked, /if \(!msg\.key\.fromMe && !jid\.endsWith\("@g\.us"\)\) rememberName\(chatNames, jid, msg\.pushName, \{ weak: true \}\);/);
  for (const ev of ["contacts.upsert", "contacts.update", "chats.upsert", "chats.update", "groups.upsert", "groups.update"]) {
    assert.match(linked, new RegExp(`sock\\.ev\\.on\\("${ev.replace(".", "\\.")}"`), `${ev} teaches names`);
  }
  assert.match(linked, /rememberName\(_chatNames, jid, \(await sock\.groupMetadata\(jid\)\)\?\.subject\)/, "an unnamed group is asked once");
});

test("stored chats are named, and their day summaries renamed and re-indexed", async () => {
  const sql = read("migrations/053_whatsapp_chat_names.sql");
  assert.match(sql, /CREATE OR REPLACE FUNCTION name_whatsapp_chats\(match_user_id uuid\)/);
  assert.match(sql, /AND dc\.data->>'chat' NOT LIKE '%@g\.us'/, "a group is never named after one member");

  const vectors = [
    { id: 1, content: "[WhatsApp 111, 2026-09-30] I told contact 111 the next appointment is at 9am.", source_metadata: { chat: "111@lid", chat_name: "111" } },
    { id: 2, content: "[WhatsApp Book club, 2026-09-29] Chose the next book.", source_metadata: { chat: "444@g.us", chat_name: "Book club" } },
    { id: 3, content: "[WhatsApp 555, 2026-09-28] Unknown sender.", source_metadata: { chat: "555@lid", chat_name: "555" } },
  ];
  const updates = [];
  const supabase = {
    rpc: async (name, args) => ({ data: name === "name_whatsapp_chats" && args.match_user_id === "u1" ? [{ chat: "111@lid", name: "Harbour Dental" }] : [], error: null }),
    from: () => {
      const q = {
        select: () => q, eq: () => q,
        update: (patch) => ({ eq: async (_col, id) => { updates.push({ id, patch }); return { error: null }; } }),
        then: (done) => Promise.resolve({ data: vectors, error: null }).then(done),
      };
      return q;
    },
  };
  const { nameChats, renameDaySummaries } = require("../lib/services/wa-digest")._test;
  const names = await nameChats(supabase, "u1");
  const embedded = [];
  const n = await renameDaySummaries(supabase, "u1", names, async (text) => { embedded.push(text); return [0.1, 0.2]; });
  assert.equal(n, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 1);
  assert.equal(updates[0].patch.content, "[WhatsApp Harbour Dental, 2026-09-30] I told contact Harbour Dental the next appointment is at 9am.");
  assert.deepEqual(updates[0].patch.source_metadata, { chat: "111@lid", chat_name: "Harbour Dental" });
  assert.deepEqual(embedded, [updates[0].patch.content], "re-embedded from the renamed text, no model summary");
  assert.match(read("lib/services/wa-digest.js"), /chat_name: names\.get\(m\.chat\) \|\| m\.chat_name/, "new summaries use the name too");
});
