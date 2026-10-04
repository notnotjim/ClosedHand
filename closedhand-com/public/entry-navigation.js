// Where a page may send someone next. Loaded by the browser as
// window.ClosedHandEntry and by the server to check sign-in return paths.
(function () {
  const origin = 'https://closedhand.com';
  function localPath(value, allowed, fallback) {
    if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || /[\\\x00-\x20]/.test(value)) return fallback;
    try {
      const url = new URL(value, origin);
      return url.origin === origin && allowed.includes(url.pathname) ? url.pathname + url.search + url.hash : fallback;
    } catch (_) { return fallback; }
  }
  function signInReturn(value) { return localPath(value, ['/open', '/phone-access/pair', '/account', '/assistant-email/confirm'], '/open'); }
  function signInError(value) {
    const url = new URL(signInReturn(value), origin);
    url.searchParams.set('sign_in_error', '1');
    return url.pathname + url.search + url.hash;
  }
  function destination(location) {
    const next = new URLSearchParams(location.search).get('next');
    if (next) return localPath(next, ['/', '/dashboard', '/keep'], '/');
    if (location.pathname === '/keep') return '/keep';
    if (location.pathname === '/dashboard' && (location.search || location.hash)) return '/dashboard' + location.search + location.hash;
    return location.hash ? '/dashboard' + location.hash : '/';
  }
  function registeredAddress(value) {
    return typeof value === 'string' && /^https:\/\/[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(value);
  }
  function address(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 2048 || /[\\\x00-\x20]/.test(text)) return null;
    let input = text;
    if (/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/i.test(input) && input.toLowerCase() !== 'localhost') input += '.closedhand.ai';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = (/^(localhost|127\.0\.0\.1)([:/]|$)/i.test(input) ? 'http://' : 'https://') + input;
    try {
      const url = new URL(input);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      if (!url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.startsWith('[')) return null;
      if (['closedhand.com', 'www.closedhand.com', 'closedhand.ai', 'www.closedhand.ai'].includes(url.hostname)) return null;
      return url.href;
    } catch (_) { return null; }
  }
  // Which screen My ClosedHand (/open) shows. A newcomer has no sign of
  // ClosedHand: not signed in, not sent from it, never opened a personal URL
  // from this browser, and nothing answering on this computer. Signed in
  // without a personal URL means Setup isn't finished: it gives every
  // ClosedHand its address.
  function isNewcomer({ signedIn, choosing, failedSignIn, next, known, nothingHere }) {
    return !signedIn && !choosing && !failedSignIn && next === '/' && !known && !!nothingHere;
  }
  function openScreen({ newcomer, signedIn, found, available, choosing, failedSignIn }) {
    if (newcomer) return 'new';
    if (!signedIn || choosing || failedSignIn || (!found && !available)) return 'find';
    return found ? 'found' : 'not-set-up';
  }
  // ClosedHand on this computer, for when the page can't see it (Safari, or
  // Chrome's question declined): Docker and the Mac app use this port.
  const LOCAL = 'http://localhost:3000';
  const api = { signInReturn, signInError, destination, registeredAddress, address, isNewcomer, openScreen, LOCAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ClosedHandEntry = api;
})();
