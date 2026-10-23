// A project's goal, on its card in the Projects tab (webapp/public/
// projects.js): what matters at a glance (the finish line, the habit that
// gets there and this week's count, the next step and progress, the
// check-in), opening to the rest: why it matters, the if-then plan, the
// reward, the steps, the check-in time and the progress feed. Edits here and
// in chat change the same goal (lib/goals.js). A project card leaves a slot
// (data-goal-for, its project's id) and this fills it; a goal is added in the
// project's own form, as one of its optional parts.
(() => {
  const byId = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const DAY = ["S", "M", "T", "W", "T", "F", "S"];
  const DAYNAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let state = { goals: [], open: new Set(), weekStart: null, timezone: null };

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }
  // A date as the database gives it ("2027-03-01" or a full timestamp).
  const dayOf = (v) => String(v || "").slice(0, 10);
  function shortDate(iso) {
    iso = String(iso);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T12:00:00" : iso);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  async function load() {
    try {
      const data = await api("/api/goals");
      state.goals = data.goals; state.weekStart = data.week_start; state.timezone = data.timezone;
      state.assistant = data.assistant_name || "Closedhand";
      render();
    } catch (e) { const err = byId("projects-error"); if (err) { err.textContent = e.message; err.hidden = false; } }
  }

  const longDate = (v) => new Date(dayOf(v) + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

  // The habit: what and when, this week as seven dots, and today's tick.
  function habitRow(g) {
    const per = g.habit.per_week || 7;
    const weekday = new Intl.DateTimeFormat("en-CA", { timeZone: state.timezone, weekday: "short" });
    const days = new Set((g.this_week || []).map((at) => weekday.format(new Date(at))));
    const box = el("div");
    const what = [g.habit.cue, g.habit.action].filter(Boolean).join(", ");
    if (what) box.append(el("span", "", what.charAt(0).toUpperCase() + what.slice(1)));
    const wrap = el("div", "goal-progress");
    const dots = el("div", "goal-week"); dots.setAttribute("aria-hidden", "true");
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d) => { const dot = el("span", "goal-dot" + (days.has(d) ? " done" : "")); dot.title = d; dots.append(dot); });
    wrap.append(dots, el("span", "goal-count", `${days.size} of ${per} this week`));
    if (g.status === "active") {
      const today = weekday.format(new Date());
      const btn = el("button", "goal-today" + (days.has(today) ? " done" : ""), days.has(today) ? "Done today" : "Mark today done");
      btn.type = "button"; btn.disabled = days.has(today);
      btn.onclick = async () => { btn.disabled = true; try { await api(`/api/goals/${g.id}/habit`, { method: "POST" }); await load(); } catch (e) { btn.disabled = false; alertIn(g.id, e.message); } };
      wrap.append(btn);
    }
    box.append(wrap);
    return box;
  }

  // The next step and how much of the plan is done.
  function planRow(g) {
    const plan = g.plan;
    const next = plan.find((s) => s.status === "todo");
    const done = plan.filter((s) => s.status !== "todo").length;
    const box = el("div");
    box.append(el("span", "", next ? next.text + (next.due ? `, ${shortDate(next.due)}` : "") : "Every step done"));
    const wrap = el("div", "goal-progress");
    const bar = el("div", "goal-bar"); bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(plan.length)); bar.setAttribute("aria-valuenow", String(done));
    const fill = el("span", "goal-fill"); fill.style.width = `${Math.round((done / plan.length) * 100)}%`; bar.append(fill);
    wrap.append(bar, el("span", "goal-count", `${done} of ${plan.length} steps`));
    box.append(wrap);
    return box;
  }

  // The finish line, the habit that gets there and the next step, labelled
  // like the facts inside, so the card reads top to bottom.
  function summary(g) {
    const rows = [];
    if (g.done_when) rows.push(["Done when", el("span", "", g.done_when + (g.target_date ? `, by ${longDate(g.target_date)}` : ""))]);
    if (g.status !== "achieved") {
      if (g.habit) rows.push(["Habit", habitRow(g)]);
      if ((g.plan || []).length) rows.push(["Next", planRow(g)]);
      else if (g.stage) rows.push(["Now", el("span", "", g.stage)]);
    }
    if (!rows.length) return null;
    const grid = el("dl", "goal-summary");
    rows.forEach(([label, value]) => { const dd = el("dd"); dd.append(value); grid.append(el("dt", "", label), dd); });
    return grid;
  }

  function card(g) {
    const open = state.open.has(g.id);
    const c = el("article", "goal-card" + (g.status !== "active" ? " " + g.status : "") + (open ? " open" : ""));
    c.dataset.id = g.id;
    const head = el("button", "goal-head"); head.type = "button"; head.setAttribute("aria-expanded", String(open));
    const title = el("span", "goal-title", g.title);
    head.append(el("span", "goal-label", "Goal"), title);
    if (g.status === "paused") head.append(el("span", "goal-tag", "Paused"));
    if (g.status === "achieved") head.append(el("span", "goal-by", g.achieved_at ? "achieved " + shortDate(g.achieved_at) : "achieved"));
    head.append(el("span", "chevron-down"));
    c.append(head);
    // Anywhere on the card opens or closes it, except its own controls and
    // the opened part, which has controls of its own.
    c.onclick = (ev) => {
      const hit = ev.target.closest("button, input, a, form, .goal-detail");
      if (hit && hit !== head) return;
      if (hit !== head && String(window.getSelection && window.getSelection()).trim()) return;
      if (state.open.has(g.id)) state.open.delete(g.id); else state.open.add(g.id);
      render();
    };
    const sum = g.status === "achieved" && !open ? null : summary(g);
    if (sum) c.append(sum);
    if (g.check_in_text && g.status === "active") c.append(el("p", "goal-checkin", "Check-in: " + g.check_in_text));
    if (g.status !== "achieved" && !g.why && !g.if_then) {
      const plan = el("button", "goal-plan-chat", `Plan it with ${state.assistant || "Closedhand"}`); plan.type = "button";
      plan.onclick = () => askInChat(`${emojiOf(g.project_id)} Help me set up my ${g.shape === "habit" ? "habit" : "goal"}: ${g.title}`.trim());
      c.append(plan);
    }
    if (open) c.append(detail(g));
    const note = el("p", "goal-alert"); note.setAttribute("role", "status"); note.hidden = true; c.append(note);
    return c;
  }

  function detail(g) {
    const d = el("div", "goal-detail");
    const facts = el("dl", "goal-facts");
    for (const [k, label] of [["why", "Why"], ["obstacle", "In the way"], ["if_then", "If-then"], ["reward", "Reward"]]) {
      if (!g[k]) continue;
      facts.append(el("dt", "", label), el("dd", "", g[k]));
    }
    if (g.target_date && !g.done_when) facts.append(el("dt", "", "By"), el("dd", "", longDate(g.target_date)));
    if (facts.children.length) d.append(facts);

    const live = g.status !== "achieved";
    if (g.shape !== "habit" && (live || (g.plan || []).length)) {
      d.append(el("h4", "goal-sub", "Plan"));
      const list = el("ul", "goal-steps");
      (g.plan || []).forEach((s) => {
        const li = el("li", "goal-step " + s.status);
        const tick = el("button", "goal-tick"); tick.type = "button"; tick.disabled = !live;
        tick.setAttribute("aria-label", (s.status === "done" ? "Mark not done: " : "Mark done: ") + s.text);
        tick.setAttribute("aria-pressed", String(s.status === "done"));
        tick.onclick = async () => {
          li.classList.add("ticking");
          try { await api(`/api/goals/${g.id}/steps/${s.id}`, { method: "PATCH", body: JSON.stringify({ status: s.status === "done" ? "todo" : "done" }) }); await load(); }
          catch (e) { li.classList.remove("ticking"); alertIn(g.id, e.message); }
        };
        const body = el("span", "goal-step-body");
        body.append(el("span", "goal-step-text", s.text), el("span", "goal-step-meta", (s.owner === "closedhand" ? state.assistant || "Closedhand" : "You") + (s.due ? " · " + shortDate(s.due) : "")));
        li.append(tick, body);
        list.append(li);
      });
      d.append(list);
    }
    if (g.shape !== "habit" && live) {
      const add = el("form", "goal-add");
      const input = el("input"); input.placeholder = "Add a step"; input.maxLength = 200; input.setAttribute("aria-label", "Add a step");
      const go = el("button", "goal-small", "Add"); go.type = "submit";
      add.append(input, go);
      add.onsubmit = async (ev) => { ev.preventDefault(); if (!input.value.trim()) return; go.disabled = true; try { await api(`/api/goals/${g.id}/steps`, { method: "POST", body: JSON.stringify({ text: input.value }) }); await load(); } catch (e) { go.disabled = false; alertIn(g.id, e.message); } };
      d.append(add);
    }

    if (live) {
      d.append(el("h4", "goal-sub", "Check-ins"));
      d.append(checkInEditor(g));
    }

    const hist = el("div", "goal-history");
    hist.append(el("h4", "goal-sub", "Progress feed"));
    const ul = el("ul", "goal-events"); ul.append(el("li", "goal-event muted", "Loading…"));
    hist.append(ul); d.append(hist);
    api(`/api/goals/${g.id}/events`).then((events) => {
      ul.replaceChildren();
      if (!events.length) ul.append(el("li", "goal-event muted", "Steps, check-ins and changes to the plan show here."));
      events.slice(0, 20).forEach((e) => {
        const li = el("li", "goal-event " + e.kind);
        li.append(el("time", "", shortDate(e.at)), el("span", "", e.text));
        ul.append(li);
      });
    }).catch(() => { ul.replaceChildren(el("li", "goal-event muted", "Could not load this.")); });

    const actions = el("div", "goal-actions");
    const act = (label, cls, fn) => { const b = el("button", "goal-small " + cls, label); b.type = "button"; b.onclick = fn; actions.append(b); return b; };
    if (g.status === "active") act("Pause", "", () => setStatus(g, "paused"));
    if (g.status === "paused") act("Pick it up again", "", () => setStatus(g, "active"));
    if (g.status !== "achieved") act("Mark achieved", "goal-win", () => setStatus(g, "achieved"));
    else act("Not achieved yet", "", () => setStatus(g, "active"));
    const remove = act("Remove", "goal-remove", async () => {
      if (remove.dataset.confirm !== "1") { remove.dataset.confirm = "1"; remove.textContent = "Remove for good?"; return; }
      try { await api(`/api/goals/${g.id}`, { method: "DELETE" }); state.open.delete(g.id); await load(); if (window.loadProjects) window.loadProjects(); } catch (e) { alertIn(g.id, e.message); }
    });
    d.append(actions);
    return d;
  }

  function checkInEditor(g) {
    const box = el("div", "goal-checkin-edit");
    const c = g.check_in || { days: [], time: "19:00" };
    const chosen = new Set(c.days || []);
    const days = el("div", "goal-days");
    [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
      const b = el("button", "goal-day" + (chosen.has(d) ? " on" : ""), DAY[d]); b.type = "button";
      b.setAttribute("aria-pressed", String(chosen.has(d))); b.setAttribute("aria-label", DAYNAME[d]);
      b.onclick = () => { if (chosen.has(d)) chosen.delete(d); else chosen.add(d); b.classList.toggle("on"); b.setAttribute("aria-pressed", String(chosen.has(d))); };
      days.append(b);
    });
    const time = el("input", "goal-time"); time.type = "time"; time.value = c.time || "19:00"; time.setAttribute("aria-label", "Check-in time");
    const save = el("button", "goal-small", "Save"); save.type = "button";
    save.onclick = async () => {
      try { await api(`/api/goals/${g.id}`, { method: "PATCH", body: JSON.stringify({ check_in: chosen.size ? { days: [...chosen], time: time.value } : null }) }); await load(); }
      catch (e) { alertIn(g.id, e.message); }
    };
    box.append(days, time, save);
    if (g.check_in) {
      const off = el("button", "goal-small goal-quiet", "Turn off"); off.type = "button";
      off.onclick = async () => { try { await api(`/api/goals/${g.id}`, { method: "PATCH", body: JSON.stringify({ check_in: null }) }); await load(); } catch (e) { alertIn(g.id, e.message); } };
      box.append(off);
    }
    return box;
  }

  async function setStatus(g, status) {
    try {
      await api(`/api/goals/${g.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      if (status === "achieved") { state.open.delete(g.id); celebrate(g.title); }
      await load();
    } catch (e) { alertIn(g.id, e.message); }
  }

  // One warm line, not confetti.
  function celebrate(title) {
    const note = byId("goals-cheer");
    note.textContent = `Achieved: ${title}. Well done.`;
    note.hidden = false; note.classList.remove("show"); void note.offsetWidth; note.classList.add("show");
    setTimeout(() => { note.hidden = true; }, 6000);
  }

  function alertIn(id, msg) {
    const card = document.querySelector(`.goal-card[data-id="${id}"] .goal-alert`);
    if (card) { card.textContent = msg; card.hidden = false; }
  }

  // The goal goes to the web chat's box, ready to send; nothing is sent here.
  function askInChat(text) {
    if (window.parent !== window) window.parent.postMessage({ type: "chat-prefill", text }, location.origin);
  }

  // The project's emoji, so a goal planned in chat lands in its project.
  function emojiOf(projectId) {
    const slot = document.querySelector(`[data-goal-for="${projectId}"]`);
    return slot ? slot.dataset.goalEmoji || "" : "";
  }

  // Every project card's goal slot, filled with its goal, if it has one.
  function render() {
    document.querySelectorAll("[data-goal-for]").forEach((slot) => {
      const g = state.goals.find((x) => x.project_id === slot.dataset.goalFor);
      slot.replaceChildren(...(g ? [card(g)] : []));
    });
  }

  // A goal's fields, inside the project form (projects.js): what to achieve,
  // and a finish line or a habit. value() is what to save, or null when no
  // goal was written.
  function fields() {
    const box = el("div"); box.id = "goal-new";
    const title = el("input"); title.type = "text"; title.maxLength = 160; title.placeholder = "What do you want to achieve?"; title.setAttribute("aria-label", "Goal"); title.autocomplete = "off";
    const shapes = el("div", "goal-shapes"); shapes.setAttribute("role", "radiogroup"); shapes.setAttribute("aria-label", "Kind of goal");
    const radio = (value, text, checked) => { const l = el("label"); const r = el("input"); r.type = "radio"; r.name = "goal-shape"; r.value = value; r.checked = checked; l.append(r, " " + text); return [l, r]; };
    const [ml, mr] = radio("milestone", "A finish line to reach", true), [hl, hr] = radio("habit", "An ongoing habit", false);
    shapes.append(ml, hl);
    const milestone = el("div", "goal-new-more");
    const doneLabel = el("label", "goal-new-wide", "Done when "); const done = el("input"); done.type = "text"; done.maxLength = 400; done.placeholder = "e.g. I run 5k in under 30 minutes"; done.autocomplete = "off"; doneLabel.append(done);
    const byLabel = el("label", "", "By "); const by = el("input", "goal-time"); by.type = "date"; byLabel.append(by);
    milestone.append(doneLabel, byLabel);
    const habit = el("div", "goal-new-more"); habit.hidden = true;
    const perLabel = el("label"); const per = el("input", "goal-time"); per.type = "number"; per.min = "1"; per.max = "7"; per.value = "3"; per.setAttribute("aria-label", "Times a week"); perLabel.append(per, " times a week");
    const cueLabel = el("label", "goal-new-wide", "When "); const cue = el("input"); cue.type = "text"; cue.maxLength = 160; cue.placeholder = "e.g. after work"; cue.autocomplete = "off"; cueLabel.append(cue);
    habit.append(perLabel, cueLabel);
    for (const r of [mr, hr]) r.onchange = () => { const h = hr.checked; habit.hidden = !h; milestone.hidden = h; title.placeholder = h ? "What do you want to do regularly?" : "What do you want to achieve?"; };
    box.append(title, shapes, milestone, habit);
    return {
      box,
      focus: () => title.focus(),
      value() {
        if (!title.value.trim()) return null;
        const shape = hr.checked ? "habit" : "milestone";
        const more = shape === "habit" ? { habit: { cue: cue.value.trim(), per_week: Number(per.value) || 3 } } : { done_when: done.value.trim(), target_date: by.value || null };
        return { title: title.value.trim(), shape, ...more };
      },
    };
  }

  // Saved with its project, once the project is.
  async function add(projectId, goal) {
    const g = await api("/api/goals", { method: "POST", body: JSON.stringify({ project_id: projectId, ...goal }) });
    state.open.add(g.id);
  }

  window.goalCards = { load, render, fields, add, has: (projectId) => state.goals.some((g) => g.project_id === projectId) };
  // Another part of the dashboard (a check-in under Upcoming) opens a goal.
  window.openGoal = async (id) => {
    state.open.add(id);
    if (typeof window.switchTab === "function") window.switchTab("projects");
    await load();
    const card = document.querySelector(`.goal-card[data-id="${id}"]`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  };
})();
