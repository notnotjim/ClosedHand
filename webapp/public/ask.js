// One way to ask before something that can't be taken back, on every page.
// The question takes the place of what asked (a button, or its row of
// buttons), says what goes and what stays, and offers the action in red and
// Cancel. Cancel puts things back as they were.
//
//   var answer = await askFirst(button, { text: 'Delete this file?', yes: 'Delete' });
//   if (!answer) return;
//
// With `check`, the question carries one choice as a checkbox, and the
// answer says whether it was ticked: answer.checked. With `other`, a gentler
// second action sits beside the first, and choosing it answers { other: true }.
(function () {
  function askFirst(where, opts) {
    return new Promise(function (resolve) {
      var box = document.createElement('div');
      box.className = 'ask';
      box.setAttribute('role', 'group');
      var text = document.createElement('p');
      text.className = 'ask-text';
      text.textContent = opts.text;
      box.appendChild(text);
      var tick = null;
      if (opts.check) {
        var label = document.createElement('label');
        label.className = 'ask-check';
        tick = document.createElement('input');
        tick.type = 'checkbox';
        label.append(tick, document.createTextNode(opts.check));
        box.appendChild(label);
      }
      var yes = document.createElement('button');
      yes.type = 'button'; yes.className = 'ask-yes'; yes.textContent = opts.yes;
      var other = null;
      if (opts.other) {
        other = document.createElement('button');
        other.type = 'button'; other.className = 'ask-no'; other.textContent = opts.other;
      }
      var no = document.createElement('button');
      no.type = 'button'; no.className = 'ask-no'; no.textContent = 'Cancel';
      var row = document.createElement('div');
      row.className = 'ask-actions';
      row.append.apply(row, [yes, other, no].filter(Boolean));
      box.appendChild(row);
      // Cards open and close on a click; answering must not.
      box.addEventListener('click', function (e) { e.stopPropagation(); });
      // In a row of buttons the question takes a line of its own.
      var parent = where.parentElement, wrapWas = parent ? parent.style.flexWrap : '';
      if (parent && /flex/.test(getComputedStyle(parent).display)) parent.style.flexWrap = 'wrap';
      var answered = false;
      function answer(value) {
        if (answered) return;
        answered = true;
        if (parent) parent.style.flexWrap = wrapWas;
        box.replaceWith(where);
        if (!value && where.focus) where.focus();
        resolve(value);
      }
      yes.addEventListener('click', function () { answer({ checked: !!(tick && tick.checked) }); });
      if (other) other.addEventListener('click', function () { answer({ other: true }); });
      no.addEventListener('click', function () { answer(false); });
      box.addEventListener('keydown', function (e) { if (e.key === 'Escape') answer(false); });
      where.replaceWith(box);
      no.focus();
    });
  }
  window.askFirst = askFirst;
})();
