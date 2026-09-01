#!/bin/sh
# ClosedHand one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/notnotjim/ClosedHand/main/install.sh | sh
#
# Clones the repo, creates .env with generated secrets, and starts the stack.
# Idempotent: safe to re-run in place (it never overwrites an existing .env).
#
# Overrides (mostly for testing):
#   CLOSEDHAND_REPO    git URL to clone            (default: the public repo)
#   CLOSEDHAND_DIR     directory to install into   (default: ./closedhand)
#   CLOSEDHAND_NO_UP   set to 1 to skip docker compose up
#   CLOSEDHAND_PLAIN   set to 1 to force plain output with no drawing

set -eu

REPO="${CLOSEDHAND_REPO:-https://github.com/notnotjim/ClosedHand.git}"
DIR="${CLOSEDHAND_DIR:-closedhand}"
_tmp="${TMPDIR:-/tmp}"
LOG="${_tmp%/}/closedhand-install.log"

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# --- The drawing -------------------------------------------------------------
# Decoration. The installer proper starts at "Preconditions" below.
#
# A hand that closes as the install advances: open while it fetches the code,
# a fist by the time the dashboard answers. It is drawn from geometry rather
# than stored pictures so it fits whatever terminal it finds.
HAND_AWK='# Renders one frame of the closing hand as a cut-out in a slab of blocks.
#   W  slab width in columns      H  slab height in rows
#   P  closing progress, 0 open to 1 fist
#   FI field char   SH shadow char   HL highlight char
#   PAD  columns of blank margin to the left of the slab
function rr(x, y, x1, y1, x2, y2, rx, ry,   dx, dy, cx, cy) {
  x1 += rx; x2 -= rx; y1 += ry; y2 -= ry
  if (x2 < x1) { cx = (x1 + x2) / 2; x1 = cx; x2 = cx }
  if (y2 < y1) { cy = (y1 + y2) / 2; y1 = cy; y2 = cy }
  dx = (x < x1 ? x1 - x : (x > x2 ? x - x2 : 0)) / rx
  dy = (y < y1 ? y1 - y : (y > y2 ? y - y2 : 0)) / ry
  return (dx * dx + dy * dy) <= 1
}

