// The insights page (lib/insights.js): totals only, drawn from /api/insights.
(() => {
  const $ = id => document.getElementById(id);
  const n = v => (v == null ? 'n/a' : Number(v).toLocaleString('en-GB'));
  function rows(id, list) {
    const dl = $(id);
    dl.textContent = '';
    for (const [label, value, note] of list) {
      const row = document.createElement('div');
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value;
      if (note) { const small = document.createElement('small'); small.textContent = note; dd.append(small); }
      row.append(dt, dd); dl.append(row);
    }
  }
  function draw(d) {
    const a = d.accounts, u = d.urls, g = d.github;
    rows('people', [
      ['Closedhand accounts', n(a.total), `${n(a.week)} new this week, ${n(a.month)} this month`],
      ['Signed in with', `${n(a.google)} Google, ${n(a.microsoft)} Microsoft`],
      ['Personal URLs working', n(u.working)],
      ['Online in the last day', n(u.day)],
      ['Online in the last week', n(u.week)],
      ['Online in the last month', n(u.month)],
    ]);
    const body = $('weeks');
    body.textContent = '';
    for (const w of d.weeks.slice().reverse()) {
      const tr = document.createElement('tr');
      const when = new Date(w.week + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      for (const text of [when, n(w.claimed), n(w.installs)]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
      body.append(tr);
    }
    rows('downloads', [
      ['Mac app', g ? n(g.macTotal) : 'n/a', g && g.macLatest ? `${n(g.macLatest.downloads)} of ${g.macLatest.version}` : 'GitHub did not answer'],
      ['Install command', n(d.installs.total), 'Fetches of closedhand.com/install'],
      ['GitHub stars', g ? n(g.stars) : 'n/a', g ? `${n(g.forks)} ${g.forks === 1 ? 'fork' : 'forks'}` : ''],
    ]);
    rows('room', [
      ['Personal URLs', `${n(u.used)} of ${n(u.limit)}`],
      ['DNS records', `${n(u.dns)} of ${n(u.dnsCeiling)}`],
      ['Still setting up', n(u.setting_up)],
      ['Stuck with an error', n(u.errors)],
    ]);
    rows('other', [
      ['Bug reports open', n(d.bugs.open), `${n(d.bugs.week)} sent this week`],
      ['Assistant email', `${n(d.email.accounts)} on`, `${n(d.email.sent)} sent, ${n(d.email.received)} received this month`],
    ]);
    everyone = d.people || [];
    drawPeople();
    const reports = $('reports');
    reports.textContent = '';
    for (const r of d.reports || []) {
      reports.append(item(`${day(r.created_at)}, ${r.status}${r.app_version ? ', ' + r.app_version : ''}${r.platform ? ', ' + r.platform : ''}`, r.comment || '(no comment)'));
    }
    if (!(d.reports || []).length) reports.append(item('None yet', ''));
    $('updated').textContent = 'Online means the computer running Closedhand connected in that time. Updated ' +
      new Date(d.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '.';
  }
  const day = v => (v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  // How long ago, in the largest whole unit that fits.
  function ago(v) {
    if (!v) return 'never';
    const s = (Date.now() - new Date(v)) / 1000;
    if (s < 3600) return 'within the hour';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' days ago';
  }
  function item(head, body, extra) {
    const li = document.createElement('li');
    const top = document.createElement('p'); top.className = 'person-head'; top.textContent = head;
    li.append(top);
    for (const text of [body, extra]) if (text) { const p = document.createElement('p'); p.textContent = text; li.append(p); }
    return li;
  }
  let everyone = [];
  function drawPeople() {
    const q = $('search').value.trim().toLowerCase();
    const list = $('people-list');
    list.textContent = '';
    const shown = everyone.filter(p => !q || [p.email, p.hostname, p.held_name, p.assistant_email].some(v => v && v.toLowerCase().includes(q)));
    for (const p of shown) {
      const li = document.createElement('li');
      const head = document.createElement('p'); head.className = 'person-head';
      const who = document.createElement('span'); who.textContent = p.email || '(no email given)';
      const seen = document.createElement('span'); seen.className = 'person-seen';
      seen.textContent = p.hostname ? 'online ' + ago(p.last_online) : 'no personal URL';
      head.append(who, seen);
      li.append(head);
      const line = document.createElement('p');
      if (p.hostname) {
        const link = document.createElement('a'); link.href = 'https://' + p.hostname; link.rel = 'noopener noreferrer'; link.target = '_blank'; link.textContent = p.hostname;
        line.append(link, ` ${p.state}${p.renames ? ', renamed ' + p.renames + 'x' : ''}`);
      } else line.textContent = p.held_name ? `Name held: ${p.held_name}` : 'Signed in, nothing claimed';
      li.append(line);
      const more = document.createElement('p');
      more.textContent = `${p.provider === 'microsoft' ? 'Microsoft' : 'Google'}${p.email_verified ? '' : ' (email unverified)'}. Signed up ${day(p.signed_up)}` +
        (p.claimed ? `, claimed ${day(p.claimed)}` : '') + '.' +
        (p.assistant_email ? ` Closedhand email ${p.assistant_email}: ${n(p.email_sent)} sent, ${n(p.email_received)} received this month.` : '');
      li.append(more);
      list.append(li);
    }
    $('everyone-title').textContent = q ? `Everyone (${shown.length} of ${everyone.length})` : `Everyone (${everyone.length})`;
  }
  $('search').addEventListener('input', drawPeople);
  async function load() {
    try {
      const response = await fetch('/api/insights', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      draw(await response.json());
      $('status').textContent = '';
    } catch (_) { $('status').textContent = 'Could not load the numbers. Reload to try again.'; }
  }
  load();
})();
