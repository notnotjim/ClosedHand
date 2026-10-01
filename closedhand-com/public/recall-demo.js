(function () {
  'use strict';
  var demo = document.getElementById('recallDemo');
  if (!demo || !Element.prototype.animate) return;
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var other = demo.querySelector('.recall-lane-other'), ready = demo.querySelector('.recall-lane-ready');
  var timers = [], flights = [], visible = false, running = false;
  // Slow enough to follow each trip. Both questions leave together; the dial
  // on each side sweeps until that side's answer lands.
  var start = 400, scale = 10500, cycle = 13800;
  var answered = {other: 9900, ready: 4200};
  // Positions come from the rendered layout, so the wires and moving tokens
  // follow the same route at every width.
  function box(lane, selector) {
    var l = lane.getBoundingClientRect(), r = lane.querySelector(selector).getBoundingClientRect();
    return {x: r.left - l.left + r.width / 2, top: r.top - l.top, bottom: r.bottom - l.top,
      y: r.top - l.top + r.height / 2, left: r.left - l.left, right: r.right - l.left};
  }
  function route(lane) {
    var q = box(lane, '.recall-q'), b = box(lane, '.recall-box'), ai = box(lane, '.recall-ai'), a = box(lane, '.recall-a');
    var p = {q: [q.x, q.bottom], ai: [ai.x, ai.y], aiTop: [ai.x, ai.top], answer: [a.x, a.top]};
    if (lane === ready) {
      p.ask = [p.q, [b.x, b.y]];
      p.wires = ['M' + q.x + ' ' + q.bottom + 'V' + b.top, 'M' + b.x + ' ' + b.bottom + 'V' + ai.top, 'M' + ai.x + ' ' + ai.bottom + 'V' + a.top];
      p.box = [b.x, b.y];
    } else {
      // The question bypasses the apps and goes straight to the AI.
      var rail = Math.min(b.right + 16, lane.clientWidth - 8), turn = q.bottom + (b.top - q.bottom) / 2;
      p.ask = [p.q, [q.x, turn], [rail, turn], [rail, ai.y], [ai.right, ai.y]];
      p.wires = ['M' + q.x + ' ' + q.bottom + 'V' + turn + 'H' + rail + 'V' + ai.y + 'H' + ai.right,
        'M' + ai.x + ' ' + ai.top + 'V' + b.bottom, 'M' + ai.x + ' ' + ai.bottom + 'V' + a.top];
    }
    return p;
  }
  function wires(lane) {
    var svg = lane.querySelector('.recall-wires');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'recall-wires'); svg.setAttribute('aria-hidden', 'true');
      lane.insertBefore(svg, lane.firstChild);
    }
    svg.innerHTML = route(lane).wires.map(function (d) { return '<path d="' + d + '"/>'; }).join('');
    // Typing dots sit where the answer will appear, until it does.
    var dots = lane.querySelector('.recall-wait'), a = lane.querySelector('.recall-a');
    if (!dots) {
      dots = document.createElement('span');
      dots.className = 'recall-wait'; dots.setAttribute('aria-hidden', 'true');
      dots.innerHTML = '<span>.</span><span>.</span><span>.</span>';
      lane.appendChild(dots);
    }
    dots.style.left = a.offsetLeft + a.offsetWidth / 2 + 'px';
    dots.style.top = a.offsetTop + a.offsetHeight / 2 + 'px';
  }
  function at(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function fly(el, points, when, duration, path) {
    at(when, function () {
      var total = 0, lengths = [0];
      for (var i = 1; i < points.length; i++) {
        total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        lengths.push(total);
      }
      // Offsets follow distance so the token keeps an even pace round corners.
      var frames = points.map(function (pt, i) {
        return {offset: total ? lengths[i] / total : i / (points.length - 1), transform: 'translate(' + pt[0] + 'px,' + pt[1] + 'px)', opacity: 1};
      });
      flights.push(el.animate(frames, {duration: duration, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards'}));
      if (path) light(path, duration);
    });
  }
  // The wire a token is travelling brightens for the length of the trip.
  function light(path, duration) {
    path.classList.add('is-live');
    timers.push(setTimeout(function () { path.classList.remove('is-live'); }, duration + 150));
  }
  function wire(lane, i) { return lane.querySelectorAll('.recall-wires path')[i]; }
  function hide(el, when) { at(when, function () { flights.push(el.animate([{opacity: 1}, {opacity: 0}], {duration: 350, fill: 'forwards'})); }); }
  function cls(el, add, remove) { if (remove) el.classList.remove(remove); if (add) el.classList.add(add); }
  function all(lane, selector) { return Array.prototype.slice.call(lane.querySelectorAll(selector)); }
  function clearFlights() { flights.forEach(function (f) { f.cancel(); }); flights = []; }
  function reset() {
    [other, ready].forEach(function (lane) {
      all(lane, '.recall-app').forEach(function (a) { a.className = 'recall-app'; });
      cls(lane.querySelector('.recall-a'), null, 'is-shown');
      cls(lane.querySelector('.recall-wait'), null, 'is-on');
      cls(lane.querySelector('.recall-ai'), null, 'is-busy');
      cls(lane.querySelector('.recall-fetch'), null, 'is-found');
      var dial = lane.querySelector('.recall-timer'); dial.style.transition = 'none'; dial.style.setProperty('--done', '0');
      all(lane, '.recall-wires path').forEach(function (w) { w.classList.remove('is-live'); });
    });
    demo.classList.remove('is-resetting');
  }
  function dial(lane, key) {
    var dots = lane.querySelector('.recall-wait');
    at(start, function () { cls(dots, 'is-on'); });
    at(answered[key], function () { cls(dots, null, 'is-on'); });
    at(start, function () {
      var d = lane.querySelector('.recall-timer');
      d.style.transition = '--done ' + (answered[key] - start) + 'ms linear';
      d.style.setProperty('--done', String((answered[key] - start) / scale));
    });
  }
  function playReady() {
    var p = route(ready), token = ready.querySelector('.recall-token:not(.recall-fetch)'), packet = ready.querySelector('.recall-fetch');
    var ai = ready.querySelector('.recall-ai');
    fly(token, p.ask, start, 1400, wire(ready, 0)); hide(token, 1800);
    at(1900, function () {
      all(ready, '.recall-app[data-relevant]').forEach(function (a) { cls(a, 'is-match'); });
      all(ready, '.recall-app:not([data-relevant])').forEach(function (a) { cls(a, 'is-quiet'); });
    });
    fly(packet, [p.box, p.ai], 2500, 1000, wire(ready, 1)); hide(packet, 3500);
    at(3400, function () { cls(ai, 'is-busy'); });
    fly(packet, [p.ai, p.answer], 3700, 500, wire(ready, 2)); hide(packet, answered.ready);
    at(answered.ready, function () { cls(ai, null, 'is-busy'); cls(ready.querySelector('.recall-a'), 'is-shown'); });
    dial(ready, 'ready');
  }
  function playOther() {
    var p = route(other), token = other.querySelector('.recall-token:not(.recall-fetch)'), fetch = other.querySelector('.recall-fetch');
    var ai = other.querySelector('.recall-ai');
    fly(token, p.ask, start, 2200, wire(other, 0)); hide(token, 2600);
    at(2600, function () { cls(ai, 'is-busy'); });
    // The AI picks two apps and asks them one at a time.
    [['calendar', 3400, true], ['mail', 6300, false]].forEach(function (trip) {
      var app = other.querySelector('[data-app="' + trip[0] + '"]'), t = trip[1];
      var c = box(other, '[data-app="' + trip[0] + '"]'), spot = [c.x, c.y];
      at(t, function () { cls(fetch, null, 'is-found'); });
      fly(fetch, [p.aiTop, spot], t, 1000, wire(other, 1));
      at(t + 1000, function () { cls(app, 'is-searching'); });
      at(t + 1800, function () { cls(app, trip[2] ? 'is-match' : 'is-checked', 'is-searching'); if (trip[2]) cls(fetch, 'is-found'); });
      fly(fetch, [spot, p.aiTop], t + 1800, 1000, wire(other, 1)); hide(fetch, t + 2800);
    });
    at(9200, function () { all(other, '.recall-app:not([data-app])').forEach(function (a) { cls(a, 'is-skipped'); }); });
    at(9300, function () { cls(fetch, null, 'is-found'); });
    fly(fetch, [p.ai, p.answer], 9400, 500, wire(other, 2)); hide(fetch, answered.other);
    at(answered.other, function () { cls(ai, null, 'is-busy'); cls(other.querySelector('.recall-a'), 'is-shown'); });
    dial(other, 'other');
  }
  function stop() { timers.forEach(clearTimeout); timers = []; clearFlights(); running = false; }
  function play() {
    stop(); running = true; reset();
    playReady(); playOther();
    at(cycle - 700, function () { demo.classList.add('is-resetting'); });
    at(cycle, function () { if (running) play(); });
  }
  function finish() {
    // Restore the finished comparison that the markup describes.
    reset();
    [[other, 'other'], [ready, 'ready']].forEach(function (pair) {
      cls(pair[0].querySelector('.recall-a'), 'is-shown');
      pair[0].querySelector('.recall-timer').style.setProperty('--done', String((answered[pair[1]] - start) / scale));
    });
    all(ready, '.recall-app[data-relevant]').forEach(function (a) { cls(a, 'is-match'); });
    all(ready, '.recall-app:not([data-relevant])').forEach(function (a) { cls(a, 'is-quiet'); });
    cls(other.querySelector('[data-app="calendar"]'), 'is-match');
    cls(other.querySelector('[data-app="mail"]'), 'is-checked');
    all(other, '.recall-app:not([data-app])').forEach(function (a) { cls(a, 'is-skipped'); });
  }
  function update() {
    var should = visible && !document.hidden && !motion.matches;
    if (should && !running) play();
    else if (!should && running) { stop(); finish(); }
  }
  function draw() { wires(other); wires(ready); }
  draw();
  var width = window.innerWidth;
  // Phones fire resize when the address bar hides; only a width change moves the layout.
  window.addEventListener('resize', function () {
    if (window.innerWidth === width) return;
    width = window.innerWidth; draw(); if (running) play();
  });
  if (document.fonts) document.fonts.ready.then(draw);
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', update);
  if (window.IntersectionObserver) new IntersectionObserver(function (entries) {
    visible = entries[0].isIntersecting; update();
  }, {threshold: .35}).observe(demo);
})();
