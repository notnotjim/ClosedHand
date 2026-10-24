// Projects (lib/projects.js, webapp/projects.js, webapp/public/projects.js)
// work as Claude's projects do, with an emoji as the way in from any chat app.
// A message starting with the emoji, or replying to a message that does, runs
// in the project's own conversation with its description, instructions,
// context and the text of its files, and its reply starts with the emoji; any
// other message sees only each project's emoji and name. The emoji alone says
// where it stands, with its page. Closedhand makes a project itself when
// something comes up again, and that reply says so; one the person deletes
// is not made again for a month. Both services hold to one set of rules
// (project-rules.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const rules = require("../lib/project-rules");

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

function fakeDb(tables) {
  const log = { updates: [], inserts: [], deletes: [] };
  const value = (r, k) => r[k];
  const db = {
    from(table) {
      const rows = tables[table] || (tables[table] = []);
      const filters = [];
      let op = "select", patch = null, single = false;
      const q = {
        select: () => q, order: () => q, limit: () => q,
        eq: (k, v) => { if (k !== "user_id") filters.push((r) => value(r, k) === v); return q; },
        in: (k, v) => { filters.push((r) => v.includes(value(r, k))); return q; },
        is: (k, v) => { filters.push((r) => (value(r, k) ?? null) === v); return q; },
        update: (p) => { op = "update"; patch = p; return q; },
        insert: (p) => { op = "insert"; patch = p; return q; },
        delete: () => { op = "delete"; return q; },
        single: () => { single = true; return q; },
        then: (ok, bad) => {
          let out;
          if (op === "insert") {
            const row = table === "projects" ? { id: `p-new-${log.inserts.length + 1}`, about: "", state: {}, context: [], last_touched: iso(Date.now()), created_at: iso(Date.now()), ...patch } : { id: `t-new-${log.inserts.length + 1}`, ...patch };
            rows.push(row); log.inserts.push(row);
            out = { data: single ? row : [row], error: null };
          } else {
            const hit = rows.filter((r) => filters.every((f) => f(r)));
            if (op === "update") { hit.forEach((r) => Object.assign(r, patch)); log.updates.push({ table, patch }); out = { data: single ? hit[0] : hit, error: null }; }
            else if (op === "delete") { hit.forEach((r) => rows.splice(rows.indexOf(r), 1)); log.deletes.push(hit.map((r) => r.id)); out = { error: null }; }
            else out = { data: single ? hit[0] : hit, error: null };
          }
          return Promise.resolve(out).then(ok, bad);
        },
      };
      return q;
    },
  };
  return { db, log };
}

function loadProjects(rows, answer = '{"touched":[]}', { threads = [], files = {}, goals = [] } = {}) {
  const { db, log } = fakeDb({ projects: rows, conversation_threads: threads });
  const asked = [];
  const fakes = {
    "./attachments": { loadAttachment: async (id) => (files[id] ? { _type: "text", textContent: files[id] } : { error: "gone" }) },
    "./goals": { activeGoals: async () => goals, promptLines: (gs) => gs.map((g) => `- [goal ${g.id.slice(0, 8)}] ${g.title}`) },
    "./timezone": { getUserTimezone: () => "UTC" },
    "./db": { supabase: db },
    "./llm": { getInternalClient: () => ({ model: "m", client: { messages: { create: async (req) => { asked.push(req.messages[0].content); return { answer }; } } } }) },
    "./model-wire": { responseText: (r) => r.answer },
    "./services/usi": { embedText: async () => null, embedBatch: async () => [] },
  };
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /lib[\\/]projects\.js$/.test(parent.filename) && fakes[request]) return fakes[request];
    return load.call(this, request, parent, ...rest);
  };
  delete require.cache[require.resolve("../lib/projects")];
  const projects = require("../lib/projects");
  return { projects, log, asked, rows, threads };
}

const move = (extra = {}) => ({ id: "aaaa1111-move", name: "House move", emoji: "📦", about: "Moving from our flat in Leeds to a house in York.", instructions: "Always use the Leeds address on forms until the move.\nKeep the van and movers under 900 together.", summary: "Van booked for Saturday.",
  state: { people: [{ name: "Dana Fixture", position: "helping", said: "brings the van", when: null }], open: ["Pay the deposit", "Book the parking permit"], decisions: ["Movers at 9"], facts: [] },
  context: [{ kind: "link", id: "link_1", url: "https://movers.example.com/quote", title: "Quote" }, { kind: "note", id: "note_1", title: "Boxes", text: "Kitchen 12, books 8." },
    { kind: "email", id: "gmail:m1", source: "gmail", ref: "m1", title: "Van booking", from: "Dana Fixture", at: "2026-11-03T09:00:00.000Z" }], status: "active", expected_end: null, last_touched: iso(Date.now()), created_at: iso(Date.now() - 5 * DAY), ...extra });
const wedding = (extra = {}) => ({ id: "bbbb2222-wedding", name: "Wedding", emoji: "💍", about: "", summary: "Venue held.", state: {}, context: [], status: "active", last_touched: iso(Date.now()), created_at: iso(Date.now()), ...extra });

