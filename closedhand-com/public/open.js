(() => {
  const $ = id => document.getElementById(id), navigation = window.ClosedHandEntry;
  const next = navigation.destination(location), query = new URLSearchParams(location.search);
  const failedSignIn = query.has('sign_in_error') || query.has('error');
  let automatic = query.get('choose') !== '1' && !failedSignIn;
  $('url-help').open = !automatic;
  $('local-help').open = false;
  const back = encodeURIComponent('/open?next=' + encodeURIComponent(next));
  $('login').href = '/auth/google?return_to=' + back;
  $('login-microsoft').href = '/auth/microsoft?return_to=' + back;
  $('address').addEventListener('input', () => { automatic = false; $('address-error').hidden = true; });
  $('address-form').addEventListener('submit', event => {
    event.preventDefault(); automatic = false;
    const url = navigation.address($('address').value);
    if (!url) { $('address-error').textContent = 'Enter your personal URL, such as name.closedhand.ai.'; $('address-error').hidden = false; $('address').focus(); return; }
    location.assign(next === '/' ? url : new URL(next, url).href);
  });
  let checking = false;
  async function check() {
    if (checking) return;
    checking = true; $('retry').hidden = true;
    try {
      const response = await fetch('/api/account', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not look up your personal URL. Try again, or enter your personal URL below.');
      const data = await response.json();
      const ready = navigation.registeredAddress(data.url);
      $('opening').hidden = !ready;
      $('finder').hidden = ready && automatic;
      $('login').textContent = data.signedIn ? 'Use a different Google account' : 'Find my personal URL with Google';
      $('login-microsoft').textContent = data.signedIn ? 'Use a different Microsoft account' : 'Find it with a Microsoft account instead';
      if (ready) {
        $('local-help').open = false;
        $('url-help').open = !automatic;
        const url = new URL(next, data.url).href;
        $('dashboard').href = url;
        $('status').textContent = automatic ? 'Opening ClosedHand at ' + new URL(data.url).hostname + '…' : 'Your personal URL is ' + new URL(data.url).hostname + '.';
        if (automatic) location.replace(url);
      } else {
        if (data.signedIn && data.available && automatic) $('local-help').open = true;
        $('status').textContent = !data.available
          ? 'Personal URL lookup is not available right now. You can enter your personal URL below.'
          : data.signedIn ? 'No personal URL was found for this account. Open ClosedHand on the computer where it is installed, or use a personal URL linked to another account.'
          : 'Open ClosedHand on the computer where it is installed, or use your personal URL from any device.';
        $('retry').hidden = !!data.available;
        if (!data.available) $('url-help').open = true;
      }
      if (failedSignIn) { $('url-help').open = true; $('status').textContent = 'Sign-in did not finish. Try again, or enter your personal URL below.'; }
    } catch (error) { $('url-help').open = true; $('finder').hidden = false; $('status').textContent = error.message; $('retry').hidden = false; }
    finally { checking = false; }
  }
  $('retry').onclick = check;
  window.addEventListener('focus', check);
  check();
})();
