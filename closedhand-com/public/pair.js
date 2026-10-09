(() => {
  // The link is "#<ticket>" from older ClosedHands, or "#t=<ticket>&..." with:
  //   state  a one-time value the Closedhand made, handed back with the code;
  //   back   where setup is, on the computer this browser is on;
  //   via    google or microsoft: the mail sign-in setup just did, to repeat
  //          here without the choice; hint names its account;
  //   popup  1 when setup opened this in a window of its own, which closes
  //          once setup has the code.
  // The code only ever goes back to this computer's own setup (localhost), so
  // a link from somebody else can never carry it off: that is what lets
  // the code travel by itself instead of being typed.
  let ticket = '', auto = {};
  const loopback = value => {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password
        && u.pathname === '/setup' ? u.origin + u.pathname : null;
    } catch (_) { return null; }
  };
  try {
    const raw = location.hash.slice(1);
    if (raw.startsWith('t=')) {
      const p = new URLSearchParams(raw);
      ticket = p.get('t') || '';
      const state = /^[a-f0-9]{32}$/.test(p.get('state') || '') ? p.get('state') : null;
      const back = state && loopback(p.get('back'));
      if (back) auto = { state, back, tried: p.has('tried'),
        popup: p.get('popup') === '1',
        via: ['google', 'microsoft'].includes(p.get('via')) ? p.get('via') : null,
        hint: /^[^\s@<>"']{1,200}@[^\s@<>"']{1,200}$/.test(p.get('hint') || '') ? p.get('hint') : null };
    } else ticket = decodeURIComponent(raw);
  } catch (_) {}
  const $ = id => document.getElementById(id);
  // Back here after signing in: the same link, marked as tried so a sign-in
  // that didn't finish shows the choice instead of looping.
  const here = '/phone-access/pair#' + (auto.back
    ? new URLSearchParams({ t: ticket, state: auto.state, back: auto.back, ...(auto.popup ? { popup: '1' } : {}), ...(auto.via ? { via: auto.via } : {}), ...(auto.hint ? { hint: auto.hint } : {}), tried: '1' })
    : encodeURIComponent(ticket));
  const hintFor = p => auto.hint && auto.via === p ? '&login_hint=' + encodeURIComponent(auto.hint) : '';
  $('login-google').href = '/auth/google?return_to=' + encodeURIComponent(here) + hintFor('google');
  $('login-microsoft').href = '/auth/microsoft?return_to=' + encodeURIComponent(here) + hintFor('microsoft');
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
  // Closedhand has answered at is ever opened.
  function progress(data) {
    confirmedAt = confirmedAt || Date.now();
    show('progress');
    $('heading').textContent = 'Personal URL claimed';
    $('lede').textContent = 'Keep Closedhand running while it connects.';
    const ready = data.state === 'active' && validUrl(data.url);
    $('step-confirmed').className = 'done';
    $('step-connecting').className = ready ? 'done' : 'now';
    $('step-ready').className = ready ? 'done' : '';
    if (ready) {
      clearTimeout(timer);
      $('open').href = data.url + '/'; $('open').hidden = false;
      if (!leaving) { leaving = true; say('Opening your Closedhand…'); timer = setTimeout(() => location.replace(data.url + '/'), 1200); }
      return;
    }
    say(data.state === 'error' ? 'Connecting is taking longer than usual. It will keep retrying on its own.'
      : Date.now() - confirmedAt > 90000 ? 'Still connecting. Check Closedhand is running; you can close this page and carry on there.' : '');
    timer = setTimeout(check, 3000);
  }

  // The code goes straight back to setup on this computer.
  function handBack(code) {
    clearTimeout(timer); leaving = true;
    show(null);
    say('Taking you back to setup…');
    location.replace(auto.back + '#' + new URLSearchParams({ claim: code, state: auto.state, ...(auto.popup ? { close: '1' } : {}) }));
  }

  // Confirmed here; finished by typing the code into the Closedhand that
  // asked. Keep checking so the page moves on once it has been typed.
  function awaitCode(data) {
    if (auto.back) { handBack(data.code); return; }
    show('code-step');
    $('heading').textContent = 'Now paste this code in Closedhand';
    $('lede').textContent = 'Copy it, then go back to the Closedhand tab you came from and paste it. It finishes by itself.';
    $('code').textContent = data.code.slice(0, 3) + ' ' + data.code.slice(3);
    $('copy-code').dataset.code = data.code;
    say('');
    timer = setTimeout(check, 3000);
  }

  async function check() {
    clearTimeout(timer);
    if (busy || leaving) return;
    try {
      const account = await request('/api/account');
      if (!account.available) throw new Error('Personal URLs aren’t available right now. Closedhand still works on the computer running it.');
      const address = await request('/api/phone-enrollment/details', { ticket });
      const name = new URL(address.url).hostname;
      $('address').textContent = name;
      if (account.signedIn && ['pending', 'provisioning', 'connecting', 'active', 'error'].includes(address.state)) {
        if (auto.back) { leaving = true; location.replace(auto.back); return; }
        progress(address); return;
      }
      if (account.signedIn && address.state === 'awaiting-code' && /^[A-Z0-9]{6}$/.test(address.code || '')) { awaitCode(address); return; }
      if (address.state === 'revoked') throw new Error('This personal URL was removed. Claim a new one in Closedhand’s Settings.');
      if (validUrl(account.url) && new URL(account.url).hostname !== name) {
        show(null);
        $('address-note').textContent = 'Already owns ' + new URL(account.url).hostname;
        $('open').href = account.url + '/dashboard#dashboard-link'; $('open').textContent = 'Open your Closedhand'; $('open').hidden = false;
        say('This account already has a personal URL. Each account has one.', true);
        return;
      }
      // Straight on from connecting mail: the same sign-in, once.
      if (!account.signedIn && auto.via && !auto.tried) {
        leaving = true;
        say('Signing in with ' + providerName(auto.via) + '…');
        location.replace($('login-' + auto.via).href);
        return;
      }
      if (!account.signedIn) {
        show('signin');
        say(new URLSearchParams(location.search).has('sign_in_error') ? 'Sign-in didn’t finish. Please try again.' : '', true);
        timer = setTimeout(check, 4000);
        return;
      }
      $('who').textContent = 'Signed in as ' + (account.email || 'your ' + providerName(account.provider) + ' account');
      // Switching picks an account afresh, so it names none.
      $('switch').href = '/auth/' + (account.provider === 'microsoft' ? 'microsoft' : 'google') + '?return_to=' + encodeURIComponent(here);
      // The account setup just connected, signed in here too: nothing left to
      // ask. Moving an address off another computer is always asked.
      if (auto.hint && !address.move && String(account.email || '').toLowerCase() === auto.hint.toLowerCase()) {
        show(null);
        say('Claiming ' + name + '…');
        await approve();
        return;
      }
      show('confirm');
      $('approve').disabled = false;
      // The account's address already opens a Closedhand set up before: a
      // plain question, which only switches it when the answer is yes. Never
      // put as "computer": the address is for opening Closedhand on any device.
      if (address.move) {
        $('heading').textContent = 'You already have a personal URL linked to this email';
        $('lede').textContent = 'It opens a Closedhand you set up before. Want to switch it to the one you’re setting up now? The earlier one stops opening there.';
      }
      $('approve').textContent = address.move ? 'Switch to the new one' : 'Claim ' + name;
      $('confirm-note').textContent = address.move ? '' : 'Only claim it if you’re setting up Closedhand on your own computer.';
      $('confirm-note').hidden = !!address.move;
      say('');
    } catch (e) {
      say(e.message, true);
      if (confirmedAt || !$('code-step').hidden) timer = setTimeout(check, 5000);
    }
  }

  $('copy-code').onclick = async () => {
    const code = $('copy-code').dataset.code || '';
    try { await navigator.clipboard.writeText(code); $('copy-code').textContent = 'Copied'; }
    catch (_) {
      // Some browsers refuse the clipboard: select the code to copy by hand.
      const range = document.createRange(); range.selectNodeContents($('code'));
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      $('copy-code').textContent = 'Selected, copy it now';
    }
    setTimeout(() => { $('copy-code').textContent = 'Copy code'; }, 2500);
  };

  async function approve() {
    if (busy) return;
    clearTimeout(timer); busy = true; $('approve').disabled = true;
    say('Claiming…');
    try {
      const result = await request('/api/phone-enrollment/approve', { ticket });
      if (result.state === 'awaiting-code') awaitCode(result);
      else if (auto.back) { leaving = true; location.replace(auto.back); }
      else progress(result);
    }
    catch (e) { show('confirm'); say(e.message, true); $('approve').disabled = false; }
    finally { busy = false; }
  }
  $('approve').onclick = approve;

  if (!ticket) {
    show(null);
    $('address').textContent = 'yourname.closedhand.ai';
    say('Open this page from Closedhand’s Setup or Settings.', true);
  } else check();
})();
