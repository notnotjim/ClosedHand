(() => {
  const root = document.getElementById('assistant-email');
  if (!root) return;
  let state, polling;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
  const status = el('p', 'Loading email settings…', 'section-desc'); status.setAttribute('role', 'status');
  const content = el('div'); root.append(content, status);
  async function request(path = '', body) {
    const response = await fetch('/api/assistant-email' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not update email. Please try again.'); return data;
  }
  function button(text, action, cls = 'conn-btn conn-btn-manage') {
    const node = el('button', text, cls); node.type = 'button';
    node.onclick = async () => { node.disabled = true; status.textContent = ''; try { await action(node); } catch (e) { status.textContent = e.message; } finally { node.disabled = false; } };
    return node;
  }
  async function refresh() { const result = await request('/refresh', {}); await load(); if (!result.pending) clearInterval(polling); }
  async function load() {
    try {
      state = await request(); render(); status.textContent = state.error || '';
    } catch (e) { status.textContent = e.message; content.replaceChildren(button('Retry', load)); }
  }
  function render() {
    content.replaceChildren();
    const heading = document.getElementById('assistant-email-heading'); heading.textContent = "ClosedHand's email address";
    content.append(el('p', "Send and forward emails to ClosedHand's own secure email address, or CC it into a conversation.", 'section-desc'));
    if (state.available === false) {
      const unavailable = el('button', 'Coming soon', 'conn-btn conn-btn-manage');
      unavailable.type = 'button'; unavailable.disabled = true;
      unavailable.classList.add('assistant-email-unavailable');
      content.append(unavailable);
      return;
    }
    heading.append(document.createTextNode(' '), el('span', 'Beta', 'badge badge-soon'));
    const allowance = el('details'); allowance.append(el('summary', 'Beta allowance'));
    const table = el('table', '', 'assistant-email-usage');
    const labels = el('tr');
    for (const label of ['', 'Sent', 'Received']) { const cell = el('th', label); cell.scope = 'col'; labels.append(cell); }
    const head = el('thead'); head.append(labels); table.append(head);
    const body = el('tbody');
    const count = (used, limit) => {
      const cell = el('td');
      cell.append(el('strong', Number.isFinite(used) ? used.toLocaleString() : '…'), document.createTextNode(' / ' + limit.toLocaleString()));
      return cell;
    };
    for (const [label, sent, received, sentLimit, receivedLimit] of [
      ['This month', state.usage?.sent, state.usage?.received, 1000, 2000],
      ['Today', state.usage?.dailySent, state.usage?.dailyReceived, 100, 200]
    ]) {
      const row = el('tr'); const title = el('th', label); title.scope = 'row';
      row.append(title, count(state.address ? sent : 0, sentLimit), count(state.address ? received : 0, receivedLimit)); body.append(row);
    }
    table.append(body); allowance.append(table);
    content.append(allowance);
    if (state.servicePaused) content.append(el('p', 'Email delivery is temporarily paused. Your address is kept.', 'section-desc'));
    if (!state.address) {
      content.append(button(state.pending ? 'Confirm email address' : 'Enable email address', async () => {
        // Open synchronously, preserving the user gesture through the request.
        const tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null;
        try {
          const result = await request('/enable', {});
          if (tab) tab.location = result.url;
          else { const link = el('a', 'Confirm your email address'); link.href = result.url; link.target = '_blank'; link.rel = 'noopener'; content.append(link); }
          status.textContent = 'Confirm your Google account in the new tab. This page updates automatically.';
          clearInterval(polling); polling = setInterval(() => { if (!document.hidden) refresh().catch(e => { status.textContent = e.message; }); }, 4000);
        } catch (e) { if (tab) tab.close(); throw e; }
      }));
      return;
    }
    const line = el('div', '', 'assistant-email-address');
    line.append(el('strong', state.address));
    const copy = button('', async () => { await navigator.clipboard.writeText(state.address); status.textContent = 'Email address copied.'; }, 'assistant-email-copy');
    copy.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
    copy.setAttribute('aria-label', 'Copy email address'); line.append(copy); content.append(line);
    content.append(el('p', (state.enabled ? 'On' : 'Paused') + ' · Private replies return to the address you email from.', 'section-desc'));
    const senders = el('details'); senders.append(el('summary', 'Your email addresses'));
    for (const address of state.ownerAddresses || [state.ownerEmail]) senders.append(el('p', address, 'section-desc'));
    content.append(senders);
    content.append(button(state.enabled ? 'Pause email' : 'Resume email', async () => { await request('/state', { enabled: !state.enabled }); await load(); }));
    if (state.threads.length || state.attention.length) {
      const details = el('details'); details.append(el('summary', 'Email conversations' + (state.attention.length ? ' · ' + state.attention.length + ' need attention' : '')));
      for (const thread of state.threads) {
        const section = el('section', '', 'assistant-email-thread'); section.append(el('h3', thread.subject || '(No subject)'));
        for (const item of state.attention.filter(x => x.thread_id === thread.id)) section.append(el('p', item.error || item.state, 'section-desc'));
        section.append(button('Read conversation', async node => {
          const data = await request('/threads/' + thread.id);
          const transcript = el('div', '', 'assistant-email-transcript');
          for (const message of data.messages) {
            transcript.append(el('strong', message.direction === 'out' ? state.name : message.from || 'Sender'));
            transcript.append(el('p', message.text || '(No message text)'));
          }
          node.replaceWith(transcript);
        }));
        const form = el('form');
        const field = (label, value, multi = false) => {
          const wrap = el('label', label); const input = el(multi ? 'textarea' : 'input'); input.value = value || ''; if (multi) input.rows = 4; wrap.append(input); form.append(wrap); return input;
        };
        const purpose = field('Task', thread.purpose);
        const people = field('People in this conversation', thread.participants.join(', '));
        const brief = field('Details it may share', thread.shared_brief, true);
        form.append(el('p', 'Replies use only these details for seven days. New actions still need you.', 'section-desc'));
        const actions = el('div', '', 'assistant-email-address');
        actions.append(button('Allow replies', async () => {
          await request('/threads/' + thread.id, { purpose: purpose.value, sharedBrief: brief.value, participants: people.value.split(',').map(x => x.trim()).filter(Boolean) }); await load();
        }));
        if (!thread.stopped) actions.append(button('Stop conversation', async () => { await request('/threads/' + thread.id, { stopped: true }); await load(); }));
        form.append(actions); form.onsubmit = event => event.preventDefault(); section.append(form); details.append(section);
      }
      content.append(details);
    }
  }
  window.addEventListener('focus', () => { if (state?.pending) refresh().catch(e => { status.textContent = e.message; }); });
  load();
})();
