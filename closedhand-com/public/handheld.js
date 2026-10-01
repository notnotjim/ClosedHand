// Phones and tablets can't run ClosedHand. Pages mark them (html.handheld)
// before anything is drawn, so there they lead with opening the ClosedHand
// someone already has, and send newcomers to a computer instead of offering
// downloads. iPads that report as a Mac are caught by their touch screen.
(function () {
  var ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    document.documentElement.classList.add('handheld');
  }
})();
