// "On your phone?": tapping Mac app or Docker on a phone or tablet, where
// Closedhand can't be installed. It helps get the link to a computer: the
// phone's own share sheet (AirDrop to a Mac, Messages, Mail), Copy link, or,
// optionally, one email with the link. Used by the home page and /open.
(function () {
  var ways = document.querySelectorAll('.get-it-way[data-get]');
  var probe = document.createElement('dialog');
  if (!ways.length || typeof probe.showModal !== 'function') return;
  var LINK = 'https://closedhand.com/';

  var sheet = document.createElement('dialog');
  sheet.className = 'get-sheet'; sheet.id = 'getSheet'; sheet.tabIndex = -1;
  sheet.setAttribute('aria-labelledby', 'getSheetTitle');
  sheet.innerHTML =
    '<button type="button" class="get-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
    '<svg class="get-sheet-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="12.5" rx="1.8"/><path d="M8.5 20h7M12 16.5V20"/></svg>' +
    '<h2 id="getSheetTitle">On your phone?</h2>' +
    '<p class="get-sheet-text">Your Closedhand assistant lives on a computer or a server you rent, and you use it from here. Set it up there first.</p>' +
    '<button type="button" class="get-sheet-send" hidden>Send link</button>' +
    '<button type="button" class="get-sheet-copy"><span>closedhand.com</span><strong>Copy link</strong></button>' +
    '<form class="get-sheet-mail" novalidate hidden>' +
      '<p class="get-sheet-or">Or email it to yourself</p>' +
      '<div class="get-sheet-field"><input type="email" name="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-label="Your email address" maxlength="254"><button type="submit">Send</button></div>' +
      '<input class="get-sheet-trap" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<p class="get-sheet-note" role="status">This sends just one email and we don’t keep your address.</p>' +
    '</form>';
  document.body.appendChild(sheet);
  var $ = function (s) { return sheet.querySelector(s); };
  var send = $('.get-sheet-send'), copy = $('.get-sheet-copy');
  var form = $('.get-sheet-mail'), input = form.querySelector('input[name=email]'), note = $('.get-sheet-note');
  var NOTE = note.textContent;

  send.hidden = !navigator.share;
  if (Math.min(screen.width, screen.height) >= 600) $('#getSheetTitle').textContent = 'On your tablet?';

  // The email option shows only while closedhand.com can send it.
  var asked = false;
  function checkMail() {
    if (asked) return;
    asked = true;
    fetch('/api/download-link/availability', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { form.hidden = !(d && d.available); })
      .catch(function () {});
  }

  ways.forEach(function (way) {
    way.addEventListener('click', function () {
      copy.classList.remove('done'); copy.querySelector('strong').textContent = 'Copy link';
      checkMail();
      sheet.showModal();
      sheet.focus();   // not the close button, which would show its focus ring
    });
  });
  send.addEventListener('click', function () {
    navigator.share({ title: 'Closedhand', url: LINK }).catch(function () {});
  });
  copy.addEventListener('click', function () {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(LINK).then(function () {
      copy.classList.add('done'); copy.querySelector('strong').textContent = 'Copied';
    }, function () {});
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var button = form.querySelector('button');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value.trim())) {
      note.textContent = 'That doesn’t look like an email address.'; note.classList.add('warn'); input.focus(); return;
    }
    button.disabled = true; note.classList.remove('warn'); note.textContent = 'Sending…';
    fetch('/api/download-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: input.value.trim(), website: form.elements.website.value })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) {
        if (r.ok) { note.textContent = 'Sent. Open it on your computer.'; input.value = ''; }
        else { note.textContent = (r.d && r.d.error) || 'That didn’t send just now.'; note.classList.add('warn'); }
      })
      .catch(function () { note.textContent = 'That didn’t send just now. Send link or Copy link still work.'; note.classList.add('warn'); })
      .then(function () { button.disabled = false; });
  });
  input.addEventListener('input', function () { note.textContent = NOTE; note.classList.remove('warn'); });
  $('.get-sheet-close').addEventListener('click', function () { sheet.close(); });
  // A tap outside the sheet closes it.
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });
})();
