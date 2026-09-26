// "Send to my computer": a newcomer on a phone can't download ClosedHand
// there, so they send closedhand.com to a computer that can, with the
// phone's own share sheet (AirDrop, Messages, Mail). Nothing goes through
// ClosedHand. Without a share sheet the link is copied instead.
(function () {
  var url = 'https://closedhand.com/';
  document.querySelectorAll('[data-send-to-computer]').forEach(function (button) {
    var note = document.getElementById(button.getAttribute('data-send-to-computer'));
    function tell(text) { if (note) { note.textContent = text; note.hidden = false; } }
    button.addEventListener('click', function () {
      if (navigator.share) {
        navigator.share({ title: 'ClosedHand', url: url })
          .then(function () { tell('Open it on your computer to download ClosedHand.'); })
          .catch(function (e) { if (!e || e.name !== 'AbortError') tell('Open closedhand.com on your computer to download ClosedHand.'); });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url)
          .then(function () { tell('Link copied. Open it on your computer to download ClosedHand.'); })
          .catch(function () { tell('Open closedhand.com on your computer to download ClosedHand.'); });
      } else {
        tell('Open closedhand.com on your computer to download ClosedHand.');
      }
    });
  });
})();
