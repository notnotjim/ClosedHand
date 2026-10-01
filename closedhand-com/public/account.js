// The ClosedHand account page: which sign-in it is, the personal URL it
// holds, and deleting it. Deleting here can't reach the computer running
// ClosedHand, so it says plainly what stays there.
(() => {
  const $ = id => document.getElementById(id);
  const say = (text, warn) => { $('status').textContent = text || ''; $('status').classList.toggle('warn', !!warn); };
  const providerName = p => p === 'microsoft' ? 'Microsoft' : 'Google';
  const show = screen => { for (const id of ['signed-out', 'details', 'deleted']) $(id).hidden = id !== screen; };
  let data = null;
  async function load() {
    try {
      const response = await fetch('/api/account', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      data = await response.json();
    } catch (_) { show(null); say('Could not look up your account. Please try again.', true); return; }
    say('');
    if (!data.signedIn) return show('signed-out');
    show('details');
    $('acct-address').textContent = data.address || 'No personal URL yet';
    $('acct-address-note').textContent = data.address ? 'Your personal URL' : 'Setup on your computer gives ClosedHand one.';
    $('acct-who').textContent = providerName(data.provider) + (data.email ? ': ' + data.email : '');
  }
  $('delete').addEventListener('click', () => {
    const text = $('confirm-text');
    text.textContent = '';
    if (data.address) {
      const name = document.createElement('strong');
      name.className = 'nowrap'; name.textContent = data.address;
      text.append('This deletes your ClosedHand account. ', name, ' stops working and closedhand.com forgets your sign-in. Nobody can take the name for six months, and nothing links it to you. ClosedHand keeps everything on your computer; to delete that too, use Delete account in its Settings.');
    } else text.textContent = 'This deletes your ClosedHand account, and closedhand.com forgets your sign-in.';
    $('delete').hidden = true; $('confirm').hidden = false; $('delete-go').focus();
  });
  $('delete-cancel').addEventListener('click', () => { $('confirm').hidden = true; $('delete').hidden = false; $('delete').focus(); });
  $('delete-go').addEventListener('click', async () => {
    $('delete-go').disabled = true; say('Deleting…');
    try {
      const response = await fetch('/api/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not delete your account. Please try again.');
      show('deleted'); say('');
    } catch (e) { say(e.message, true); $('delete-go').disabled = false; }
  });
  load();
})();
