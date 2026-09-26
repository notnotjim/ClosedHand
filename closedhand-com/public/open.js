(() => {
  const $ = id => document.getElementById(id), navigation = window.ClosedHandEntry;
  const next = navigation.destination(location), query = new URLSearchParams(location.search);
  const failedSignIn = query.has('sign_in_error');
  const choosing = query.get('choose') === '1';
  let automatic = !choosing && !failedSignIn;
  const back = encodeURIComponent('/open?next=' + encodeURIComponent(next));
  $('login-google').href = '/auth/google?return_to=' + back;
  $('login-microsoft').href = '/auth/microsoft?return_to=' + back;
  const say = (text, warn) => { $('status').textContent = text || ''; $('status').classList.toggle('warn', !!warn); };
  const providerName = p => p === 'microsoft' ? 'Microsoft' : 'Google';

  $('address').addEventListener('input', () => { automatic = false; $('address-error').hidden = true; });
  $('address-form').addEventListener('submit', event => {
    event.preventDefault(); automatic = false;
    const url = navigation.address($('address').value);
    if (!url) {
      $('address-error').textContent = 'That doesn’t look like a personal URL. It ends in .closedhand.ai, like yourname.closedhand.ai.';
      $('address-error').hidden = false; $('address').focus(); return;
    }
    location.assign(next === '/' ? url : new URL(next, url).href);
  });

  // On the computer running ClosedHand, open it there. Docker uses 3000; the
  // Mac app takes 3000 or the next free port beside a Docker one. Phones and
  // tablets never run it. Chrome asks before a website may talk to programs
  // on this computer, so the page only tries by itself where the browser
  // allows it without asking; otherwise the person chooses "Open it here",
  // and Chrome asks once, when it makes sense.
  const desktop = !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  function findLocal() {
    const ask = port => fetch('http://localhost:' + port + '/closedhand-here', { cache: 'no-store', signal: AbortSignal.timeout(1500) })
      .then(r => (r.ok ? r.json() : null))
      .then(d => (d && d.closedhand === true ? 'http://localhost:' + port : Promise.reject(new Error('not here'))));
    return Promise.any([3000, 3002, 3001, 3003, 3004, 3005].map(ask)).catch(() => null);
  }
  function openLocal(base) { say('Opening ClosedHand on this computer…'); location.replace(base + (next === '/' ? '/' : next)); }
  async function permission() {
    if (!navigator.permissions?.query) return 'unknown';
    for (const name of ['loopback-network', 'local-network-access']) {
      try { return (await navigator.permissions.query({ name })).state; } catch (_) {}
    }
    return 'unknown';
  }
  const lookingHere = (async () => {
    if (!desktop || !automatic) return null;
    const state = await permission();
    if (state === 'prompt') { $('here').hidden = false; return null; }
    return state === 'denied' ? null : findLocal();
  })();
  lookingHere.then(found => { if (found && automatic) openLocal(found); });
  $('here-open').addEventListener('click', async () => {
    automatic = false;
    $('here-open').disabled = true;
    say('Looking for ClosedHand on this computer…');
    const found = await findLocal();
    if (found) return openLocal(found);
    $('here-open').disabled = false;
    say('ClosedHand isn’t answering on this computer. Check it’s running, or use your personal URL.', true);
  });

  let checking = false;
  async function check() {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch('/api/account', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      const found = navigation.registeredAddress(data.url);
      const who = data.signedIn ? (data.email || 'your ' + providerName(data.provider) + ' account') : '';
      $('find-who-row').hidden = !data.signedIn;
      $('find-who').textContent = data.signedIn ? 'Signed in with ' + providerName(data.provider) + ' as ' + who : '';
      $('found').hidden = !found || choosing;
      $('find').hidden = found && !choosing;
      if (found && !choosing) {
        const url = new URL(next, data.url).href;
        $('found-address').textContent = new URL(data.url).hostname;
        $('route-url').textContent = new URL(data.url).hostname;
        $('found-open').href = url;
        $('found-who').textContent = 'Signed in as ' + who;
        say(automatic ? 'Opening your ClosedHand…' : '');
        // On the computer running ClosedHand, opening it there comes first.
        if (automatic && !(await lookingHere) && automatic) location.replace(url);
      } else if (failedSignIn) {
        say('Sign-in didn’t finish. Try again, or type your personal URL.', true);
      } else if (!data.available) {
        say('Looking up personal URLs isn’t working right now. You can still type yours.', true);
      } else if (data.signedIn) {
        $('find-hint').textContent = 'No personal URL is linked to this ' + providerName(data.provider) + ' account. Continue with the account you used when you set up your personal URL.';
        say('');
      } else {
        say('');
      }
    } catch (_) {
      say('Couldn’t check just now. You can still type your personal URL.', true);
    } finally { checking = false; }
  }
  window.addEventListener('focus', check);
  check();
})();
