(() => {
  const $ = id => document.getElementById(id);
  let current, timer, prompt;
  const message = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
  const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (new URLSearchParams(location.search).get('welcome') === '1') $('later').href = '/?dash=%3Fwelcome%3D1';
  function canInstall() { return !!(prompt && current?.permanent && current.url && new URL(current.url).origin === location.origin); }
  function render(data) {
    current = data; $('loading').hidden = true; $('install').hidden = !canInstall();
    const ready = !!(data.permanent && data.url);
    $('ready').hidden = !ready; $('setup').hidden = ready || !data.local;
    if (ready) {
      const url = new URL('/dashboard', data.url).href;
      $('address').href = url; $('address').textContent = url;
      document.querySelectorAll('.dashboard-link').forEach(a => { a.href = url; });
      $('iphone').hidden = !iphone; $('other').hidden = iphone;
      $('qr').hidden = !data.local || iphone;
      $('scan-copy').hidden = $('qr').hidden;
      if (data.local && !iphone) $('qr').src = '/api/phone/qr.svg';
      $('local-note').hidden = !data.local;
      $('send').hidden = !data.canSend;
      message('');
    } else if (data.local) {
      $('setup-copy').textContent = data.url ? 'Your current dashboard link is temporary. Set up a permanent, password-protected link before saving it.' : 'Access your dashboard from your phone with a permanent, password-protected link.';
      $('pair').hidden = !data.pairingUrl; $('enable').hidden = !!data.pairingUrl;
      if (data.pairingUrl) $('pair').href = data.pairingUrl;
      if (data.error) { message(data.error, true); $('enable').hidden = false; $('enable').textContent = 'Try again'; }
      else if (data.state === 'pairing') message('Finish setup in the page above, then return here.');
      else if (data.state === 'starting') message('Connecting your computer…');
    }
    clearTimeout(timer);
    if (data.local && data.enabled && !ready && !data.error) timer = setTimeout(load, 4000);
  }
  async function load() {
    try { const r = await fetch('/api/keep', { cache: 'no-store' }); if (!r.ok) throw new Error('Could not load your dashboard address. Refresh this page to try again.'); render(await r.json()); }
    catch (e) { $('loading').hidden = true; message(e.message, true); }
  }
  $('enable').onclick = async () => {
    $('enable').disabled = true; message('Setting up dashboard access…');
    try { const r = await fetch('/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, mode: 'managed' }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); await load(); }
    catch (e) { message(e.message, true); } finally { $('enable').disabled = false; }
  };
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText($('address').href); message('Dashboard link copied.'); } catch (_) { message('Select and copy the dashboard address above.'); } };
  $('send').onclick = async () => {
    $('send').disabled = true;
    try { const r = await fetch('/api/phone/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const d = await r.json(); if (!r.ok) throw new Error(d.error); message('Sending the link to your connected chat…');
      let state;
      for (let count = 0; count < 15; count++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const status = await fetch('/api/phone/delivery', { cache: 'no-store' });
        if (!status.ok) throw new Error('Could not check delivery. You can copy the link above.');
        state = (await status.json()).state;
        if (state === 'sent') { message('The link was sent to your chat. You can pin that message.'); break; }
        if (state === 'error') throw new Error('Could not send the link. Check that your chat app is connected, then try again.');
      }
      if (state !== 'sent') message('The link is still waiting to be sent. You can copy it above.'); }
    catch (e) { message(e.message, true); } finally { $('send').disabled = false; }
  };
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); prompt = e; $('install').hidden = !canInstall(); });
  $('install').onclick = async () => { if (!canInstall()) return; const p = prompt; prompt = null; $('install').hidden = true; await p.prompt(); const answer = await p.userChoice; message(answer.outcome === 'accepted' ? 'Follow your browser’s confirmation to finish adding ClosedHand.' : 'You can add ClosedHand later from your browser’s menu.'); };
  window.addEventListener('appinstalled', () => { $('install').hidden = true; message('ClosedHand has been added.'); });
  load();
})();