BEGIN {
  # As the fingers fold away the hand gets shorter, so it rises as it closes
  # and the fist ends up sitting where the open hand did rather than
  # sinking to the bottom of the slab.
  hh = H - 2
  oy = 1 - P * 0.20 * hh
  # A terminal cell is about twice as tall as it is wide, and a hand is a bit
  # over half as wide as it is long, so it wants about 1.15 columns per row.
  hw = int(hh * 1.15)
  if (hw > W - 6) hw = W - 6
  ox = int((W - hw) / 2)

  rx = hw * 0.06; if (rx < 1.3) rx = 1.3
  ry = hh * 0.05; if (ry < 0.8) ry = 0.8

  palmTop = 0.47 * hh
  palmX1  = 0.15 * hw
  palmX2  = hw
  palmBot = hh * 0.86
  # A narrower wrist below the palm, running off the bottom edge of the slab
  # rather than ending in a stump, so the hand reads as attached to an arm.
  wX1 = 0.36 * hw; wX2 = 0.84 * hw; wY1 = hh * 0.72; wY2 = hh * 1.4

  # Four fingers across the palm, middle longest, little finger shortest. The
  # gaps have to survive down to two columns or the fingers read as one slab.
  bandL = palmX1 + 0.03 * hw
  bandR = palmX2 - 0.02 * hw
  gap = (bandR - bandL) * 0.10; if (gap < 2) gap = 2
  fw  = ((bandR - bandL) - 3 * gap) / 4
  tipOpen[0] = 0.12 * hh
  tipOpen[1] = 0.01 * hh
  tipOpen[2] = 0.07 * hh
  tipOpen[3] = 0.24 * hh
  tipShut = palmTop - 0.11 * hh

  # Thumb: a lobe out to the left when open, folded across the front when shut.
  tOX1 = 0.00 * hw; tOX2 = 0.34 * hw; tOY1 = 0.50 * hh; tOY2 = 0.76 * hh
  tSX1 = 0.18 * hw; tSX2 = 0.88 * hw; tSY1 = 0.62 * hh; tSY2 = 0.84 * hh
  tx1 = tOX1 + P * (tSX1 - tOX1); tx2 = tOX2 + P * (tSX2 - tOX2)
  ty1 = tOY1 + P * (tSY1 - tOY1); ty2 = tOY2 + P * (tSY2 - tOY2)

  for (y = 0; y < H; y++) {
    for (x = 0; x < W; x++) {
      hx = x - ox; hy = y - oy
      v = 0
      if (rr(hx, hy, palmX1, palmTop, palmX2, palmBot, rx, ry)) v = 1
      for (i = 0; i < 4 && !v; i++) {
        fl = bandL + i * (fw + gap)
        tp = tipOpen[i] + P * (tipShut - tipOpen[i])
        if (rr(hx, hy, fl, tp, fl + fw, palmTop + 2 * ry, rx * 0.75, ry)) v = 1
      }
      if (!v && rr(hx, hy, wX1, wY1, wX2, wY2, rx, ry)) v = 1
      if (!v && rr(hx, hy, tx1, ty1, tx2, ty2, rx, ry * 1.2)) v = 1
      # Groove above the folded thumb, so the fist reads as thumb over fingers.
  # Late, because a groove drawn while the thumb is still crossing cuts a bar
  # through fingers that are visibly still up.
      if (v && P > 0.6 && hx > tx1 && hx < tx2 && hy > ty1 - 1.6 && hy < ty1 - 0.2) v = 0
      cell[y, x] = v
    }
  }

  # Light from the top left, so the slab casts a hard edge into the cut-out.
  margin = ""
  for (i = 0; i < PAD; i++) margin = margin " "
  out = ""
  for (y = 0; y < H; y++) {
    line = margin
    for (x = 0; x < W; x++) {
      if (cell[y, x]) { line = line " "; continue }
      if ((y > 0 && cell[y - 1, x]) || (x > 0 && cell[y, x - 1]) ||
          (x > 1 && cell[y, x - 2]) || (y > 0 && x > 0 && cell[y - 1, x - 1]))
        line = line SH
      else if ((y < H - 1 && cell[y + 1, x]) || (x < W - 1 && cell[y, x + 1]) ||
               (x < W - 2 && cell[y, x + 2]))
        line = line HL
      else line = line FI
    }
    out = out line "\n"
  }
  printf "%s", out
}'

hand_frame() {
  awk -v W="$BSW" -v PAD="$BPAD" -v H="$BH" -v P="$1" \
      -v FI="$BFI" -v SH="$BSH" -v HL="$BHL" "$HAND_AWK" </dev/null
}

# --- Progress display --------------------------------------------------------
# Two modes, and the plain one is the one that has to keep working.
#
#   drawn  On a real terminal: the hand and a bar are redrawn in place as each
#          step completes, and the output of git and docker goes to a log so it
#          cannot scroll the drawing away. The log is printed if a step fails.
#   plain  Anywhere else, and whenever anything the drawing needs is missing:
#          each step announces itself as a line, and git and docker print as
#          they always did. No cursor tricks, nothing hidden.
UI=0
UIDRAWN=0

ui_init() {
  if [ "${CLOSEDHAND_PLAIN:-0}" = "1" ]; then return 0; fi
  if [ ! -t 1 ] || [ "${TERM:-dumb}" = "dumb" ]; then return 0; fi
  if ! command -v awk >/dev/null 2>&1; then return 0; fi
  # A shell whose sleep only counts whole seconds would stretch every redraw
  # into a visible stall.
  if ! sleep 0.07 2>/dev/null; then return 0; fi

  BW=80; BH=20
  if command -v tput >/dev/null 2>&1; then
    c=$(tput cols 2>/dev/null || echo 80)
    l=$(tput lines 2>/dev/null || echo 24)
    case "$c" in ''|*[!0-9]*) c=80 ;; esac
    case "$l" in ''|*[!0-9]*) l=24 ;; esac
    BW=$((c - 1))
    BH=$((l - 11))
  fi
  if [ "$BH" -gt 30 ]; then BH=30; fi
  if [ "$BW" -lt 40 ] || [ "$BH" -lt 12 ]; then return 0; fi

  # The hand can only be as big as the terminal is tall, so on a wide terminal
  # a full-width slab would leave it stranded in the middle of a grey field.
  # Size the slab to the hand instead, then centre it in the space available.
  BSW=$(( ((BH - 2) * 115 / 100) * 23 / 10 ))
  if [ "$BSW" -gt "$BW" ]; then BSW=$BW; fi
  BPAD=$(( (BW - BSW) / 2 ))
  BLOCK=$((BH + 6))

  # Block characters need a UTF-8 locale; anywhere else they arrive as rubbish.
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) BFI=$(printf '\342\226\222')
                                   BSH=$(printf '\342\226\210')
                                   BHL=$(printf '\342\226\221') ;;
    *) BFI='.'; BSH='#'; BHL=':' ;;
  esac

  UI=1
  trap 'printf "\033[?25h"' EXIT
  trap 'printf "\033[?25h"; exit 130' INT
  printf '\033[?25l\n'
}