test("one emoji is one mark, however it was typed", () => {
  assert.equal(rules.firstMark("📦 always use the Leeds address"), "📦");
  assert.equal(rules.firstMark("hello 📦"), null);
  assert.equal(rules.firstMark("1 more thing"), null, "a digit is not a mark");
  assert.equal(rules.onlyMark(" 💍 "), "💍");
  assert.equal(rules.onlyMark("💍 venue"), null);
  assert.equal(rules.markKey("☕️"), rules.markKey("☕"), "with or without the colour selector");
  assert.equal(rules.markKey("👍🏽"), rules.markKey("👍"), "any skin tone");
  assert.deepEqual(rules.splitReply("[replying to Closedhand's message: \"📦 Van is booked\"]\nand the keys?"), { quoted: "📦 Van is booked", rest: "and the keys?" });
  assert.deepEqual(rules.splitReply("[Replying to: \"💍 Venue\"]\n\nok"), { quoted: "💍 Venue", rest: "ok" });
  assert.equal(rules.takenBy([move()], "📦").name, "House move");
  assert.equal(rules.takenBy([move({ status: "archived" })], "📦"), null, "an archived project lets its emoji go");
  const typed = rules.typed(["https://a.example.com/x", "not a link", { url: "javascript:alert(1)" }, { kind: "note", text: "Brief\nfor the client" }, { kind: "note", text: "  " }]);
  assert.deepEqual(typed.map((c) => [c.kind, c.url || c.title]), [["link", "https://a.example.com/x"], ["note", "Brief"]]);
  assert.equal(rules.file("../etc/passwd", "x"), null, "a file is only an attachment id");
  const mail = rules.synced({ source: "gmail", type: "email", external_id: "m9", data: { subject: "Quote for the van", from: "Dana Fixture <dana@example.com>", date: "2026-11-02T10:00:00Z", webLink: "https://mail.google.com/mail/#all/m9" } });
  assert.deepEqual(mail, { kind: "email", id: "gmail:m9", source: "gmail", ref: "m9", title: "Quote for the van", from: "Dana Fixture", at: "2026-11-02T10:00:00.000Z", web: "https://mail.google.com/mail/#all/m9" });
  assert.equal(rules.synced({ source: "gcal", type: "event", external_id: "e1", data: { summary: "Viewing", start: "2026-11-05T15:00:00Z" } }).at, "2026-11-05T15:00:00.000Z");
  assert.equal(rules.withContext([mail], [mail, rules.link("https://a.example.com/x")]).length, 2, "nothing twice");
  const both = rules.merged(move(), wedding({ about: "Our wedding in June.", instructions: "Small and outdoors.", state: { open: ["Pay the deposit", "Send invitations"] }, context: [{ kind: "file", id: "att_1", title: "plan.pdf" }] }));
  assert.deepEqual(both.state.open, ["Pay the deposit", "Book the parking permit", "Send invitations"]);
  assert.equal(both.about, "Moving from our flat in Leeds to a house in York.", "the project kept says what it is");
  assert.equal(both.instructions, "Always use the Leeds address on forms until the move.\nKeep the van and movers under 900 together.\nSmall and outdoors.");
  assert.equal(both.context.length, 4);
  // Every emoji the dashboard's picker offers is a mark.
  const offered = JSON.parse(read("webapp/public/emoji-list.json")).groups.flatMap((g) => g[1].map((x) => x[0]));
  assert.ok(offered.length > 1800);
  assert.deepEqual(offered.filter((e) => rules.onlyMark(e) !== e), []);
  assert.equal(read("lib/project-rules.js"), read("webapp/project-rules.js"));
});

test("a message with the emoji is in the project, with all of it; any other sees only names", async () => {
  const { projects } = loadProjects([move(), wedding()]);
  await projects.warm("u1");
  const filed = await projects.fileTurn("u1", "📦 the landlord wants the keys by noon");
  assert.equal(filed.project.name, "House move");
  const block = projects.getProjectsBlock("u1");
  assert.match(block, /^\nTHIS MESSAGE IS IN THE PROJECT 📦 House move \(it starts with its emoji\)\. The conversation above is this project's own\. Work from the project's record, and follow its instructions for anything in it:\nWhat it is, in their words: Moving from our flat in Leeds to a house in York\.\nTheir instructions for it \(follow these for anything in this project\):\n- Always use the Leeds address on forms until the move\.\n- Keep the van and movers under 900 together\./);
  assert.match(block, /Open: Pay the deposit; Book the parking permit/);
  assert.match(block, /Context they gave it \(open a file with view_attachment, an app item with read_cached_record\):\n- Link: Quote https:\/\/movers\.example\.com\/quote\n- Note "Boxes": Kitchen 12, books 8\.\n- Email from Dana Fixture: "Van booking", 3 Nov \(source gmail, id m1\)/);
  assert.doesNotMatch(block, /Wedding|Venue held/, "another project stays out of it");
  assert.equal(projects.markReply("u1", "Noted, noon it is.").text, "📦 Noted, noon it is.");
  assert.equal(projects.markReply("u1", "📦 Noted.").text, "📦 Noted.", "never twice");

  const reply = await projects.fileTurn("u1", "[Replying to: \"💍 The venue is held until Friday\"]\n\nbook it");
  assert.equal(reply.how, "reply");
  assert.match(projects.getProjectsBlock("u1"), /THIS MESSAGE IS IN THE PROJECT 💍 Wedding \(it replies to a message from it\)/);

  // No emoji: none of any project, only what there is.
  assert.equal(await projects.fileTurn("u1", "did dana confirm the house move van?"), null);
  assert.equal(await projects.pickTouched("u1", "did dana confirm the house move van?"), null, "no guessing a project by meaning");
  const plain = projects.getProjectsBlock("u1");
  assert.equal(plain, "\nTHEIR PROJECTS (each has a conversation of its own, reached by starting a message with its emoji; this message is in none of them): 📦 House move, 💍 Wedding\n");
  assert.equal(projects.markReply("u1", "Yes, Saturday.").text, "Yes, Saturday.");
  assert.equal(await projects.fileTurn("u1", "😂 that's funny"), null, "an emoji that marks nothing files nothing");
});

