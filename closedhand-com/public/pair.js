(() => {
  let ticket = '';
  try { ticket = decodeURIComponent(location.hash.slice(1)); } catch (_) {}
  const $ = id => document.getElementById(id);
  const status = $('status'), approve = $('approve'), login = $('login'), other = $('other'), back = $('return');
  const here = '/phone-access/pair#' + encodeURIComponent(ticket);
  login.href = '/auth/google?return_to=' + encodeURIComponent(here);
  $('login-microsoft').href = '/auth/microsoft?return_to=' + encodeURIComponent(here);
  const validUrl = value => /^https:\/\/[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(value || '');
  const providerName = p => p === 'microsoft' ? 'Microsoft' : 'Google';
  let timer, approvedAt = 0, busy = false, leaving = false;
  async function request(path, body) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not check your personal URL. Please try again.');
    return data;
  }
  function confirmed(data) {
    approvedAt = approvedAt || Date.now();
    approve.hidden = login.hidden = other.hidden = $('consent').hidden = $('explanation').hidden = true;
    $('heading').textContent = 'Personal URL confirmed';
    if (data.state === 'active' && validUrl(data.url)) {
      clearTimeout(timer);
      back.href = data.url + '/'; back.hidden = false;
      // Active means the exact ClosedHand that asked has answered at this
      // address. Never open an address that is only reserved.
      if (!leaving) {
        leaving = true;
        status.textContent = 'Confirmed. Opening ClosedHand…';
        timer = setTimeout(() => location.replace(back.href), 1200);
      }
      return;
    }
    status.textContent = data.state === 'error'
      ? 'Your personal URL is confirmed, but its connection is delayed. We are retrying automatically.'
      : Date.now() - approvedAt > 90000
        ? 'Your personal URL is confirmed. Keep ClosedHand running while it connects. You can continue setup in your original tab.'
        : 'Confirmed. Connecting your personal URL, then opening ClosedHand…';
    timer = setTimeout(check, 3000);
  }
  async function check() {
    clearTimeout(timer);
    if (busy || leaving) return;
    try {
      const account = await request('/api/account');
      if (!account.available) throw new Error('Personal URLs are not available right now. You can still use ClosedHand on the computer or server running it.');
      $('account').hidden = !account.signedIn;
      $('account').textContent = account.signedIn ? providerName(account.provider) + ' account: ' + (account.email || 'signed in') : '';
      const address = await request('/api/phone-enrollment/details', { ticket });
      $('requested-address').textContent = address.url;
      if (account.signedIn && ['pending', 'provisioning', 'connecting', 'active', 'error'].includes(address.state)) { confirmed(address); return; }
      if (address.state === 'revoked') throw new Error('This personal URL was removed. Start again in ClosedHand.');
      if (validUrl(account.url)) {
        approve.hidden = login.hidden = other.hidden = true;
        back.href = account.url + '/dashboard#dashboard-link'; back.hidden = false;
        back.textContent = 'Open Personal URL settings';
        status.textContent = 'This account already owns a personal URL.';
        return;
      }
      // Google first, Microsoft as the alternative, before and after sign-in.
      login.hidden = other.hidden = false;
      login.className = account.signedIn ? '' : 'button primary';
      login.textContent = account.signedIn ? 'Use a different Google account' : 'Sign in with Google';
      $('login-microsoft').textContent = account.signedIn ? 'Use a different Microsoft account' : 'Use a Microsoft account instead';
      approve.hidden = approve.disabled = !account.signedIn;
      status.textContent = new URLSearchParams(location.search).has('sign_in_error')
        ? 'Sign-in did not finish. Please try again.'
        : account.signedIn ? 'This ' + providerName(account.provider) + ' account will own your personal URL.' : 'Sign in to confirm that this personal URL is yours.';
      if (!account.signedIn) timer = setTimeout(check, 3000);
    } catch (e) {
      status.textContent = e.message;
      if (approvedAt) timer = setTimeout(check, 5000);
    }
  }
  approve.onclick = async () => {
    if (busy) return;
    clearTimeout(timer); busy = true; approve.disabled = true;
    status.textContent = 'Confirming your personal URL…';
    try { confirmed(await request('/api/phone-enrollment/approve', { ticket })); }
    catch (e) { status.textContent = e.message; approve.disabled = false; }
    finally { busy = false; }
  };
  if (!ticket) status.textContent = 'Choose a personal URL in ClosedHand, during setup or in Settings, then confirm it here.';
  else check();
})();