spaces() {
  _n=$1; _s=""
  while [ "$_n" -gt 0 ]; do _s="$_s "; _n=$((_n - 1)); done
  printf '%s' "$_s"
}

# Every line this display prints must fit the terminal. One that does not wraps
# onto a second physical row, the redraw then moves up by fewer rows than it
# printed, and from there every frame lands lower than the last and smears the
# one before it. Text only: ${#} counts bytes in some shells, so the block
# characters never come through here.
ui_line() {
  _t="$1"
  if [ "${#_t}" -gt "$BW" ]; then _t=$(printf '%s' "$_t" | cut -c1-"$BW"); fi
  printf '\033[2K%s\n' "$_t"
}

ui_centred() {
  _t="$1"
  _i=$(( (BW - ${#_t}) / 2 ))
  if [ "$_i" -lt 0 ]; then _i=0; fi
  ui_line "$(spaces "$_i")$_t"
}

ui_bar() {
  _done=$(( BSW * $1 / 100 ))
  _left=$(( BSW - _done ))
  _s=""
  while [ "$_done" -gt 0 ]; do _s="$_s$BSH"; _done=$((_done - 1)); done
  while [ "$_left" -gt 0 ]; do _s="$_s$BHL"; _left=$((_left - 1)); done
  printf '\033[2K%s%s\n' "$(spaces "$BPAD")" "$_s"
}

ui_draw() {
  _pct=$1; _label=$2
  # A terminal resized mid-install invalidates every width held here and the
  # redraw would smear again. Notice it and fall back to plain lines rather
  # than try to recover a block that is already wrong.
  _cols=$(tput cols 2>/dev/null) || _cols=""
  case "$_cols" in ''|*[!0-9]*) _cols="" ;; esac
  if [ -n "$_cols" ] && [ "$((_cols - 1))" -ne "$BW" ]; then
    printf '\033[?25h'
    UI=0
    say "$_label"
    return 0
  fi

  # The drawing takes progress as a fraction; the bar takes it as a percentage.
  if [ "$_pct" -ge 100 ]; then _frac=1; else _frac=$(printf '0.%02d' "$_pct"); fi

  if [ "$UIDRAWN" = "1" ]; then
    printf '\033[%dA' "$BLOCK"
  else
    # Wipe the rows the block is about to occupy. The drawing itself comes
    # straight from awk without clearing codes, so whatever sat to the right
    # of it would otherwise survive the first frame.
    _i=$BLOCK
    while [ "$_i" -gt 0 ]; do printf '\033[2K\n'; _i=$((_i - 1)); done
    printf '\033[%dA' "$BLOCK"
  fi

  hand_frame "$_frac"
  ui_line ""
  ui_centred "C L O S E D H A N D"
  ui_centred "A personal AI assistant you actually own."
  ui_line ""
  ui_bar "$_pct"
  ui_centred "$_pct%  $_label"
  UIDRAWN=1
}

# One step of the install finished. Redraw, or say so, depending on the mode.
step() {
  if [ "$UI" = "1" ]; then ui_draw "$1" "$2"; else say "$2"; fi
}

# Run a command, hiding its output only when there is a drawing it would ruin.
run() {
  if [ "$UI" = "1" ]; then "$@" >>"$LOG" 2>&1; else "$@"; fi
}

# docker compose pull names every layer as it starts and again as it finishes,
# so the share of layers already downloaded is a real measure of the longest
# wait in an install rather than a guess dressed up as one.
pull_progress() {
  _tot=$(awk '$2 == "Pulling" && $3 == "fs" { print $1 }' "$LOG" 2>/dev/null \
         | sort -u | wc -l | tr -d ' ')
  _don=$(awk '$2 == "Download" && $3 == "complete" { print $1 }' "$LOG" 2>/dev/null \
         | sort -u | wc -l | tr -d ' ')
  if [ "${_tot:-0}" -gt 0 ]; then printf '%d' $(( _don * 100 / _tot )); fi
  return 0
}

# Run a slow command while the bar keeps moving. Pass a probe that prints how
# far along the command is, or "-" when there is nothing to measure, in which
# case the bar creeps slowly towards the ceiling and never reaches it early.
run_watched() {
  _from=$1; _to=$2; _label=$3; _probe=$4; shift 4
  if [ "$UI" != "1" ]; then
    say "$_label"
    "$@"
    return $?
  fi
  "$@" >>"$LOG" 2>&1 &
  _pid=$!
  _pct=$_from
  _tick=0
  while kill -0 "$_pid" 2>/dev/null; do
    _share=""
    if [ "$_probe" != "-" ]; then _share=$("$_probe"); fi
    if [ -n "$_share" ]; then
      _pct=$(( _from + (_to - _from) * _share / 100 ))
    else
      _tick=$((_tick + 1))
      if [ "$_tick" -ge 3 ] && [ "$_pct" -lt "$_to" ]; then
        _pct=$((_pct + 1)); _tick=0
      fi
    fi
    ui_draw "$_pct" "$_label"
    sleep 1
  done
  if wait "$_pid"; then return 0; else return $?; fi
}

# A step failed. In drawn mode the reason is in the log, so print the end of it
# rather than leaving the user with nothing but a stalled bar.
die() {
  if [ "$UI" = "1" ]; then
    printf '\033[?25h'
    say ""
    say "The end of the log:"
    tail -n 25 "$LOG" 2>/dev/null || true
    say ""
    say "Full log: $LOG"
    say ""
  fi
  fail "$1"
}

# --- Preconditions -----------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required. Install it and re-run."
command -v docker >/dev/null 2>&1 || fail "docker is required. Install Docker (or Docker Desktop) and re-run."
docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is required (docker compose version failed)."
docker info >/dev/null 2>&1 || fail "the docker daemon isn't running. Start Docker and re-run."

# --- Where this is going -----------------------------------------------------
# Said on a plain line above the display, before anything is written. The first
# branch adopts whatever directory you are standing in, which is right for
# someone who cloned by hand and wrong for someone who ran this from a checkout
# they did not mean to install into. A path is also the one thing here that
# must not be shortened to fit a centred line.
if [ -f docker-compose.yml ] && [ -f .env.example ]; then
  say "Installing into the checkout you are in: $(pwd)"
elif [ -d "$DIR" ]; then
  say "Reusing the checkout in $(pwd)/$DIR"
else
  say "Installing into $(pwd)/$DIR"
fi

ui_init
: > "$LOG" 2>/dev/null || true

# --- Clone (or reuse a checkout we're already inside) ------------------------
if [ -f docker-compose.yml ] && [ -f .env.example ]; then
  step 0 "Using this checkout"
elif [ -d "$DIR" ]; then
  [ -f "$DIR/docker-compose.yml" ] || fail "$DIR exists but doesn't look like a ClosedHand checkout. Remove it or set CLOSEDHAND_DIR."
  step 0 "Updating the checkout"
  cd "$DIR"
  # Re-running the installer doubles as the upgrade path: fast-forward a clean
  # checkout so the rebuild uses current code. Local edits are left alone.
  if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
    run git pull --ff-only 2>/dev/null || true
  fi
else
  step 0 "Getting the code"
  run git clone --depth 1 "$REPO" "$DIR" || die "could not clone $REPO."
  cd "$DIR"
fi
step 20 "Code ready"

# --- .env with generated secrets (first run only) ----------------------------
# Never regenerate: POSTGRES_PASSWORD must keep matching the existing data
# volume, and rotating WS/sandbox secrets on re-run would break a live stack.
if [ -f .env ]; then
  step 28 "Keeping your settings"
else
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    rand() { openssl rand -hex 24; }
  else
    rand() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
  fi
  # Replace a key's placeholder line if .env.example ships one, else append.
  # Duplicated keys are a trap: compose takes the last occurrence but dotenv
  # takes the first, so the file must contain each key exactly once.
  setkey() {
    if grep -q "^$1=" .env; then
      sed "s|^$1=.*|$1=$2|" .env > .env.tmp && mv .env.tmp .env
    else
      printf '%s=%s\n' "$1" "$2" >> .env
    fi
  }
  printf '\n# Generated by install.sh on first run. Rotating POSTGRES_PASSWORD later\n# requires resetting the pgdata volume; the others can be changed freely.\n' >> .env
  setkey POSTGRES_PASSWORD "$(rand)"
  setkey WS_AUTH_SECRET "$(rand)"
  setkey SANDBOX_TOKEN "$(rand)"
  setkey COOKIE_SECRET "$(rand)"
  setkey TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32 2>/dev/null || rand)"
  # No ADMIN_PASSWORD here: you choose the dashboard password inside the setup
  # wizard, where you'll actually remember it.
  step 28 "Settings ready"
fi

# --- Up ----------------------------------------------------------------------
if [ "${CLOSEDHAND_NO_UP:-0}" = "1" ]; then
  step 100 "Not starting anything"
  exit 0
fi

BUILT_FROM_SOURCE=0
if [ "${CLOSEDHAND_BUILD:-0}" = "1" ]; then
  run_watched 30 70 "Building from source" - \
    docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build \
    || die "the build failed."
  BUILT_FROM_SOURCE=1
else
  # One retry for a genuine blip, then build from source. A missing or private
  # image is not a network problem and pulling it again cannot fix it, so the
  # fallback is the thing that actually works: slower, but it always boots.
  if ! run_watched 30 65 "Downloading ClosedHand" pull_progress docker compose pull; then
    step 30 "Download stalled, retrying"
    sleep 10
    if ! run_watched 30 65 "Downloading ClosedHand" pull_progress docker compose pull; then
      run_watched 30 70 "Building from source" - \
        docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build \
        || die "both the download and the build failed."
      BUILT_FROM_SOURCE=1
    fi
  fi
fi

if [ "$BUILT_FROM_SOURCE" = "0" ]; then
  step 72 "Starting ClosedHand"
  run docker compose up -d || die "docker compose up failed."
fi

# Take the user to the wizard rather than telling them an address to type.
# Wait until the dashboard actually answers (first boot includes a database
# init, usually well under a minute), then open the default browser where a
# desktop exists. On a headless server there is no browser to open, so the
# printed address below is the whole story there, and it never only says
# "opening..." without printing the address, because the open can fail
# silently in odd environments.
DASH_URL="http://localhost:3000"
step 80 "Waiting for the dashboard"
tries=0
while [ "$tries" -lt 45 ]; do
  if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null --max-time 2 "$DASH_URL" 2>/dev/null; then
    break
  fi
  tries=$((tries + 1))
  sleep 2
  # Creep from 80 to 97 across the wait, so a slow first boot still shows
  # something moving without ever claiming to be finished.
  if [ "$UI" = "1" ]; then
    ui_draw $(( 80 + (tries * 17 / 45) )) "Waiting for the dashboard"
  fi
done

step 100 "Ready"

OPENED=0
if command -v open >/dev/null 2>&1; then
  open "$DASH_URL" 2>/dev/null && OPENED=1
elif command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  xdg-open "$DASH_URL" 2>/dev/null && OPENED=1
fi

say ""
if [ "$OPENED" = "1" ]; then
  say "Opening the setup wizard in your browser: $DASH_URL"
else
  say "Open $DASH_URL in a browser to reach the setup wizard."
fi
say "It takes it from there: one model key, a password you choose, a chat app,"
say "and an optional Google connection."
say ""
say "ClosedHand's computer, the machine it browses and runs code on, is at"
say "http://localhost:6080 if you ever want to watch it work. The wizard"
say "shows it when a step needs it, so this is just for curiosity."