test("a project message runs in the project's own conversation, with its files' text, and the other comes back after", async () => {
  const ctx = require("../lib/context");
  const general = [{ role: "user", content: "what's the weather" }, { role: "assistant", content: "Sunny." }];
  ctx.store = { conversations: { u1: general } };
  ctx.activeThreadId = "general-thread";
  const doc = move({ context: [{ kind: "file", id: "att_1", title: "Inventory.pdf" }, { kind: "file", id: "att_2", title: "Photo.jpg" }, { kind: "file", id: "att_3", title: "Huge.pdf" }] });
  const { projects, threads } = loadProjects([doc, wedding()], undefined, { files: { att_1: "Sofa, two beds, 40 boxes.", att_3: "x".repeat(20000) } });
  const turn = await projects.openTurn("u1", "📦 how many boxes are there?");
  assert.equal(threads.length, 1, "its conversation is made the first time");
  assert.equal(threads[0].project_id, "aaaa1111-move");
  assert.equal(threads[0].is_active, false, "and is never the open one");
  assert.equal(threads[0].title, "📦 House move");
  assert.deepEqual(ctx.store.conversations.u1, [], "the general conversation is not in it");
  assert.equal(ctx.activeThreadId, threads[0].id);
  const block = projects.getProjectsBlock("u1");
  assert.match(block, /FILE "Inventory\.pdf" \(att_1\), its text:\nSofa, two beds, 40 boxes\./);
  assert.doesNotMatch(block, /xxxxxxxxxx/, "a file past the budget is listed, not served");
  assert.match(block, /- File: Huge\.pdf \(att_3\)/);
  ctx.store.conversations.u1.push({ role: "user", content: "📦 how many boxes are there?" }, { role: "assistant", content: "📦 40 boxes." });
  await turn.close();
  assert.equal(threads[0].messages.length, 2, "what was said is kept with the project");
  assert.ok(threads[0].messages[0].ts);
  assert.equal(ctx.store.conversations.u1, general, "the general conversation is back, untouched");
  assert.equal(ctx.activeThreadId, "general-thread");
  assert.equal(projects.turnOf("u1"), null);
  // The next message with the emoji carries on where it left off.
  const again = await projects.openTurn("u1", "📦 and the sofa?");
  assert.equal(ctx.store.conversations.u1.length, 2);
  await again.close();
  assert.equal(await projects.openTurn("u1", "and the sofa?"), null, "no emoji, no project");
  assert.equal(ctx.store.conversations.u1, general);
});

test("a project's goal rides in its messages, a line beside its name outside, and a check-in's answer stays in it", async () => {
  const goal = { id: "9999aaaa-goal", project_id: "aaaa1111-move", title: "Out by the 30th", status: "active", plan: [] };
  const { projects, threads } = loadProjects([move(), wedding()], undefined, { goals: [goal] });
  await projects.warm("u1");
  await projects.fileTurn("u1", "📦 how is it going?");
  assert.match(projects.getProjectsBlock("u1"), /Its goal \(record progress with goal_progress, change it with goal_set\):\n- \[goal 9999aaaa\] Out by the 30th/);
  await projects.fileTurn("u1", "what's the weather");
  assert.match(projects.getProjectsBlock("u1"), /: 📦 House move \(goal: Out by the 30th\), 💍 Wedding\n/);
  // A check-in is kept in the project's conversation, and the next message answers it there.
  await projects.said("u1", move(), "📦 Two weeks to go. Have you booked the van?", { asks: true });
  assert.equal(threads[0].project_id, "aaaa1111-move");
  assert.deepEqual(threads[0].messages.map((m) => m.content), ["📦 Two weeks to go. Have you booked the van?"]);
  const answer = await projects.fileTurn("u1", "yes, booked for Saturday");
  assert.equal(answer && answer.project.name, "House move", "the answer is in the project, emoji or not");
  assert.equal(answer.how, "reply");
  assert.equal(await projects.fileTurn("u1", "and what's the weather"), null, "only the next message");
  await projects.said("u1", move(), "📦 How did it go?", { asks: true });
  assert.equal((await projects.fileTurn("u1", "💍 the venue called")).project.name, "Wedding", "another project's emoji wins");
});

