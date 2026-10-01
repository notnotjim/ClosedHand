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
  // The page shows one screen, whichever fits the visitor (see
  // navigation.openScreen): on the way to their personal URL ("found"),
  // signed in without one ("not-set-up"), not signed in ("find", with "New
  // to ClosedHand?" under it), or, with no sign of ClosedHand at all, how to
  // get it ("new"). Nothing shows until it knows which. Where the page can't
  // see ClosedHand here, a plain link opens it on this computer.
  $('local-open').href = navigation.LOCAL + (next === '/' ? '/' : next);
  function show(screen) {
    $('intro-new').hidden = screen !== 'new';
    $('intro-open').hidden = !screen || screen === 'new';
    for (const id of ['found', 'not-set-up', 'find']) $(id).hidden = id !== screen;
    $('not-set-up-new').hidden = screen !== 'not-set-up';
    $('newcomer').hidden = screen !== 'find';
    $('local-link').hidden = !['new', 'find', 'not-set-up'].includes(screen);
  }
  // A personal URL this device has opened from here before: a sign they
  // have ClosedHand, and the address to offer again. Kept in this browser
  // only, and only ever an address.
  const KNOWN = 'closedhand-personal-url';
  const remember = url => { try { localStorage.setItem(KNOWN, new URL(url).origin); } catch (_) {} };
  const known = (() => { try { return navigation.address(localStorage.getItem(KNOWN) || ''); } catch (_) { return null; } })();
  if (known) $('address').value = new URL(known).host;
  let findNote = '';
  $('have-it').addEventListener('click', () => { automatic = false; show('find'); say(findNote, !!findNote); $('login-google').focus(); });

  $('address').addEventListener('input', () => { automatic = false; $('address-error').hidden = true; });
  $('address-form').addEventListener('submit', event => {
    event.preventDefault(); automatic = false;
    const url = navigation.address($('address').value);
    if (!url) {
      $('address-error').textContent = 'That doesn’t look like a personal URL. It ends in .closedhand.ai, like yourname.closedhand.ai.';
      $('address-error').hidden = false; $('address').focus(); return;
    }
    remember(url);
    location.assign(next === '/' ? url : new URL(next, url).href);
  });

  // On the computer running ClosedHand, open it there. Docker uses 3000; the
  // Mac app takes 3000 or the next free port beside a Docker one. Phones and
  // tablets never run it. Chrome asks once before a website may look for
  // programs on this computer, and only when something is running there
  // (checked in Chrome 2026-09-26: with nothing listening the request just
  // fails, no question). Arriving here means "open my ClosedHand", so it
  // asks now; allowing it opens ClosedHand straight away, and after that
  // Chrome remembers and it is automatic.
  const desktop = !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const PORTS = [3000, 3002, 3001, 3003, 3004, 3005];
  function findLocal() {
    const ask = port => fetch('http://localhost:' + port + '/closedhand-here', { cache: 'no-store', signal: AbortSignal.timeout(1500) })
      .then(r => (r.ok ? r.json() : null))
      .then(d => (d && d.closedhand === true ? 'http://localhost:' + port : Promise.reject(new Error('not here'))));
    return Promise.any(PORTS.map(ask)).catch(() => null);
  }
  function openLocal(base) { show(null); say('Opening ClosedHand on this computer…'); location.replace(base + (next === '/' ? '/' : next)); }
  async function permission() {
    if (!navigator.permissions?.query) return null;
    for (const name of ['loopback-network', 'local-network-access']) {
      try { return await navigator.permissions.query({ name }); } catch (_) {}
    }
    return null;
  }
  // Settles when the look on this computer is over: the requests that make
  // Chrome ask have all come back (or there were none to make).
  let probed = Promise.resolve();
  // Settles quickly: where ClosedHand answers on this computer, or null.
  // While Chrome is still asking it settles null, so a personal URL still
  // opens; allowing afterwards opens ClosedHand here instead.
  const lookingHere = (async () => {
    if (!desktop || !automatic) return null;
    const status = await permission();
    if (!status || status.state === 'granted') return findLocal();
    if (status.state === 'denied') return null;
    $('here-note').hidden = false;
    status.addEventListener('change', async () => {
      $('here-note').hidden = true;
      const found = status.state === 'granted' && automatic ? await findLocal() : null;
      if (found && automatic) openLocal(found);
    }, { once: true });
    // These requests are what make Chrome ask. Ports with nothing on them
    // fail at once; one with ClosedHand waits for the answer. If none waits,
    // or the question is closed unanswered, the note goes away.
    probed = Promise.allSettled(PORTS.map(port => fetch('http://localhost:' + port + '/closedhand-here', { cache: 'no-store' })))
      .then(() => { if (status.state === 'prompt') $('here-note').hidden = true; });
    return null;
  })();
  lookingHere.then(found => { if (found && automatic) openLocal(found); });

  let checking = false;
  async function check() {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch('/api/account', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      const found = navigation.registeredAddress(data.url);
      const who = data.email || 'your ' + providerName(data.provider) + ' account';
      findNote = data.available ? '' : 'Looking up personal URLs isn’t working right now. You can still type yours.';
      // No sign of ClosedHand: not signed in, not arriving from it, never
      // opened from this device, and nothing answering on this computer.
      // Chrome still asking after a moment means something is running here,
      // so that is not a newcomer either.
      const facts = { signedIn: data.signedIn, choosing, failedSignIn, next, known };
      let newcomer = navigation.isNewcomer({ ...facts, nothingHere: true });
      if (newcomer) {
        const looked = await Promise.race([Promise.all([lookingHere, probed]).then(() => true), new Promise(done => setTimeout(done, 1500, false))]);
        newcomer = navigation.isNewcomer({ ...facts, nothingHere: looked && $('here-note').hidden && !(await lookingHere) });
      }
      const screen = navigation.openScreen({ newcomer, signedIn: data.signedIn, found: !!found, available: data.available, choosing, failedSignIn });
      if (screen === 'new') {
        show('new');
        say('');
      } else if (screen === 'find') {
        show('find');
        say(failedSignIn ? 'Sign-in didn’t finish. Try again, or type your personal URL.' : findNote, failedSignIn || !!findNote);
      } else if (screen === 'found') {
        const url = new URL(next, data.url).href;
        show('found');
        $('found-address').textContent = new URL(data.url).hostname;
        $('route-url').textContent = new URL(data.url).hostname;
        $('found-open').href = url;
        $('found-who').textContent = 'Linked to ' + who;
        remember(data.url);
        say(automatic ? 'Opening your ClosedHand…' : '');
        // On the computer running ClosedHand, opening it there comes first.
        if (automatic && !(await lookingHere) && automatic) location.replace(url);
      } else {
        show('not-set-up');
        $('not-set-up-who').textContent = 'No personal URL is linked to ' + who + ' yet.';
        say('');
      }
    } catch (_) {
      show('find');
      say('Couldn’t check just now. You can still type your personal URL.', true);
    } finally { checking = false; }
  }
  window.addEventListener('focus', check);
  check();
})();
