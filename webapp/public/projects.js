// The Projects tab: each project as a card (its emoji and name, where it
// stands, when it last moved, its goal if it has one), with its page, an edit
// form and archiving. The goal is drawn by goals.js into the card's slot,
// and added in the form, as an optional part like instructions or context.
// The form starts one too: a name, any emoji, what it is about, and its
// context (files, notes, links, and emails, events or messages from connected
// apps). Context changes are kept in the form until Save, so Cancel undoes
// them. Chat changes the same projects (lib/projects.js); this tab is for
// control, and reading is done on each project's page.
(() => {
  const byId = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const btn = (cls, text, onclick) => { const b = el("button", cls, text); b.type = "button"; if (onclick) b.onclick = onclick; return b; };
  const KIND = { file: "File", note: "Note", link: "Link", email: "Email", event: "Event", message: "Message", page: "Page" };
  const markKey = (e) => String(e || "").replace(/[︎️\u{1F3FB}-\u{1F3FF}]/gu, "");
  let state = { projects: [], editing: null, archivedOpen: false };

  async function api(path, opts = {}) {
    const json = !(opts.body instanceof FormData);
    const res = await fetch(path, { ...opts, headers: json ? { "Content-Type": "application/json", ...(opts.headers || {}) } : opts.headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }
  const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  function showError(msg) { const e = byId("projects-error"); e.textContent = msg || ""; e.hidden = !msg; }

  async function load() {
    try {
      const [projects] = await Promise.all([api("/api/projects"), window.goalCards ? window.goalCards.load() : null]);
      state.projects = projects.projects; showError(""); render();
    } catch (e) { showError(e.message); }
  }

  // ---- Any emoji: Unicode's whole set, searchable, loaded on first open ----
  let emojiList = null;
  async function emojis() {
    if (!emojiList) emojiList = fetch("/emoji-list.json").then((r) => r.json()).then((d) => d.groups);
    return emojiList;
  }
  function picker(current, taken, onPick) {
    const box = el("div", "emoji-picker");
    const search = el("input", "emoji-search"); search.type = "search"; search.placeholder = "Search emoji"; search.setAttribute("aria-label", "Search emoji");
    const tabs = el("div", "emoji-tabs"); tabs.setAttribute("role", "tablist");
    const grid = el("div", "emoji-grid");
    box.append(search, tabs, grid);
    let groups = [], group = 0;
    const cell = ([e, words]) => {
      const name = words.split("|")[0];
      const owner = taken.get(markKey(e));
      const b = btn("emoji-cell" + (markKey(e) === markKey(current) ? " on" : ""), e);
      b.title = owner ? `${name}: already marks ${owner}` : name;
      b.setAttribute("aria-label", b.title);
      if (owner) b.disabled = true;
      else b.onclick = () => onPick(e);
      return b;
    };
    const show = () => {
      grid.textContent = "";
      const q = search.value.trim().toLowerCase();
      const list = q ? groups.flatMap((g) => g[1]).filter(([, w]) => w.toLowerCase().includes(q)).slice(0, 160) : (groups[group] || [null, []])[1];
      if (!list.length) grid.append(el("p", "emoji-none", "No emoji by that name."));
      for (const x of list) grid.append(cell(x));
      tabs.querySelectorAll("button").forEach((t, i) => t.classList.toggle("on", !q && i === group));
    };
    emojis().then((g) => {
      groups = g;
      g.forEach(([label, list], i) => {
        const t = btn("emoji-tab", list[0][0], () => { group = i; search.value = ""; show(); });
        t.title = label; t.setAttribute("aria-label", label); t.setAttribute("role", "tab");
        tabs.append(t);
      });
      show();
    }).catch(() => grid.append(el("p", "emoji-none", "The emoji list did not load. Type or paste an emoji instead.")));
    search.oninput = show;
    return box;
  }

  // ---- The form, for a new project or for changing one ----
  function field(label, control, hint, optional) {
    const f = el("label", "project-field");
    const name = el("span", "project-label", label);
    if (optional) name.append(el("span", "project-optional", "Optional"));
    f.append(name, control);
    if (hint) f.append(el("span", "project-hint", hint));
    return f;
  }

  function form(p) {
    const f = el("form", "project-form");
    const name = el("input"); name.type = "text"; name.maxLength = 80; name.placeholder = "e.g. House move, or Acme website"; name.value = p ? p.name : "";

    // Emoji: typed or pasted, or chosen from the picker.
    const emojiWrap = el("div", "project-field");
    emojiWrap.append(el("span", "project-label", "Emoji"));
    const emojiRow = el("div", "project-emoji-row");
    const emoji = el("input", "project-emoji"); emoji.type = "text"; emoji.maxLength = 16; emoji.setAttribute("aria-label", "Emoji"); emoji.value = p ? p.emoji : "";
    const taken = new Map(state.projects.filter((x) => x.status === "active" && (!p || x.id !== p.id)).map((x) => [markKey(x.emoji), x.name]));
    let pick = null;
    const choose = btn("goal-small", "Choose an emoji", () => {
      if (pick) { pick.remove(); pick = null; choose.textContent = "Choose an emoji"; return; }
      pick = picker(emoji.value, taken, (e) => { emoji.value = e; pick.remove(); pick = null; choose.textContent = "Choose an emoji"; });
      emojiWrap.append(pick); choose.textContent = "Close";
      pick.querySelector("input").focus();
    });
    emojiRow.append(emoji, choose, el("span", "project-hint", "It marks the project in every chat."));
    emojiWrap.append(emojiRow);

    const about = el("textarea"); about.rows = 2; about.maxLength = 600; about.placeholder = "e.g. Moving from our flat in Leeds to a house in York in March"; about.value = p ? p.about || "" : "";
    const instructions = el("textarea"); instructions.rows = 3; instructions.maxLength = 4000; instructions.placeholder = "e.g. Always use the Leeds address on forms until the move"; instructions.value = p ? p.instructions || "" : "";

    // Context: what it has now, what is being added, what is being taken out.
    const have = p ? [...(p.context || [])] : [];
    const adding = [], files = [], items = [];
    const removing = new Set();
    const list = el("div", "project-context");
    const drawList = () => {
      list.textContent = "";
      const rows = [...have.filter((c) => !removing.has(c.id)), ...adding, ...items, ...files.map((x) => ({ kind: "file", title: x.name, pending: x }))];
      if (!rows.length) list.append(el("p", "project-hint", "Nothing yet. Add what Closedhand should know or have to hand for it."));
      for (const c of rows) {
        const row = el("div", "context-row");
        row.append(el("span", "context-kind", KIND[c.kind] || "Item"), el("span", "context-title", c.title || c.url || ""));
        row.append(btn("goal-small goal-quiet", "Remove", () => {
          if (c.pending) files.splice(files.indexOf(c.pending), 1);
          else if (adding.includes(c)) adding.splice(adding.indexOf(c), 1);
          else if (items.includes(c)) items.splice(items.indexOf(c), 1);
          else removing.add(c.id);
          drawList();
        }));
        list.append(row);
      }
    };
    drawList();

    const adder = el("div", "context-adder");
    const actions = el("div", "context-actions");
    const fileInput = el("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.hidden = true;
    fileInput.onchange = () => { files.push(...fileInput.files); fileInput.value = ""; drawList(); };
    const filesBtn = el("label", "goal-small", "Add files"); filesBtn.append(fileInput);
    const open = (build) => { adder.textContent = ""; adder.append(build()); const first = adder.querySelector("input, textarea"); if (first) first.focus(); };
    const close = () => { adder.textContent = ""; };
    actions.append(filesBtn,
      btn("goal-small", "Write a note", () => open(() => {
        const box = el("div", "context-box");
        const t = el("input"); t.type = "text"; t.placeholder = "Title (optional)"; t.maxLength = 120;
        const body = el("textarea"); body.rows = 5; body.placeholder = "Anything Closedhand should know: a brief, details, pasted text";
        box.append(t, body, el("div", "goal-new-actions", ""));
        box.lastChild.append(btn("goal-small", "Add note", () => { if (!body.value.trim()) return; adding.push({ kind: "note", title: t.value.trim() || body.value.trim().split("\n")[0].slice(0, 80), text: body.value }); close(); drawList(); }), btn("goal-small goal-quiet", "Cancel", close));
        return box;
      })),
      btn("goal-small", "Add a link", () => open(() => {
        const box = el("div", "context-box");
        const u = el("input"); u.type = "url"; u.placeholder = "https://";
        const t = el("input"); t.type = "text"; t.placeholder = "What it is (optional)"; t.maxLength = 120;
        box.append(u, t, el("div", "goal-new-actions", ""));
        box.lastChild.append(btn("goal-small", "Add link", () => {
          if (!/^https?:\/\/\S+$/i.test(u.value.trim())) { u.setCustomValidity("Enter a web address starting with https://"); u.reportValidity(); return; }
          adding.push({ kind: "link", url: u.value.trim(), title: t.value.trim() }); close(); drawList();
        }), btn("goal-small goal-quiet", "Cancel", close));
        u.oninput = () => u.setCustomValidity("");
        return box;
      })),
      btn("goal-small", "From your apps", () => open(() => {
        const box = el("div", "context-box");
        const q = el("input"); q.type = "search"; q.placeholder = "Search your email, calendar and chats";
        const results = el("div", "context-results");
        let timer = null, seq = 0;
        q.oninput = () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const mine = ++seq;
            if (q.value.trim().length < 2) { results.textContent = ""; return; }
            try {
              const found = (await api("/api/projects/find?q=" + encodeURIComponent(q.value.trim()))).items;
              if (mine !== seq) return;
              results.textContent = "";
              if (!found.length) results.append(el("p", "project-hint", "Nothing synced matches that."));
              for (const it of found) {
                const already = have.some((c) => c.id === it.id && !removing.has(c.id)) || items.some((c) => c.id === it.id);
                const row = el("div", "context-row");
                const meta = [KIND[it.kind] || "Item", it.from, it.at ? shortDate(it.at) : ""].filter(Boolean).join(" · ");
                const text = el("span", "context-title"); text.append(el("span", "", it.title), el("span", "context-meta", meta));
                const add = btn("goal-small", already ? "Added" : "Add", () => { items.push(it); add.textContent = "Added"; add.disabled = true; drawList(); });
                add.disabled = already;
                row.append(el("span", "context-kind", KIND[it.kind] || "Item"), text, add);
                results.append(row);
              }
            } catch (e) { results.textContent = ""; results.append(el("p", "project-hint", e.message)); }
          }, 250);
        };
        box.append(q, results, el("div", "goal-new-actions", ""));
        box.lastChild.append(btn("goal-small goal-quiet", "Done", close));
        return box;
      })));

    const contextWrap = el("div", "project-field");
    const contextLabel = el("span", "project-label", "Context"); contextLabel.append(el("span", "project-optional", "Optional"));
    contextWrap.append(contextLabel, el("span", "project-hint", "Files, notes, links, and emails or events Closedhand keeps with this project and works from."), list, actions, adder);

    f.append(field("Name", name), emojiWrap, field("What it's about", about, "A sentence or two on what it is.", true),
      field("Instructions", instructions, "How Closedhand should handle anything in this project, one a line.", true), contextWrap);

    // A goal, for a project that is one: optional, and shut until asked for.
    let goal = null;
    if (window.goalCards && !(p && window.goalCards.has(p.id))) {
      const goalWrap = el("div", "project-field");
      const goalLabel = el("span", "project-label", "Goal"); goalLabel.append(el("span", "project-optional", "Optional"));
      const open = btn("goal-small", "Add a goal", () => { goal = window.goalCards.fields(); open.replaceWith(goal.box); goal.focus(); });
      goalWrap.append(goalLabel, el("span", "project-hint", "For something you want to achieve or keep doing. Closedhand checks in on it and keeps count."), open);
      f.append(goalWrap);
    }

    const buttons = el("div", "goal-new-actions");
    const save = el("button", "", p ? "Save" : "Start project"); save.type = "submit";
    buttons.append(save, btn("goal-small goal-quiet", "Cancel", () => { state.editing = null; if (!p) openNew(false); else render(); }));
    f.append(buttons);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      save.disabled = true;
      try {
        const typed = adding.map((c) => (c.kind === "note" ? { kind: "note", title: c.title, text: c.text } : { kind: "link", url: c.url, title: c.title }));
        const refs = items.map((c) => ({ source: c.source, ref: c.ref }));
        let saved;
        if (p) {
          saved = (await api(`/api/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ name: name.value, emoji: emoji.value, about: about.value, instructions: instructions.value, add_context: typed, add_items: refs }) })).project;
          for (const id of removing) saved = (await api(`/api/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ remove_context: id }) })).project;
        } else {
          saved = (await api("/api/projects", { method: "POST", body: JSON.stringify({ name: name.value, emoji: emoji.value, about: about.value, instructions: instructions.value, context: typed, items: refs }) })).project;
        }
        const wanted = goal && goal.value();
        if (wanted) await window.goalCards.add(saved.id, wanted);
        if (files.length) {
          const fd = new FormData();
          for (const file of files) fd.append("files", file);
          const up = await api(`/api/projects/${saved.id}/files`, { method: "POST", body: fd });
          if (up.refused && up.refused.length) showError(`Closedhand doesn't open ${up.refused.join(", ")}, so ${up.refused.length === 1 ? "it was" : "they were"} left out.`);
        }
        state.editing = null;
        if (!p) openNew(false);
        await load();
      } catch (e) { showError(e.message); save.disabled = false; }
    };
    if (p) f.append(moreActions(p));
    return f;
  }

  // Merging, inside the edit form: rare, and final.
  function moreActions(p) {
    const box = el("div", "project-more");
    const others = state.projects.filter((x) => x.id !== p.id);
    if (others.length) {
      const row = el("div", "project-merge");
      const pick = el("select"); pick.setAttribute("aria-label", "Project to merge into this one");
      pick.append(new Option("Merge another project into this one…", ""));
      for (const o of others) pick.append(new Option(`${o.emoji} ${o.name}`, o.id));
      row.append(pick, btn("goal-small", "Merge", async () => {
        if (!pick.value) return;
        try { await api(`/api/projects/${p.id}/merge`, { method: "POST", body: JSON.stringify({ from: pick.value }) }); state.editing = null; await load(); } catch (e) { showError(e.message); }
      }));
      box.append(row);
    }
    return box;
  }

  // Delete, on every card as on every page under Pages, archived ones too,
  // and asked about first: it is final.
  function deleteButton(p) {
    const del = btn("goal-small goal-quiet project-delete", "Delete", () => {
      const ask = el("div", "project-confirm");
      ask.append(el("span", "", `Delete ${p.emoji} ${p.name}? This deletes its goal, record, notes and conversation. Its routines carry on without it, files and Context Notes stay in Context Brain, and nothing in your email or calendar is touched.`));
      ask.append(
        btn("goal-small", "Delete", async () => { try { await api(`/api/projects/${p.id}`, { method: "DELETE" }); state.editing = null; await load(); } catch (e) { showError(e.message); } }),
        btn("goal-small goal-quiet", "Keep it", () => ask.replaceWith(del)));
      del.replaceWith(ask);
    });
    return del;
  }

  function card(p) {
    if (state.editing === p.id) { const wrap = el("div", "goal-card project-card editing"); wrap.append(form(p)); return wrap; }
    const c = el("div", "goal-card project-card" + (p.status === "archived" ? " archived" : ""));
    const head = el("div", "project-head");
    head.append(el("span", "project-mark", p.emoji), el("span", "project-name", p.name));
    const when = p.status === "archived" && p.archived_at ? `archived ${shortDate(p.archived_at)}` : `updated ${shortDate(p.last_touched)}`;
    head.append(el("span", "project-when", when + (p.expected_end ? ` · until ${shortDate(p.expected_end)}` : "")));
    c.append(head);
    if (p.summary) c.append(el("p", "project-summary", p.summary));
    const goal = el("div", "project-goal"); goal.dataset.goalFor = p.id; goal.dataset.goalEmoji = p.emoji;
    c.append(goal);
    const acts = el("div", "project-actions");
    const openPage = el("a", "goal-small", "Open page"); openPage.href = `/page/project/${p.id}`;
    acts.append(openPage,
      btn("goal-small", "Edit", () => { state.editing = p.id; render(); }),
      btn("goal-small goal-quiet", p.status === "archived" ? "Bring back" : "Archive", async () => {
        try { await api(`/api/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ archived: p.status !== "archived" }) }); await load(); } catch (e) { showError(e.message); }
      }),
      deleteButton(p));
    c.append(acts);
    return c;
  }

  function render() {
    const list = byId("projects-list"); list.textContent = "";
    const active = state.projects.filter((p) => p.status === "active");
    const archived = state.projects.filter((p) => p.status === "archived");
    if (!active.length && byId("project-new").hidden) {
      list.append(el("p", "goal-empty", "No projects yet."));
    }
    for (const p of active) list.append(card(p));
    const old = byId("projects-archived"); old.textContent = "";
    if (archived.length) {
      old.append(btn("goal-small goal-quiet project-archived-toggle", `${state.archivedOpen ? "Hide" : "Show"} archived (${archived.length})`, () => { state.archivedOpen = !state.archivedOpen; render(); }));
      if (state.archivedOpen) for (const p of archived) old.append(card(p));
    }
    if (window.goalCards) window.goalCards.render();
  }

  function openNew(show) {
    byId("project-new-toggle").hidden = show;
    const next = show ? form(null) : el("form", "project-form");
    next.id = "project-new"; next.hidden = !show;
    byId("project-new").replaceWith(next);
    if (show) next.querySelector("input").focus();
    render();
  }

  window.loadProjects = load;
  document.addEventListener("DOMContentLoaded", () => {
    byId("project-new-toggle").onclick = () => openNew(true);
    // A link straight to #projects opens the tab before this deferred script
    // has run, so the tab's own load found nothing to call and the list
    // stayed empty until another tab was clicked.
    if (byId("tab-projects")?.classList.contains("active")) load();
  });
})();