test("the emoji alone says where it stands, with its page, in two lines", async () => {
  const { projects } = loadProjects([move()]);
  await projects.warm("u1");
  const p = projects.onlyMarkProject("u1", "📦");
  assert.equal(projects.statusText(p, "https://bright-river-12.closedhand.ai/page/project/aaaa1111-move", "telegram"),
    "📦 House move: Van booked for Saturday.\nStill open: Pay the deposit; Book the parking permit.\nIts page: https://bright-river-12.closedhand.ai/page/project/aaaa1111-move");
  assert.match(projects.statusText(p, "/page/project/aaaa1111-move", "web"), /\[Open its page\]\(\/page\/project\/aaaa1111-move\)$/);
  assert.equal(projects.onlyMarkProject("u1", "📦 and?"), null);
  const engine = read("lib/engine.js");
  assert.match(engine, /const asked = !fileData && projects\.onlyMarkProject\(userId, userMessage\);[\s\S]{0,400}closedhandLink\(deliverPlatform, `\/page\/project\/\$\{asked\.id\}`\)[\s\S]{0,300}return text;/);
});

test("an archived project comes back when its emoji is used, unless another has it now", async () => {
  const old = move({ status: "archived", archived_at: iso(Date.now() - DAY), expected_end: iso(Date.now() - 4 * DAY) });
  const { projects, rows } = loadProjects([old]);
  await projects.warm("u1");
  const filed = await projects.fileTurn("u1", "📦 one box left at the old flat");
  assert.equal(filed.project.status, "active");
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].expected_end, null, "its end date has passed, so it goes");
  const taken = loadProjects([move({ id: "cccc3333-old", status: "archived" }), move({ id: "dddd4444-new", name: "Office move" })]);
  await taken.projects.warm("u1");
  assert.equal((await taken.projects.fileTurn("u1", "📦 desks")).project.name, "Office move");
});

test("end dates archive, a note not come up again goes, and a deleted name goes after a month", async () => {
  const now = Date.now();
  const { projects, rows } = loadProjects([
    move({ expected_end: iso(now - 3 * DAY) }),
    { id: "o1", name: "Mia's party", status: "offered", emoji: "🎉", state: {}, created_at: iso(now - 9 * DAY), last_touched: iso(now - 4 * DAY) },
    { id: "o3", name: "Book club", status: "offered", emoji: "📚", state: {}, created_at: iso(now - 9 * DAY), last_touched: iso(now - DAY) },
    { id: "o2", name: "Old idea", status: "declined", state: {}, created_at: iso(now - 40 * DAY), last_touched: iso(now - 40 * DAY) },
    { id: "o4", name: "Gym plan", status: "declined", state: {}, created_at: iso(now - 5 * DAY), last_touched: iso(now - 5 * DAY) },
  ]);
  await projects.warm("u1");
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [["aaaa1111-move", "archived"], ["o3", "offered"], ["o4", "declined"]]);
});

