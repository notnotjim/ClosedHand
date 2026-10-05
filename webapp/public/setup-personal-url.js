/* The personal URL, setup's step after email and calendar. Connecting Microsoft
   through ClosedHand's app claims it with that same sign-in; otherwise one
   click claims it on closedhand.com (which picks the name). Then "Your
   ClosedHand is at name.closedhand.ai", with Change to rename. Claimed, the
   step folds by itself: connecting carries on in the background. */
(function (root) {
  'use strict';
  function mount(container, changed) {
    var $ = function (id) { return container.querySelector('#' + id); };
    var key = null, password = false, settled = false, state = {}, busy = false, checking = false;
    var lastCheck = 0, generation = 0, actionError = null, completedReady = false, claiming = false, renaming = false, renamed = null, wasWaiting = false, signingIn = false;
    // closedhand.com hands the code straight back here, with the state from
    // this ClosedHand's link, after its sign-in (closedhand-com/public/pair.js).
    var handed = null, signin = null;
    try {
      var back = new URLSearchParams((root.location.hash || '').slice(1));
      if (/^[A-Za-z0-9]{6}$/.test(back.get('claim') || '') && /^[a-f0-9]{32}$/.test(back.get('state') || '')) {
        handed = { code: back.get('claim'), state: back.get('state'), close: back.get('close') === '1' };
        root.history.replaceState(null, '', root.location.pathname + root.location.search);
      }
    } catch (_) {}
    // A typed name tidied as closedhand.com tidies it (webapp/phone-registration.js).
    function cleanName(value) {
      return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[\s._]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
        .replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');
    }
    function remember() {
      settled = true;
      try { if (key) localStorage.setItem(key, 'done'); } catch (_) {}
      changed();
    }
    function personalUrl(value) {
      try {
        var u = new URL(value);
        return u.protocol === 'https:' && /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(u.hostname)
          && !u.username && !u.password && !u.port ? u.origin + '/' : null;
      } catch (_) { return null; }
    }
    function pairingUrl(value, popup) {
      try {
        var u = new URL(value);
        if (u.origin !== 'https://closedhand.com' || u.pathname !== '/phone-access/pair') return null;
        if (!/^#t=/.test(u.hash)) return u.href;
        // Setup on this computer takes the code back by itself, instead of it
        // being typed; with an account just connected, closedhand.com signs in
        // with that same one, so the claim is one click.
        var extra = '&back=' + encodeURIComponent(root.location.origin + '/setup') + (popup ? '&popup=1' : '');
        if (signin && /^(google|microsoft)$/.test(signin.via) && signin.hint) extra += '&via=' + signin.via + '&hint=' + encodeURIComponent(signin.hint);
        return u.href + extra;
      } catch (_) { return null; }
    }
    function display() {
      $('url-password-note').hidden = password;
      $('url-controls').hidden = !password;
      var saved = personalUrl(state.permanent && state.url || state.savedUrl);
      var confirm = pairingUrl(state.pairingUrl);
      var confirmed = state.enabled && state.ownershipConfirmed;
      var reserved = confirmed && personalUrl('https://' + state.addressName + '.closedhand.ai');
      // While a code is awaited, the code is the next thing to do; reopening
      // the confirmation page becomes the quiet option.
      // On this computer closedhand.com hands the code back by itself, so the
      // box to paste it into is only for setup opened from somewhere else.
      var handsBack = !!confirm && /#t=/.test(confirm) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(root.location.hostname || '');
      var waiting = !!confirm && !(saved || confirmed) && !handsBack;
      $('url-form').hidden = !!(saved || confirmed);
      // Confirming on closedhand.com shows a code; typing it here finishes.
      $('url-code-form').hidden = !waiting;
      // The code box is the next thing to use: have it ready to paste into.
      if (waiting && !wasWaiting) setTimeout(function () { $('url-code').focus(); }, 0);
      wasWaiting = waiting;
      $('url-code-submit').disabled = claiming || !password;
      $('url-code-submit').textContent = claiming ? 'Checking…' : 'Finish';
      $('url-saved').hidden = !password || !(saved || reserved);
      $('url-value').value = saved || reserved || '';
      $('url-copy').hidden = !(saved || reserved);
      // Where ClosedHand is, once its address is confirmed, with Change.
      $('url-ready').hidden = !password || !(saved || reserved);
      $('url-where').textContent = saved || reserved ? new URL(saved || reserved).hostname : '';
      $('url-rename-submit').disabled = renaming;
      $('url-rename-submit').textContent = renaming ? 'Saving…' : 'Save';
      $('url-start').disabled = busy || !password;
      $('url-start').textContent = busy ? 'Opening…' : waiting ? 'Open closedhand.com again' : signingIn && confirm ? 'Open the sign-in again' : 'Claim your personal URL';
      $('url-start').classList.toggle('is-quiet', waiting);
      $('url-start').formNoValidate = !!confirm;
      $('url-status').textContent = actionError || state.error || (renamed ? renamed : saved
        ? (state.state === 'on' ? 'Your personal URL is ready. Use your dashboard password to open it.' : 'Your personal URL is saved. ClosedHand is not connected to it yet. You can continue setup here.')
        : confirmed ? (state.registrationState === 'error'
          ? 'Your personal URL is claimed, but its connection is delayed. ClosedHand will retry automatically.'
          : 'Your personal URL is claimed. Connecting it now. You can continue setup.')
        : state.serviceAvailable === false ? 'closedhand.com can’t give out personal URLs right now. Carry on and get yours from the dashboard later.'
        : confirm ? (signingIn && handsBack ? 'Sign in in the window that opened. It closes by itself when you’re done.' : '')
        : state.enabled ? 'Connecting your personal URL. You can continue setup while it connects.' : '');
      // Every ClosedHand gets a personal URL here. Carrying on without one is
      // offered only when closedhand.com can't give one out right now (or
      // getting one failed); the dashboard offers it again later.
      var cantGet = state.serviceAvailable === false || !!(actionError || state.error);
      // Claimed: the step folds by itself, so there is nothing to press.
      $('url-continue').hidden = !!confirmed || !(saved || cantGet);
      $('url-continue').textContent = saved ? 'Continue setup' : 'Continue without a personal URL';
    }
    async function request(method, body) {
      var response = await fetch('/api/phone', { method: method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        var failure = await response.json().catch(function () { return {}; });
        throw new Error(failure.error || 'Could not check your personal URL. Try again or continue setup without one.');
      }
      return response.json();
    }
    async function check() {
      if (!password || busy || checking || Date.now() - lastCheck < 4000) return;
      checking = true; lastCheck = Date.now();
      var run = generation;
      try {
        var result = await request('GET');
        if (run !== generation) return;
        state = result;
      } catch (e) { if (run === generation) state.error = e.message; }
      finally {
        checking = false;
        if (run === generation) {
          // Once it answers at the new name, the usual status takes over.
          if (renamed && state.state === 'on') renamed = null;
          display();
          // Not while a new name is being typed: finishing folds the step away.
          // Claimed is finished: connecting is ClosedHand's part, not the person's.
          var claimed = state.enabled && state.ownershipConfirmed && personalUrl('https://' + state.addressName + '.closedhand.ai');
          var working = state.state === 'on' && personalUrl(state.permanent && state.url || state.savedUrl);
          if (password && !completedReady && $('url-rename-form').hidden && (claimed || working)) {
            completedReady = true;
            remember();
          }
        }
      }
    }
    $('url-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!password || busy) return;
      // Open during the click, before awaiting the fresh ticket, so browsers
      // do not mistake it for an unsolicited popup. A small window of its own,
      // like any "Sign in with Google": it closes itself once the claim is in,
      // and this page notices on its next check.
      var confirmationTab = window.open('about:blank', 'closedhand-claim', 'popup,width=520,height=720');
      if (confirmationTab) confirmationTab.opener = null;
      busy = true; actionError = null; var run = ++generation; display();
      try {
        var result = await request('POST', { enabled: true, mode: 'managed' });
        if (run !== generation) { if (confirmationTab) confirmationTab.close(); return; }
        state = result;
        var destination = pairingUrl(state.pairingUrl, !!confirmationTab);
        signingIn = !!confirmationTab;
        if (!destination) throw new Error('Could not open the confirmation on closedhand.com. Please try again.');
        if (confirmationTab && !confirmationTab.closed) confirmationTab.location.replace(destination);
        else window.location.assign(destination);
      } catch (e) {
        if (confirmationTab) confirmationTab.close();
        if (run === generation) actionError = e.message;
      } finally { if (run === generation) { busy = false; lastCheck = 0; display(); } }
    });
    // Six letters and numbers, pasted or typed, with or without the space.
    function codeTyped() { return String($('url-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
    $('url-code').addEventListener('input', function () {
      actionError = null;
      if (codeTyped().length === 6 && !claiming) submitCode();
    });
    $('url-code-form').addEventListener('submit', function (event) { event.preventDefault(); submitCode(); });
    async function submitCode(given) {
      if (!password || claiming) return;
      claiming = true; actionError = null; display();
      try {
        var body = given ? { code: given.code, state: given.state } : { code: $('url-code').value };
        var response = await fetch('/api/phone/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        var result = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(result.error || 'Could not check the code. Please try again.');
        $('url-code').value = '';
        // The sign-in window's job is done: setup behind it picks the claim up.
        // A refused code keeps the window open, showing why.
        if (given && given.close) { try { root.close(); } catch (_) {} }
      } catch (e) { actionError = e.message; }
      finally { claiming = false; lastCheck = 0; display(); check(); }
    }
    // Change: rename. The old address sends people on for thirty days.
    $('url-change').addEventListener('click', function (event) {
      event.preventDefault();
      $('url-rename-form').hidden = !$('url-rename-form').hidden;
      if (!$('url-rename-form').hidden) { $('url-new-name').value = ''; $('url-new-preview').textContent = ''; $('url-new-name').focus(); }
    });
    $('url-new-name').addEventListener('input', function () {
      var name = cleanName($('url-new-name').value);
      $('url-new-preview').textContent = name ? name + '.closedhand.ai' : '';
    });
    $('url-rename-cancel').addEventListener('click', function () { $('url-rename-form').hidden = true; });
    $('url-rename-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!password || renaming) return;
      renaming = true; actionError = null; renamed = null; display();
      try {
        var response = await fetch('/api/phone/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('url-new-name').value }), signal: AbortSignal.timeout(20000) });
        var result = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(result.error || 'Could not change the name. Please try again.');
        var next = personalUrl(result.renamedTo);
        state = result; state.savedUrl = null;
        if (next) { state.addressName = new URL(next).hostname.split('.')[0]; state.ownershipConfirmed = true; }
        renamed = next ? 'Your ClosedHand is now at ' + new URL(next).hostname + '. It takes about a minute to connect there, and the old address sends people to it for 30 days.' : null;
        $('url-rename-form').hidden = true;
      } catch (e) { actionError = e.message; }
      finally { renaming = false; lastCheck = 0; display(); }
    });
    $('url-continue').addEventListener('click', function () {
      if (!password) return;
      remember();
    });
    $('url-copy').addEventListener('click', async function () {
      var value = $('url-value').value;
      if (!value) return;
      try {
        if (!navigator.clipboard) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(value);
        $('url-copy-status').hidden = false;
        $('url-copy-status').textContent = 'Copied.';
      } catch (_) {
        $('url-value').focus(); $('url-value').select();
        $('url-copy-status').hidden = false;
        $('url-copy-status').textContent = document.execCommand('copy') ? 'Copied.' : 'Select and copy your personal URL above.';
      }
    });
    return {
      update: function (installId, hasPassword, account) {
        signin = account || null;
        var nextKey = installId ? 'ch-setup-personal-url:' + installId : null;
        if (nextKey !== key) {
          key = nextKey; generation++; state = {}; actionError = null; busy = false; lastCheck = 0; completedReady = false;
          try { settled = !!key && localStorage.getItem(key) === 'done'; } catch (_) { settled = false; }
        }
        password = hasPassword;
        display();
        if (handed && password) {
          var given = handed; handed = null;
          try { container.scrollIntoView({ block: 'center' }); } catch (_) {}
          submitCode(given);
        } else check();
      },
      settled: function () { return settled; }
    };
  }
  root.ClosedHandSetupUrl = { mount: mount };
})(window);
