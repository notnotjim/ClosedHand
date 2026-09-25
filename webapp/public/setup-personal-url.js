/* Optional personal URL setup. Password and server readiness remain independent. */
(function (root) {
  'use strict';
  function mount(container, changed) {
    var $ = function (id) { return container.querySelector('#' + id); };
    var key = null, password = false, settled = false, state = {}, busy = false, checking = false;
    var lastCheck = 0, generation = 0, actionError = null, completedReady = false;
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
    function pairingUrl(value) {
      try {
        var u = new URL(value);
        return u.origin === 'https://closedhand.com' && u.pathname === '/phone-access/pair' ? u.href : null;
      } catch (_) { return null; }
    }
    function display() {
      $('url-password-note').hidden = password;
      $('url-controls').hidden = !password;
      var saved = personalUrl(state.permanent && state.url || state.savedUrl);
      var confirm = pairingUrl(state.pairingUrl);
      var confirmed = state.enabled && state.ownershipConfirmed;
      var reserved = confirmed && personalUrl('https://' + state.addressName + '.closedhand.ai');
      $('url-form').hidden = !!(saved || confirmed);
      $('url-saved').hidden = !password || !(saved || reserved);
      $('url-value').value = saved || reserved || '';
      $('url-copy').hidden = !saved;
      if (!$('url-name').value && /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(state.addressName || '')) {
        $('url-name').value = state.addressName;
        $('url-preview').textContent = 'https://' + state.addressName + '.closedhand.ai';
      }
      $('url-start').disabled = busy || !password;
      $('url-start').textContent = busy ? 'Opening…' : 'Confirm with Google';
      $('url-start').formNoValidate = !!confirm;
      $('url-status').textContent = actionError || state.error || (saved
        ? (state.state === 'on' ? 'Your personal URL is ready. Use your dashboard password to open it.' : 'Your personal URL is saved. ClosedHand is not connected to it yet. You can continue setup here.')
        : confirmed ? (state.registrationState === 'error'
          ? 'Your personal URL is confirmed, but its connection is delayed. ClosedHand will retry automatically.'
          : 'Your personal URL is confirmed. Connecting it now. You can continue setup.')
        : confirm ? 'Waiting for Google confirmation.'
        : state.enabled ? 'Connecting your personal URL. You can continue setup while it connects.' : '');
      $('url-continue').textContent = saved || confirmed ? 'Continue setup' : state.enabled ? 'Continue setup while this finishes' : 'Continue without a personal URL';
    }
    async function request(method, body) {
      var response = await fetch('/api/phone', { method: method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        var failure = await response.json().catch(function () { return {}; });
        throw new Error(failure.error || 'Could not check your personal URL. Try again, or continue setup without one.');
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
          display();
          if (password && !completedReady && state.state === 'on' && personalUrl(state.permanent && state.url || state.savedUrl)) {
            completedReady = true;
            remember();
          }
        }
      }
    }
    $('url-name').addEventListener('input', function () {
      actionError = null;
      $('url-preview').textContent = 'https://' + ($('url-name').value.trim().toLowerCase() || 'your-name') + '.closedhand.ai';
    });
    $('url-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!password || busy) return;
      var name = $('url-name').value.trim().toLowerCase();
      if (!(pairingUrl(state.pairingUrl) && !name) && !/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) {
        state.error = 'Use 3 to 32 letters, numbers or hyphens, starting with a letter and ending with a letter or number.';
        display(); return;
      }
      // Open during the click, before awaiting the fresh ticket, so browsers
      // do not mistake the confirmation tab for an unsolicited popup.
      var confirmationTab = window.open('about:blank', '_blank');
      if (confirmationTab) confirmationTab.opener = null;
      busy = true; actionError = null; var run = ++generation; display();
      try {
        var result = await request('POST', { enabled: true, mode: 'managed', addressName: name || undefined });
        if (run !== generation) { if (confirmationTab) confirmationTab.close(); return; }
        state = result;
        var destination = pairingUrl(state.pairingUrl);
        if (!destination) throw new Error('Could not open Google confirmation. Please try again.');
        if (confirmationTab && !confirmationTab.closed) confirmationTab.location.replace(destination);
        else window.location.assign(destination);
      } catch (e) {
        if (confirmationTab) confirmationTab.close();
        if (run === generation) actionError = e.message;
      } finally { if (run === generation) { busy = false; lastCheck = 0; display(); } }
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
      update: function (installId, hasPassword) {
        var nextKey = installId ? 'ch-setup-personal-url:' + installId : null;
        if (nextKey !== key) {
          key = nextKey; generation++; state = {}; actionError = null; busy = false; lastCheck = 0; completedReady = false;
          try { settled = !!key && localStorage.getItem(key) === 'done'; } catch (_) { settled = false; }
        }
        password = hasPassword;
        display(); check();
      },
      settled: function () { return settled; }
    };
  }
  root.ClosedHandSetupUrl = { mount: mount };
})(window);