test("something noticed is made a project when it comes up again, and that reply says so once", async () => {
  const noticed = { id: "eeee5555-party", name: "Mia's party", emoji: "📦", status: "offered", summary: "Party on the 14th, three yes so far", state: { people: [{ name: "Ravi Fixture", position: "yes" }] }, links: [], files: [], offered_at: null, created_at: iso(Date.now()), last_touched: iso(Date.now()) };
  const { projects, rows } = loadProjects([noticed, move()]);
  await projects.warm("u1");
  await projects.fileTurn("u1", "ravi fixture said yes to mia's party");
  assert.equal(await projects.pickTouched("u1", "ravi fixture said yes to mia's party"), "eeee5555-party");
  const block = projects.getProjectsBlock("u1");
  assert.match(block, /PROJECT JUST MADE: This message is about something that has come up before: Mia's party[\s\S]*I've made this a project: 🗂️ Mia's party\. Start a message with 🗂️ to pick it up from any chat, or archive it under Projects on the dashboard\./);
  assert.deepEqual([rows[0].status, rows[0].emoji], ["active", "🗂️"], "made at once, with a free emoji: 📦 is House move's");
  assert.equal(rows[0].state.people[0].name, "Ravi Fixture", "what was noticed comes with it");
  assert.doesNotMatch(projects.getProjectsBlock("u1"), /PROJECT JUST MADE/, "said once");

  // Asked for by name when it was already noticed: that one becomes it.
  const again = loadProjects([{ ...noticed, status: "offered", emoji: "🎉" }, move()]);
  const made = await again.projects.create("u1", { name: "mia's party", emoji: "🎈" });
  assert.equal(made.project.status, "active");
  assert.equal(made.project.state.people[0].name, "Ravi Fixture");
  assert.equal(again.rows.length, 2, "one project, not a second beside it");
});

test("starting and changing a project holds to one emoji each", async () => {
  const { projects, rows, threads } = loadProjects([move()]);
  assert.match((await projects.create("u1", { name: "Office move", emoji: "📦" })).error, /📦 already marks House move\. Choose another emoji\./);
  assert.match((await projects.create("u1", { name: "Trip", emoji: "trip" })).error, /one emoji of its own/);
  const trip = (await projects.create("u1", { name: "Osaka trip", emoji: "✈️", about: "Two weeks in Osaka in April", instructions: "Window seats", context: ["https://hotel.example.com/booking", { kind: "note", text: "Ryokan for two nights" }] })).project;
  assert.equal(trip.status, "active");
  assert.deepEqual(trip.context.map((c) => c.kind), ["link", "note"]);
  await projects.addFiles("u1", trip.id, [{ id: "att_9", name: "tickets.pdf" }]);
  const upd = await projects.update("u1", trip.id, { add_instruction: "Never before 9am" });
  assert.equal(upd.project.instructions, "Window seats\nNever before 9am");
  assert.equal(upd.project.about, "Two weeks in Osaka in April", "an instruction never changes what it is");
  assert.deepEqual(upd.project.context.map((c) => c.title), ["", "Ryokan for two nights", "tickets.pdf"]);
  const gone = await projects.update("u1", trip.id, { remove_context: "att_9" });
  assert.equal(gone.project.context.length, 2);
  assert.match((await projects.update("u1", trip.id, { emoji: "📦" })).error, /already marks House move/);
  threads.push({ id: "t1", project_id: trip.id, messages: [{ role: "user", content: "✈️ window seats please" }] }, { id: "t2", project_id: "aaaa1111-move", messages: [{ role: "user", content: "📦 van booked" }] });
  const merged = await projects.merge("u1", "aaaa1111-move", trip.id);
  assert.equal(merged.project.context.length, 5);
  assert.equal(rows.length, 1, "the merged one goes");
  assert.deepEqual(threads.find((t) => t.id === "t2").messages.map((m) => m.content), ["✈️ window seats please", "📦 van booked"], "their conversations become one, the latest last");
});

test("the pass after a turn: a project message updates that project only; any other can only notice, once, never a no", async () => {
  const answer = JSON.stringify({ touched: [
    { id: "aaaa1111", name: "House move", summary: "Deposit paid.", state: { open: ["Book the parking permit"], decisions: ["Movers at 9"], people: [], facts: [] }, expected_end: null },
    { id: "bbbb2222", name: "Wedding", summary: "Changed from outside", state: {} },
    { id: "new", name: "Book club", emoji: "📚", summary: "Monthly, at Ravi's", state: { people: [{ name: "Ravi Fixture", position: "host" }] } },
    { id: "new", name: "Second thing", emoji: "🎯", summary: "x", state: {} },
  ] });
  const declined = { id: "zz", name: "Gym plan", status: "declined", state: {}, created_at: iso(Date.now()), last_touched: iso(Date.now()) };
  const inProject = loadProjects([move(), wedding(), declined], answer);
  await inProject.projects.updateFromTurn("u1", "📦 paid the deposit", "📦 Done.", [], { filedId: "aaaa1111-move" });
  assert.match(inProject.asked[0], /THE PROJECT THIS CONVERSATION IS IN \(the current picture\):\n\{"id":"aaaa1111","name":"House move"/);
  assert.doesNotMatch(inProject.asked[0], /Wedding|Gym plan/, "no other project rides along");
  assert.match(inProject.asked[0], /Return only the project above, and only if this turn changed its picture\. Never "new"\./);
  assert.equal(inProject.rows[0].summary, "Deposit paid.");
  assert.equal(inProject.rows[0].name, "House move", "the person's own name stays");
  assert.equal(inProject.rows[1].summary, "Venue held.", "another project is never changed from here");
  assert.equal(inProject.rows.filter((r) => r.status === "offered").length, 0, "nothing new is noticed inside a project");

  const outside = loadProjects([move(), wedding(), declined], answer);
  await outside.projects.updateFromTurn("u1", "I'm starting a book club at Ravi's", "Nice.", []);
  assert.match(outside.asked[0], /THEIR PROJECTS \(each kept in a conversation of its own; never return these, or a new one for the same thing\): \["House move","Wedding"\]/);
  assert.match(outside.asked[0], /NOT TO NOTICE AGAIN \(the user deleted these projects\): \["Gym plan"\]/);
  assert.equal(outside.rows[0].summary, "Van booked for Saturday.", "a message outside a project never changes one");
  assert.deepEqual(outside.rows.filter((r) => r.status === "offered").map((r) => [r.name, r.emoji]), [["Book club", "📚"]], "one offer a turn");
});

test("the engine, tools and claims check use projects", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /const marked = projects\.markReply\(userId, finalText\);\n\s*finalText = marked\.text;\n\s*conversation\.push\(\{ role: "assistant", content: finalText \}\);/);
  assert.match(engine, /const project = await projects\.openTurn\(userId, userMessage, \{ projectId: opts\.project \|\| null \}\)[\s\S]{0,600}return await ask\(userId, userMessage, fileData, chatId, false, turnOpts\);\n\s*\} finally \{\n\s*if \(project\) await project\.close\(\)/);
  assert.match(engine, /const filedId = marked\.projectId;/);
  assert.match(engine, /if \(attachmentId && filed && filed\.how !== "offer"\) \{\n\s*const many = imageSet && imageSet\.length > 1;\n\s*projects\.addFiles\(userId, filed\.id,/);
  assert.match(engine, /if \(tool\.coreWithProjects\) return projects\.hasProjects\(ctx\.activeUserId\);/);
  assert.match(engine, /\{ words: \/\\bprojects\?\\b\/i, tools: \/\^project_\/ \}/);
  assert.match(engine, /PROJECTS: something they are working on over days or weeks/);
  const defs = read("lib/tools/definitions.js");
  for (const name of ["project_create", "project_update", "project_get"]) assert.match(defs, new RegExp(`name: "${name}"`));
  assert.doesNotMatch(defs, /matter_/);
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /if \(toolInput\.add_item\) \{\n\s*\/\/ Kept from the stored record itself[\s\S]{0,700}add\.push\(rules\.synced\(rows\[0\]\)\);/, "an app item is read from the stored record, not taken from the model");
  assert.match(read("lib/tools/handlers.js"), /case "project_create": \{[\s\S]{0,900}closedhandLink\(toolInput\._platform \|\| ctx\.activePlatform \|\| "web", `\/page\/project\/\$\{p\.id\}`\)/);
  // A project's conversation never becomes the open one, nor shows as a thread.
  assert.match(read("user-store.js"), /\.eq\("user_id", userId\)\n\s*\.is\("project_id", null\)\n\s*\.order\("updated_at", \{ ascending: false \}\)\n\s*\.limit\(1\)/);
  // Threads are not listed, switched or archived by hand any more: the web
  // chat lists Chat and the projects (webapp/projects.js /api/conversations).
  const server = read("webapp/server.js");
  assert.doesNotMatch(server, /\/api\/threads|\/api\/chat\/activity/);
  assert.doesNotMatch(read("lib/conversation.js"), /function (archiveThread|switchThread|getThreadList|deleteThread|shouldNudgeNewThread)\(/);
  assert.match(read("migrations/068_projects.sql"), /ALTER TABLE conversation_threads ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects\(id\) ON DELETE CASCADE;/);
  assert.match(read("lib/claims-check.js"), /const open = await require\("\.\/projects"\)\.live\(userId\);/);
  assert.match(read("lib/attachments.js"), /if \(await adoptStored\(attachmentId\)\) return loadAttachment\(attachmentId\);/);
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "lib", "matters.js")));
  assert.match(read("migrations/068_projects.sql"), /DROP TABLE IF EXISTS matters;[\s\S]*CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_one_emoji ON projects \(user_id, emoji\) WHERE status = 'active';/);
});

test("the dashboard has a Projects tab, Context Brain has no Ongoing, and each project has a page", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /data-tab="automations"[^\n]*>Schedules<\/button>\n\s*<button class="tab" data-tab="projects" onclick="switchTab\('projects'\)">Projects<\/button>\n\s*<button class="tab" data-tab="pages"/);
  assert.match(dash, /<script defer src="\/projects\.js"><\/script>/);
  assert.doesNotMatch(dash, /data-filter="matters"|\/api\/matters/);
  assert.match(dash, /\['connections', 'automations', 'projects', 'pages'/);
  const server = read("webapp/server.js");
  assert.match(server, /require\("\.\/projects"\)\.register\(app, \{ db: supabase, userId: getUserIdFromRequest, withAppearance: assets\.withAppearance \}\);/);
  assert.doesNotMatch(server, /from\("matters"\)/);
  const web = read("webapp/projects.js");
  assert.match(dash, /<p class="goals-intro">Things you're working on over days or weeks, like a goal, trip or move\.<br>Closedhand makes one when something keeps coming up in chat, and a message starting with its emoji picks up its history, status and files\.<\/p>/);
  for (const route of ['app.get("/api/projects/find"', 'app.get("/api/projects"', 'app.post("/api/projects"', 'app.patch("/api/projects/:id"', 'app.post("/api/projects/:id/merge"', 'app.delete("/api/projects/:id"', 'app.post("/api/projects/:id/files"', 'app.get("/page/project/:id"']) assert.ok(web.includes(route), route);
  assert.ok(JSON.parse(read("closedhand-com/workers/edge/direct-routes.json")).includes("/page/*"), "the page reaches the computer through the tunnel");
  const { projectHtml } = require("../webapp/projects");
  const now = Date.parse("2026-11-01T12:00:00Z");
  const p = move({ name: "House <move>", expected_end: "2026-11-10T00:00:00Z", last_touched: "2026-11-01T10:00:00Z", context: [...move().context, { kind: "file", id: "att_1", title: "floor plan.pdf" }] });
  const html = projectHtml(p, now);
  assert.match(html, /<div class="mark" aria-hidden="true">📦<\/div>/);
  assert.match(html, /<h1><span class="stroke">House &lt;move&gt;<\/span><\/h1>/);
  assert.match(html, /Updated 2 hours ago<span class="until">9 days to go<\/span>/);
  assert.match(html, /<p class="lead">Moving from our flat in Leeds to a house in York\.<\/p>\n<div class="stands"><span class="label">Where it stands<\/span><p>Van booked for Saturday\.<\/p><\/div>/);
  assert.match(html, /<aside class="col"><section><h2>Instructions<\/h2><ul class="rules"><li>Always use the Leeds address on forms until the move\.<\/li><li>Keep the van and movers under 900 together\.<\/li><\/ul><\/section>/);
  // Most projects have no end date: no countdown, just when it last moved.
  const open = projectHtml(move({ expected_end: null, last_touched: "2026-10-29T12:00:00Z" }), now);
  assert.match(open, /Updated 3 days ago<\/p>/);
  assert.doesNotMatch(open, /class="until"/);
  assert.match(projectHtml(move({ expected_end: "2026-10-31T09:00:00Z" }), now), /<span class="until">Ended 31 October<\/span>/);
  assert.match(projectHtml(move({ expected_end: "2026-11-02T09:00:00Z" }), now), /<span class="until">Tomorrow<\/span>/);
  assert.match(html, /<h2>Still open<span class="count">2<\/span><\/h2><ul class="checks"><li><span class="box" aria-hidden="true"><\/span>Pay the deposit<\/li>/);
  assert.match(html, /<span class="name">Dana Fixture <span class="stance role">helping<\/span><\/span><span class="said">brings the van<\/span>/);
  assert.match(html, /<a class="ctx" href="\/api\/files\/att_1\/download">[\s\S]*?floor plan\.pdf<\/span><span class="ctx-meta">PDF<\/span>/);
  assert.match(html, /<a class="ctx" href="https:\/\/movers\.example\.com\/quote" target="_blank" rel="noopener">[\s\S]*?Quote<\/span><span class="ctx-meta">movers\.example\.com<\/span>/);
  assert.match(html, /<details class="ctx note"><summary>[\s\S]*?Boxes<\/span>[\s\S]*?<div class="note-text">Kitchen 12, books 8\.<\/div><\/details>/);
  assert.match(html, /<div class="ctx">[\s\S]*?Van booking<\/span><span class="ctx-meta">Email · Dana Fixture · 3 November<\/span>/);
  assert.match(html, /<a class="manage" href="\/dashboard#projects">Change it on the dashboard<\/a>/);
  assert.match(html, /<footer>Start a message with <span class="em">📦<\/span> in any chat to carry on with House &lt;move&gt;\.<\/footer>/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  const talk = projectHtml(move(), now, [
    { role: "user", content: "[Replying to: \"📦 Van booked\"]\n\n📦 what time do the movers come?", ts: "2026-10-30T09:00:00Z" },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "search_cache", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "..." }] },
    { role: "assistant", content: "📦 At 9 on Saturday.[[next]]Dana brings the van.", ts: "2026-10-30T09:00:05Z" },
  ]);
  assert.match(talk, /<section class="talk"><h2>Conversation<\/h2><ol><li class="you"><span class="who-said">You<span class="when">30 Oct<\/span><\/span><span class="bubble">📦 what time do the movers come\?<\/span><\/li><li class="ch"><span class="who-said">Closedhand<span class="when">30 Oct<\/span><\/span><span class="bubble">📦 At 9 on Saturday\.<br>Dana brings the van\.<\/span><\/li><\/ol><\/section>/);
  const withGoal = projectHtml(move(), now, [], { id: "g1", title: "Out by the 30th", shape: "milestone", status: "active", done_when: "keys handed back", target_date: "2026-11-30", why: "a fresh start", habit: { cue: "every evening", action: "pack two boxes", per_week: 5 }, this_week: 2,
    plan: [{ id: "s1", text: "Book the van", status: "done" }, { id: "s2", text: "Pay the deposit", status: "todo" }], check_in_text: "sundays at 19:00" });
  assert.match(withGoal, /<section class="goal"><h2>Goal<\/h2><div class="goal-card"><p class="goal-title">Out by the 30th<\/p><dl><dt>Done when<\/dt><dd>keys handed back, by 30 November 2026<\/dd>/);
  assert.match(withGoal, /<dt>Habit<\/dt><dd>Every evening, pack two boxes\. <span class="meter" role="img" aria-label="2 of 5 this week">(<i class="on"><\/i>){2}(<i class=""><\/i>){3}<\/span> 2 of 5 this week<\/dd>/);
  assert.match(withGoal, /<span class="steps-count">1 of 2 steps<\/span><span class="goal-bar"><span style="width:50%"><\/span><\/span>/);
  assert.match(withGoal, /<dt>Check-ins<\/dt><dd>Sundays at 19:00<\/dd>/);
  assert.match(projectHtml(wedding({ summary: "" })), /Nothing here yet\. Start a message with 💍 in any chat to begin its conversation\./);
  assert.match(projectHtml(wedding({ status: "archived", archived_at: "2026-10-20T00:00:00Z" })), /This project is archived\. Start a message with 💍 in any chat to bring it back\./);
  const tab = read("webapp/public/projects.js");
  assert.match(tab, /`Delete \$\{p\.emoji\} \$\{p\.name\}\? This deletes its goal, record, notes and conversation\. Its routines carry on without it, files and Context Notes stay in Context Brain, and nothing in your email or calendar is touched\.`/);
  assert.match(tab, /fetch\("\/emoji-list\.json"\)/);
  assert.match(tab, /field\("What it's about", about, "A sentence or two on what it is\.", true\),\n\s*field\("Instructions", instructions, "How Closedhand should handle anything in this project, one a line\.", true\)/, "only the name and emoji are needed");
});

