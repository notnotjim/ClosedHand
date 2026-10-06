// The Goals tab: each goal as a card showing what matters at a glance (the
// finish line, the habit that gets there and this week's count, the next
// step and progress, the check-in), opening to the rest: why it matters, the
// if-then plan, the reward, the steps, the check-in time and the progress feed. Edits here and in chat change the same goal (lib/goals.js).
(() => {
  const byId = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const DAY = ["S", "M", "T", "W", "T", "F", "S"];
  const DAYNAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let state = { goals: [], open: new Set(), achieved: null, achievedOpen: false, weekStart: null, timezone: null };

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
      state.achievedCount = data.achieved_count; state.assistant = data.assistant_name || "ClosedHand";
      if (state.achievedOpen) state.achieved = (await api("/api/goals?status=achieved")).goals;
      byId("goals-error").hidden = true;
      render();
    } catch (e) { byId("goals-error").textContent = e.message; byId("goals-error").hidden = false; }
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
    head.append(title);
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
      const plan = el("button", "goal-plan-chat", `Plan it with ${state.assistant || "ClosedHand"}`); plan.type = "button";
      plan.onclick = () => askInChat(`Help me set up my ${g.shape === "habit" ? "habit" : "goal"}: ${g.title}`);
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
        body.append(el("span", "goal-step-text", s.text), el("span", "goal-step-meta", (s.owner === "closedhand" ? state.assistant || "ClosedHand" : "You") + (s.due ? " · " + shortDate(s.due) : "")));
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
      try { await api(`/api/goals/${g.id}`, { method: "DELETE" }); state.open.delete(g.id); await load(); } catch (e) { alertIn(g.id, e.message); }
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

  function render() {
    const list = byId("goals-list"); list.replaceChildren();
    if (!state.goals.length) {
      const empty = el("div", "goal-empty");
      // The intro above already says how to add one; this shows what one looks like.
      empty.append(el("p", "", "No goals yet. One might be “Run a 10k by spring” or “Read for 20 minutes a day”."));
      list.append(empty);
    }
    state.goals.forEach((g) => list.append(card(g)));
    const done = byId("goals-achieved"); done.replaceChildren();
    if (state.achievedCount) {
      const row = el("button", "mc-section-label archive-row", "Achieved "); row.type = "button";
      row.setAttribute("aria-expanded", String(state.achievedOpen));
      row.append(el("span", "count", "· " + state.achievedCount), el("span", "chevron-down"));
      row.onclick = async () => { state.achievedOpen = !state.achievedOpen; if (state.achievedOpen && !state.achieved) state.achieved = (await api("/api/goals?status=achieved")).goals; render(); };
      done.append(row);
      if (state.achievedOpen) (state.achieved || []).forEach((g) => done.append(card(g)));
    }
  }

  function openNew(show) {
    byId("goal-new").hidden = !show; byId("goal-new-toggle").hidden = show;
    // The form is the empty state's answer: while it is open the note goes.
    const empty = document.querySelector("#goals-list .goal-empty"); if (empty) empty.hidden = show;
    if (show) byId("goal-new-title").focus();
  }

  window.loadGoals = load;
  // Another part of the dashboard (a check-in under Upcoming) opens a goal.
  window.openGoal = async (id) => {
    state.open.add(id);
    if (typeof window.switchTab === "function") window.switchTab("goals");
    await load();
    const card = document.querySelector(`.goal-card[data-id="${id}"]`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  document.addEventListener("DOMContentLoaded", () => {
    byId("goal-new-toggle").onclick = () => openNew(true);
    byId("goal-new-cancel").onclick = () => openNew(false);
    byId("goal-new").querySelectorAll("input[name=goal-shape]").forEach((r) => { r.onchange = () => {
      const habit = r.value === "habit" && r.checked;
      byId("goal-new-habit").hidden = !habit; byId("goal-new-milestone").hidden = habit;
      byId("goal-new-title").placeholder = habit ? "What do you want to do regularly?" : "What do you want to achieve?";
    }; });
    byId("goal-new").onsubmit = async (ev) => {
      ev.preventDefault();
      const title = byId("goal-new-title").value.trim(); if (!title) return;
      const shape = byId("goal-new").querySelector("input[name=goal-shape]:checked")?.value || "milestone";
      try {
        const more = shape === "habit"
          ? { habit: { cue: byId("goal-new-cue").value.trim(), per_week: Number(byId("goal-new-per").value) || 3 } }
          : { done_when: byId("goal-new-done").value.trim(), target_date: byId("goal-new-by").value || null };
        const g = await api("/api/goals", { method: "POST", body: JSON.stringify({ title, shape, ...more }) });
        for (const id of ["goal-new-title", "goal-new-done", "goal-new-by", "goal-new-cue"]) byId(id).value = "";
        openNew(false); state.open.add(g.id); await load();
      } catch (e) { byId("goals-error").textContent = e.message; byId("goals-error").hidden = false; }
    };
  });
})();
