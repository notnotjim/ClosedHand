// The Closedhand account page: which sign-in it is, the personal URL it
// holds, and deleting it. Deleting here can't reach the computer running
// Closedhand, so it says plainly what stays there.
(() => {
  const $ = id => document.getElementById(id);
  const say = (text, warn) => { $('status').textContent = text || ''; $('status').classList.toggle('warn', !!warn); };
  const providerName = p => p === 'microsoft' ? 'Microsoft' : 'Google';
  const show = screen => {
    for (const id of ['signed-out', 'details', 'deleted']) $(id).hidden = id !== screen;
    $('plus').hidden = screen !== 'details' || !data?.plus?.available;
  };
  let data = null;
  async function load() {
    try {
      const response = await fetch('/api/account', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      data = await response.json();
    } catch (_) { show(null); say('Could not look up your account. Please try again.', true); return; }
    say(welcome);
    if (!data.signedIn) return show('signed-out');
    show('details');
    $('acct-address').textContent = data.address || 'No personal URL yet';
    $('acct-address-note').textContent = data.address ? 'Your personal URL' : 'Setup on your computer gives Closedhand one.';
    $('acct-who').textContent = providerName(data.provider) + (data.email ? ': ' + data.email : '');
    plus();
  }

  // Closedhand+: what it is and the way in, or when it renews and the way to
  // manage it. Prices are in the person's currency, as Polar will charge.
  const day = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  function plus() {
    const p = data.plus || {}, prices = p.prices || {};
    if (!p.available) return;
    const email = data.plan?.email;
    $('plus-about').textContent = 'Closedhand Managed Models every month, so Closedhand never needs an API key from you'
      + (email ? ", and Closedhand's own email with no monthly limit" : '') + '. Closedhand also works with your own LLM provider, free ones included.';
    $('plus-get').hidden = p.active;
    $('plus-get').textContent = 'Get Closedhand+' + (prices.plus ? ' · ' + prices.plus + ' a month' : '');
    $('plus-manage').hidden = !p.active;
    const state = [];
    if (p.active && p.ends_at) state.push('Your Closedhand+ ends on ' + day(p.ends_at) + '.');
    else if (p.active && p.renews_at) state.push('Your Closedhand+ renews on ' + day(p.renews_at) + '.');
    if (p.active && p.nearly) state.push(p.extended ? "You've used most of this month's fair use, carried on to the end of the month." : "You've used most of this month's fair use.");
    $('plus-state').textContent = state.join(' ');
    $('plus-state').hidden = !state.length;
    $('plus-extend').hidden = !(p.active && p.nearly && !p.extended);
    $('plus-extend').textContent = 'Carry on to the end of the month' + (prices.extend ? ' · ' + prices.extend : '');
    $('plus-fine').textContent = p.active
      ? "Change your card, see your invoices or cancel on Polar's page. Cancelling keeps Closedhand+ to the end of the month you've paid for."
      : "Payments go through Polar. Cancel any time: Closedhand+ runs to the end of the month you've paid for.";
  }
  // Each button asks closedhand.com for Polar's page and goes there.
  async function goTo(path, button) {
    button.disabled = true; say('Opening…');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.url) throw new Error(result.error || 'Could not reach the payment service just now. Please try again.');
      location.assign(result.url);
    } catch (e) { say(e.message, true); button.disabled = false; }
  }
  $('plus-get').addEventListener('click', () => goTo('/api/plus/checkout', $('plus-get')));
  $('plus-extend').addEventListener('click', () => goTo('/api/plus/extend', $('plus-extend')));
  $('plus-manage').addEventListener('click', () => goTo('/api/plus/manage', $('plus-manage')));
  // Back from Polar's checkout.
  const back = new URLSearchParams(location.search).get('plus');
  const welcome = back === 'welcome' ? 'Welcome to Closedhand+. Your Closedhand picks it up within the hour.'
    : back === 'extended' ? 'Done: you can carry on to the end of the month.' : '';
  $('delete').addEventListener('click', () => {
    const text = $('confirm-text');
    text.textContent = '';
    if (data.address) {
      const name = document.createElement('strong');
      name.className = 'nowrap'; name.textContent = data.address;
      text.append('This deletes your Closedhand account. ', name, ' stops working and closedhand.com forgets your sign-in. Nobody can take the name for six months, and nothing links it to you. Closedhand keeps everything on your computer; to delete that too, use Delete account in its Settings.');
    } else text.textContent = 'This deletes your Closedhand account, and closedhand.com forgets your sign-in.';
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