test("a message sent with a project open in the web chat is in it, unless it starts with another project's emoji", async () => {
  const { projects } = loadProjects([move(), wedding()]);
  await projects.warm("u1");
  const open = await projects.fileTurn("u1", "what is left to do?", { projectId: "aaaa1111-move" });
  assert.equal(open.how, "open");
  assert.match(projects.getProjectsBlock("u1"), /THIS MESSAGE IS IN THE PROJECT 📦 House move \(it was sent with the project open\)/);
  assert.equal(projects.markReply("u1", "Two things.").text, "📦 Two things.");
  assert.equal((await projects.fileTurn("u1", "💍 and the venue?", { projectId: "aaaa1111-move" })).project.name, "Wedding", "an emoji says which project");
  assert.match(read("lib/engine.js"), /projects\.openTurn\(userId, userMessage, \{ projectId: opts\.project \|\| null \}\)/);
});

test("threads are gone: no commands for them in any chat app", () => {
  assert.doesNotMatch(read("lib/engine.js"), /CONVERSATION THREADING|\/threads/);
  for (const f of ["telegram", "slack-handler", "line", "discord", "whatsapp", "whatsapp-linked"]) {
    const src = read(`lib/platforms/${f}.js`);
    assert.doesNotMatch(src, /archiveThread|switchThread|getThreadList|pendingThreadSelect|"\/threads"|"\/new"/, f);
  }
  assert.match(read("lib/platforms/whatsapp-linked.js"), /"Start a message with a project's emoji to talk in that project", "\/bug  report a problem"\]/);
});

