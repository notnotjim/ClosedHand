(() => {
  const $ = id => document.getElementById(id);
  let current, timer, prompt, appInstalled = false;
  const message = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
  const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const android = /Android/.test(navigator.userAgent);
  const mobile = iphone || android;
  const mac = /Mac/.test(navigator.platform);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function renderDevice() {
    const installed = appInstalled || standalone();
    const installable = !installed && canInstall();
    $('install').hidden = !installable;
    $('install').textContent = mobile ? 'Add to home screen' : 'Save to this computer';
    $('device-heading').textContent = mobile ? 'Add to your home screen' : 'Keep it on this computer';
    $('iphone').hidden = installed || !iphone;
    $('android').hidden = installed || !android || installable;
    $('desktop').hidden = installed || mobile || installable;
    $('installed').hidden = !installed;
    $('bookmark-key').textContent = mac ? '⌘D' : 'Ctrl+D';
  }
  function canInstall() { return !!(prompt && current?.permanent && current.url && new URL(current.url).origin === location.origin); }
  function render(data) {
    current = data; $('loading').hidden = true; $('install').hidden = !canInstall();
    const ready = !!(data.permanent && data.url);
    $('ready').hidden = !ready; $('setup').hidden = ready || !data.local;
    if (ready) {
      const url = new URL('/', data.url).href;
      $('address').href = url; $('address').textContent = new URL(url).host;
      document.querySelectorAll('.dashboard-link').forEach(a => { a.href = url; });
      renderDevice();
      $('qr').hidden = !data.local || mobile;
      $('scan-copy').hidden = $('qr').hidden;
      if (data.local && !mobile) $('qr').src = '/api/phone/qr.svg';
      $('local-note').hidden = !data.local;
      $('send').hidden = !data.canSend;
      $('other-device').hidden = $('qr').hidden && $('send').hidden;
      message('');
    } else if (data.local) {
      $('setup-copy').textContent = data.url ? 'Your current address is temporary. Set up a permanent link in Settings before saving a shortcut.' : 'Choose your personal URL in Settings before saving a shortcut.';
      message('');
    }
    clearTimeout(timer);
    if (data.local && data.enabled && !ready && !data.error) timer = setTimeout(load, 4000);
  }
  async function load() {
    try { const r = await fetch('/api/keep', { cache: 'no-store' }); if (!r.ok) throw new Error('Could not load your personal URL. Refresh this page to try again.'); render(await r.json()); }
    catch (e) { $('loading').hidden = true; message(e.message, true); }
  }
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText($('address').href); message('Personal URL copied.'); } catch (_) { message('Select and copy your personal URL above.'); } };
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
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); prompt = e; renderDevice(); });
  $('install').onclick = async () => { if (!canInstall()) return; const p = prompt; prompt = null; renderDevice(); await p.prompt(); const answer = await p.userChoice; message(answer.outcome === 'accepted' ? 'Follow your browser’s confirmation to finish adding ClosedHand.' : 'You can add ClosedHand later from your browser’s menu.'); };
  window.addEventListener('appinstalled', () => { appInstalled = true; prompt = null; renderDevice(); message('ClosedHand has been added.'); });
  load();
})();
