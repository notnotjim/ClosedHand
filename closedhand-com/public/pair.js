(() => {
  let ticket = '';
  try { ticket = decodeURIComponent(location.hash.slice(1)); } catch (_) {}
  const $ = id => document.getElementById(id);
  const here = '/phone-access/pair#' + encodeURIComponent(ticket);
  $('login-google').href = '/auth/google?return_to=' + encodeURIComponent(here);
  $('login-microsoft').href = '/auth/microsoft?return_to=' + encodeURIComponent(here);
  const validUrl = value => /^https:\/\/[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(value || '');
  const providerName = p => p === 'microsoft' ? 'Microsoft' : 'Google';
  const say = (text, warn) => { $('status').textContent = text || ''; $('status').classList.toggle('warn', !!warn); };
  const show = which => { for (const id of ['signin', 'confirm', 'code-step', 'progress']) $(id).hidden = id !== which; };
  let timer, confirmedAt = 0, busy = false, leaving = false;

  async function request(path, body) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // Confirmed, then connecting, then ready. Only an address the exact
  // ClosedHand has answered at is ever opened.
  function progress(data) {
    confirmedAt = confirmedAt || Date.now();
    show('progress');
    $('heading').textContent = 'Personal URL confirmed';
    $('lede').textContent = 'Keep ClosedHand running on your computer while it connects.';
    const ready = data.state === 'active' && validUrl(data.url);
    $('step-confirmed').className = 'done';
    $('step-connecting').className = ready ? 'done' : 'now';
    $('step-ready').className = ready ? 'done' : '';
    if (ready) {
      clearTimeout(timer);
      $('open').href = data.url + '/'; $('open').hidden = false;
      if (!leaving) { leaving = true; say('Opening your ClosedHand…'); timer = setTimeout(() => location.replace(data.url + '/'), 1200); }
      return;
    }
    say(data.state === 'error' ? 'Connecting is taking longer than usual. It will keep retrying on its own.'
      : Date.now() - confirmedAt > 90000 ? 'Still connecting. Check ClosedHand is running; you can close this page and carry on there.' : '');
    timer = setTimeout(check, 3000);
  }

  // Confirmed here; finished by typing the code into the ClosedHand that
  // asked. Keep checking so the page moves on once it has been typed.
  function awaitCode(data) {
    show('code-step');
    $('heading').textContent = 'Now type this code in ClosedHand';
    $('lede').textContent = 'Go back to ClosedHand on your computer, where you chose this address, and type the code there.';
    $('code').textContent = data.code.slice(0, 3) + ' ' + data.code.slice(3);
    say('');
    timer = setTimeout(check, 3000);
  }

  async function check() {
    clearTimeout(timer);
    if (busy || leaving) return;
    try {
      const account = await request('/api/account');
      if (!account.available) throw new Error('Personal URLs aren’t available right now. ClosedHand still works on the computer running it.');
      const address = await request('/api/phone-enrollment/details', { ticket });
      const name = new URL(address.url).hostname;
      $('address').textContent = name;
      if (account.signedIn && ['pending', 'provisioning', 'connecting', 'active', 'error'].includes(address.state)) { progress(address); return; }
      if (account.signedIn && address.state === 'awaiting-code' && /^[A-Z0-9]{6}$/.test(address.code || '')) { awaitCode(address); return; }
      if (address.state === 'revoked') throw new Error('This personal URL was removed. Choose a new one in ClosedHand.');
      if (validUrl(account.url) && new URL(account.url).hostname !== name) {
        show(null);
        $('address-note').textContent = 'Already owns ' + new URL(account.url).hostname;
        $('open').href = account.url + '/dashboard#dashboard-link'; $('open').textContent = 'Open your ClosedHand'; $('open').hidden = false;
        say('This account already has a personal URL. Each account has one.', true);
        return;
      }
      if (!account.signedIn) {
        show('signin');
        say(new URLSearchParams(location.search).has('sign_in_error') ? 'Sign-in didn’t finish. Please try again.' : '', true);
        timer = setTimeout(check, 4000);
        return;
      }
      show('confirm');
      $('approve').disabled = false;
      $('who').textContent = 'Signed in as ' + (account.email || 'your ' + providerName(account.provider) + ' account');
      $('switch').href = (account.provider === 'microsoft' ? $('login-microsoft') : $('login-google')).href;
      // The owner's address opens another computer now: say what confirming does.
      $('approve').textContent = (address.move ? 'Move ' : 'Confirm ') + name;
      $('confirm-note').textContent = address.move
        ? name + ' opens ClosedHand on another computer now. Confirming moves it to the computer where you just chose it, and the other computer stops being reachable there.'
        : 'Only confirm an address you just chose in your own ClosedHand.';
      say('');
    } catch (e) {
      say(e.message, true);
      if (confirmedAt || !$('code-step').hidden) timer = setTimeout(check, 5000);
    }
  }

  $('approve').onclick = async () => {
    if (busy) return;
    clearTimeout(timer); busy = true; $('approve').disabled = true;
    say('Confirming…');
    try {
      const result = await request('/api/phone-enrollment/approve', { ticket });
      if (result.state === 'awaiting-code') awaitCode(result); else progress(result);
    }
    catch (e) { say(e.message, true); $('approve').disabled = false; }
    finally { busy = false; }
  };

  if (!ticket) {
    show(null);
    $('address').textContent = 'yourname.closedhand.ai';
    say('Open this page from ClosedHand: choose a personal URL in setup or in Settings, then confirm it.', true);
  } else check();
})();