test("a routine can belong to a project: it runs with the project and reports in it", () => {
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /project: \{ type: "string", description: "The project it belongs to \(emoji, short id or name\), when it is for one\. A routine made in a project's conversation belongs to that project unless you say otherwise\./);
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /const turn = projects\.turnOf\(userId\);\n\s*if \(turn && turn\.how !== "offer"\) project = \(await projects\.warm\(userId\)\)\.find\(\(p\) => p\.id === turn\.id && p\.status === "active"\) \|\| null;/);
  assert.match(handlers, /\.\.\.\(project \? \{ project_id: project\.id \} : \{\}\),/);
  assert.match(read("lib/automations.js"), /THIS ROUTINE IS PART OF THE PROJECT \$\{p\.emoji\} \$\{p\.name\}\. Follow its instructions for anything in it; its record:\\n\$\{projects\.renderFull\(p, await projects\.fileTexts\(p\)/);
  const delivery = read("lib/task-delivery.js");
  assert.match(delivery, /const marked = project && message && !message\.trimStart\(\)\.startsWith\(project\.emoji\) \? `\$\{project\.emoji\} \$\{message\.trimStart\(\)\}` : message;/);
  assert.match(delivery, /if \(sentText && project\) await require\("\.\/projects"\)\.said\(row\.user_id, project, sentText\);\n\s*else if \(sentText\)/, "kept in the project's conversation, not the general one");
  assert.match(read("migrations/069_routines_in_projects.sql"), /ALTER TABLE automations ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects\(id\) ON DELETE SET NULL;/);
  const server = read("webapp/server.js");
  assert.match(server, /async function routineProject\(userId, id\) \{[\s\S]{0,300}\.eq\("status", "active"\)\.maybeSingle\(\);/);
  assert.match(server, /project_id: project,\n\s*\.\.\.watch\.fields,/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<select id="auto-project-select"[^>]*><option value="">None<\/option><\/select>/);
  assert.match(dash, /project_id: document\.getElementById\('auto-project-select'\)\.value \|\| null,/);
  const { projectHtml } = require("../webapp/projects");
  const html = projectHtml(move(), Date.parse("2026-11-01T12:00:00Z"), [], null, [{ name: "van-reminder", status: "active", trigger_type: "scheduled", trigger_human_schedule: "Every Friday at 9am" }]);
  assert.match(html, /<h2>Routines<span class="count">1<\/span><\/h2><ul class="routines"><li><span class="r-name">Van reminder<\/span><span class="r-when">Every Friday at 9am<\/span><\/li><\/ul>/);
});

// Delete is on every card, archived ones too, as on every page under Pages,
// and a deleted project goes with what hangs on it, leaving its name a month
// so Closedhand does not make it again at once.
test("a project is deleted from its card, and its name alone is kept a month", async () => {
  const ui = read("webapp/public/projects.js");
  assert.match(ui, /btn\("goal-small goal-quiet", p\.status === "archived" \? "Bring back" : "Archive",[\s\S]{0,300}\}\),\n\s*deleteButton\(p\)\);/);
  assert.doesNotMatch(ui.slice(ui.indexOf("function moreActions"), ui.indexOf("function deleteButton")), /DELETE/, "not tucked inside Edit any more");
  assert.match(read("webapp/projects.js"), /const \{ error \} = await rules\.deleteProject\(db, userId, req\.params\.id\);/);
  const calls = [];
  const db = { from: () => {
    const q = { op: null, select() { return q; }, eq() { return q; }, single: async () => ({ data: { name: "Gym plan" } }),
      delete() { q.op = "delete"; return q; }, insert: async (row) => { calls.push(["insert", row]); return { error: null }; },
      then(resolve) { calls.push([q.op]); resolve({ error: null }); } };
    return q;
  } };
  const rules = require("../lib/project-rules");
  assert.deepEqual(await rules.deleteProject(db, "u1", "zz"), {});
  assert.equal(calls[0][0], "delete", "the row goes first, and its goal and conversation with it");
  assert.deepEqual({ ...calls[1][1], last_touched: "x" }, { user_id: "u1", name: "Gym plan", status: "declined", last_touched: "x" });
});
