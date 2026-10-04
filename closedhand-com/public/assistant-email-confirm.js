// Confirming a ClosedHand assistant's email address. The ClosedHand that
// asked opened this page with a signed ticket after the #; the owner signs in
// with the account they will email the assistant from, then confirms. Only a
// Google address Google has verified, or a personal Microsoft account, is
// accepted, since the assistant's private replies go there.
(() => {
  const $ = id => document.getElementById(id);
  const ticket = location.hash.slice(1);
  const here = '/assistant-email/confirm' + location.hash;
  const status = $('status');
  // The assistant's name travels in the signed link from its ClosedHand.
  let name = '';
  try { name = String(JSON.parse(atob(ticket.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).name || '').slice(0, 60); } catch (_) {}
  if (name) {
    const whose = name + '’s';
    $('heading').textContent = 'Set up ' + whose + ' email address';
    $('lede').textContent = name + ' is getting its own email address, so you can email it, forward things to it and copy it in. Sign in with the account you’ll email it from: its private replies go there.';
    $('who-label').textContent = whose + ' private replies go to';
    $('approve').textContent = 'Create ' + whose + ' email address';
    $('address-note').textContent = whose + ' email address';
  }
  $('login-google').href = '/auth/google?return_to=' + encodeURIComponent(here);
  $('login-microsoft').href = '/auth/microsoft?return_to=' + encodeURIComponent(here);
  async function request(path, body) {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not confirm this address. Please try again.');
    return data;
  }
  if (!ticket) { status.textContent = 'Turn on your assistant’s email address in your ClosedHand’s Settings first.'; return; }
  request('/api/account').then(account => {
    // Signed in, but with an address the provider has not vouched for here:
    // an older sign-in, or a work account. Sign in again, or with another.
    if (account.signedIn && !account.emailVerified) {
      $('signin-heading').textContent = 'Sign in again to confirm it';
      $('signin-note').textContent = (account.email ? account.email + ' needs' : 'Your account needs') + ' a fresh sign-in, so Google or Microsoft can confirm it is your address. Work Microsoft accounts can’t be used here; a personal one or Google can.';
    }
    if (!account.signedIn || !account.emailVerified) {
      $('signin').hidden = false;
      status.textContent = '';
      return;
    }
    $('who').textContent = account.email || '';
    $('switch').href = '/auth/' + (account.provider === 'microsoft' ? 'microsoft' : 'google') + '?return_to=' + encodeURIComponent(here);
    $('confirm').hidden = false;
    status.textContent = '';
  }).catch(e => { status.textContent = e.message; });
  $('approve').onclick = async () => {
    $('approve').disabled = true;
    status.textContent = 'Confirming…';
    try {
      const data = await request('/api/assistant-mail-relay/approve', { ticket });
      $('heading').textContent = 'Email address confirmed';
      $('lede').hidden = true;
      $('address').textContent = data.address;
      $('address').hidden = $('address-note').hidden = false;
      $('confirm').hidden = true;
      $('done-note').textContent = (name || 'Its') + (name ? '’s' : '') + ' private replies go to ' + data.email + '. The ClosedHand tab where you started updates by itself, so you can close this one.';
      $('done').hidden = false;
      status.textContent = '';
    } catch (e) {
      status.textContent = e.message;
      $('approve').disabled = false;
    }
  };
})();
