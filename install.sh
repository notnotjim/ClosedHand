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
#   CLOSEDHAND_RESET   set to 1 to tear this install down before rebuilding it.
#                      DESTROYS the database, stored files and settings. Meant
#                      for testing from a known-empty state, not for upgrading:
#                      a plain re-run already upgrades and keeps your data.

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
# An open hand that closes into a fist, played once when the display comes up,
# then held while the install runs. Ten frames, each 32 pixels wide and 28
# tall, one row per eight hex digits; scripts/hand-frames.py draws them.
HAND_FRAMES='000000000001c0000003e0000003e7000073ef8000fbef8000fbef8000fbef8020fbef9cf8fbefbefcfbefbefcfbefbefefbefbe7ffbefbe3ffffffe1ffffffe0ffffffe07fffffe03ffffff01ffffff01fffffe01fffffe00fffffe007ffff8000fffc0000fffc0000fffc0000fffc0
000000000001c0000003e0000003e7000073ef8000fbef8000fbef8000fbef8000fbef9c30fbefbef8fbefbefcfbefbefffbefbe7ffbefbe3ffffffe1ffffffe0ffffffe07fffffe01ffffff01ffffff01fffffe01fffffe00fffffc003ffff8000fffc0000fffc0000fffc0000fffc0
00000000000080000001c0000003e7000073ef8000fbef8000fbef8000fbef8000fbef9c00fbefbe70fbefbefcfbefbefffbefbefffbefbe7ffffffe3ffffffe0ffffffe07fffffe01fffffe01fffffe01fffffe00fffffe00fffffc003ffff0000fffc0000fffc0000fffc0000fffc0
00000000000000000001c0000003e2000073ef8000fbef8000fbef8000fbef9c00fbefbe00fbefbe00fbefbe78fbefbe7ffbefbefffbefbefffffffe7ffffffe3ffffffe0ffffffe07fffffe01fffffe01fffffe00fffffe007ffffc001ffff0000fffc0000fffc0000fffc0000fffc0
00000000000000000001c0000003e0000073e70000fbef8000fbef8000fbef9c00fbefbe00fbefbe00fbefbe03fbefbe7ffbefbe7ffffffefffffffefffffffe7ffffffe3ffffffe07ffffff01fffffe01fffffe00fffffe007ffffc000fffe0000fffc0000fffc0000fffc0000fffc0
00000000000000000001c0000003e0000073e70000fbef8000fbef8000fbef9c00fbefbe00fbefbe03fbefbe0ffbefbe0ffbefbe7ffffffe7ffffffefffffffe7ffffffe7ffffffe3ffffffe01fffffe00fffffe00fffffc007ffff8000fffc0000fffc0000fffc0000fffc0000fffc0
0000000000000000000000000001c0000073e70000fbef8000fbef8000fbef9c00fbefbe07fbefbe0ffbefbe1ffbefbe1ffffffe1ffffffe7ffffffe7ffffffe7ffffffe7ffffffe7ffffffe1ffffffe00fffffe00fffffc003ffff8000fffc0000fffc0000fffc0000fffc0000fffc0
0000000000000000000000000001c0000073e70000fbef8000fbef9c00fbefbe0ffbefbe1ffbefbe3ffbefbe3ffbefbe3ffffffe3ffffffe3ffffffe7ffffffe7ffffffe7ffffffe7ffffffe7ffffffe1ffffffe007ffffc003ffff0000fffc0000fffc0000fffc0000fffc0000fffc0
0000000000000000000000000001c0000073e70000fbef8000fbef9c1ffbefbe3ffbefbe3ffbefbe7ffbefbe7ffffffe7ffffffe7ffffffe7ffffffe7ffffffe3ffffffe7ffffffe7ffffffe7ffffffe3ffffffc1ffffff8001ffff0000fffc0000fffc0000fffc0000fffc0000fffc0
0000000000000000000000000001c0000073e70000fbef8000fbef9c1ffbefbe3ffbefbe3ffbefbe7ffbefbe7ffffffe7ffffffe7ffffffe401ffffe1fc001fe3ffffcfe7ffffefe7ffffefe7ffffefe3ffffffc1ffffff8001ffff0000fffc0000fffc0000fffc0000fffc0000fffc0'

HAND_AWK='# One frame of the hand. The frame is 28 rows of 32 pixels, each row eight hex
# digits; a terminal cell shows two pixels, one above the other, using the
# half-block characters. K scales the picture, PAD centres it.
#   FR  the frame as 224 hex digits    K  cells per pixel, sideways
#   PAD  blank columns on the left     FU full, TP top, BT bottom half
BEGIN {
  hex = "0123456789abcdef"
  for (i = 0; i < 16; i++) {
    v = i
    for (b = 3; b >= 0; b--) { bit[substr(hex, i + 1, 1), b] = v % 2; v = int(v / 2) }
  }
  for (y = 0; y < 28; y++)
    for (x = 0; x < 32; x++) {
      d = substr(FR, y * 8 + int(x / 4) + 1, 1)
      px[x, y] = bit[d, x % 4]
    }
  margin = ""
  for (i = 0; i < PAD; i++) margin = margin " "
  rows = 14 * K
  for (r = 0; r < rows; r++) {
    line = margin
    for (c = 0; c < 32 * K; c++) {
      t = px[int(c / K), int((2 * r) / K)]
      b = px[int(c / K), int((2 * r + 1) / K)]
      line = line (t && b ? FU : (t ? TP : (b ? BT : " ")))
    }
    printf "\033[2K%s\n", line
  }
}
'

# Print frame N (1 to 10) of the hand at the size ui_init settled on.
hand_frame() {
  _fr=$(printf '%s\n' "$HAND_FRAMES" | sed -n "${1}p")
  awk -v FR="$_fr" -v K="$BK" -v PAD="$BPAD" \
      -v FU="$BFU" -v TP="$BTP" -v BT="$BBT" "$HAND_AWK" </dev/null
}
HAND_FRAME=10

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
    # Rows left for the hand once the nine lines under it are counted. The
    # notes printed above the drawing may scroll off on a short terminal;
    # that is better than a hand that does not fit.
    BH=$((l - 10))
  fi
  # The hand is 32 cells wide and 14 tall, and only ever shown at a whole
  # multiple of that, so a terminal that cannot fit one copy gets plain lines.
  BK=$((BH / 14))
  if [ "$((BW / 32))" -lt "$BK" ]; then BK=$((BW / 32)); fi
  if [ "$BK" -gt 2 ]; then BK=2; fi
  if [ "$BK" -lt 1 ] || [ "$BW" -lt 60 ]; then return 0; fi
  BH=$((BK * 14))
  BSW=$((BK * 32))
  BPAD=$(( (BW - BSW) / 2 ))
  BLOCK=$((BH + 9))

  # Block characters need a UTF-8 locale; anywhere else they arrive as rubbish.
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) BFU=$(printf '\342\226\210')
                                   BTP=$(printf '\342\226\200')
                                   BBT=$(printf '\342\226\204')
                                   BSH=$BFU
                                   BHL=$(printf '\342\226\221') ;;
    *) BFU='#'; BTP="'"; BBT=','; BSH='#'; BHL=':' ;;
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

# Which images have arrived, so a step that looks frozen still shows what has
# actually been finished. Names as a person would say them, not as the registry
# spells them.
images_line() {
  awk '$1 == "Image" && ($3 == "Pulling" || $3 == "Pulled") { seen[$2] = 1 }
       $1 == "Image" && $3 == "Pulled" { got[$2] = 1 }
       END {
         n = 0
         for (k in seen) order[++n] = k
         for (i = 1; i < n; i++)
           for (j = i + 1; j <= n; j++)
             if (order[j] < order[i]) { t = order[i]; order[i] = order[j]; order[j] = t }
         out = ""
         for (i = 1; i <= n; i++) {
           r = order[i]
           sub(/:[^:\/]*$/, "", r); sub(/^.*\//, "", r); sub(/^closedhand-/, "", r)
           if (r == "pgvector") r = "database"
           else if (r == "webapp") r = "dashboard"
           else if (r == "bot") r = "assistant"
           else if (r == "sandbox") r = "computer"
           out = out ((order[i] in got) ? "[x] " : "[ ] ") r "   "
         }
         print out
       }' "$LOG" 2>/dev/null
}

# Functions in sh share one set of variables, so anything ui_draw assigns is
# also assigned in whatever called it. These names are its own: when they were
# _pct and _label, a caller that passed "$_label$_detail" got that written back
# over its own _label and the detail appended again every second.
ui_draw() {
  _dpct=$1; _dtext=$2
  # A terminal resized mid-install invalidates every width held here and the
  # redraw would smear again. Notice it and fall back to plain lines rather
  # than try to recover a block that is already wrong.
  _cols=$(tput cols 2>/dev/null) || _cols=""
  case "$_cols" in ''|*[!0-9]*) _cols="" ;; esac
  if [ -n "$_cols" ] && [ "$((_cols - 1))" -ne "$BW" ]; then
    printf '\033[?25h'
    UI=0
    say "$_dtext"
    return 0
  fi

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

  hand_frame "$HAND_FRAME"
  ui_line ""
  ui_centred "C L O S E D H A N D"
  ui_centred "A personal AI assistant you actually own."
  ui_line ""
  ui_bar "$_dpct"
  ui_centred "$_dpct%  $_dtext"
  ui_centred "$(images_line)"
  ui_line ""
  ui_centred "Everything stays on this machine. No ClosedHand account required."
  UIDRAWN=1
}

# The hand closes once, about a second, before the first step is drawn.
ui_intro() {
  if [ "$UI" != "1" ]; then return 0; fi
  _f=1
  while [ "$_f" -le 10 ]; do
    HAND_FRAME=$_f
    ui_draw 0 "Starting"
    sleep 0.09 2>/dev/null || true
    _f=$((_f + 1))
  done
}

# One step of the install finished. Redraw, or say so, depending on the mode.
step() {
  if [ "$UI" = "1" ]; then ui_draw "$1" "$2"; else say "$2"; fi
}

# Run a command, hiding its output only when there is a drawing it would ruin.
run() {
  if [ "$UI" = "1" ]; then "$@" >>"$LOG" 2>&1; else "$@"; fi
}

# docker compose pull writes a line per image layer as it goes, so the share of
# layers already finished is a real measure of the longest wait in an install
# rather than a guess dressed up as one.
#
# Counted by layer id, which is the first field and always twelve hex digits,
# rather than by the "Pulling fs layer" announcement: a pull that resumes over
# layers docker has seen before skips those announcements entirely and the
# count would come out as nothing to divide by.
pull_progress() {
  _tot=$(awk 'length($1) == 12 && $1 ~ /^[0-9a-f]+$/ { print $1 }' "$LOG" 2>/dev/null \
         | sort -u | wc -l | tr -d ' ')
  _don=$(awk 'length($1) == 12 && $1 ~ /^[0-9a-f]+$/ &&
              /Download complete|Pull complete|Already exists/ { print $1 }' "$LOG" 2>/dev/null \
         | sort -u | wc -l | tr -d ' ')
  # The count, not a byte total. Summing the last figure reported per layer
  # looked like a nice live number and disagreed with what docker actually had
  # on disk, and a plausible wrong number is worse than a plain right one.
  # The layer count can sit still for minutes on one large layer, so carry
  # docker's own running figure for whatever it is currently receiving.
  _now=$(awk 'length($1) == 12 && $2 == "Downloading" { v = $3 } END { print v }' "$LOG" 2>/dev/null)
  if [ "${_tot:-0}" -gt 0 ]; then
    if [ -n "$_now" ]; then
      printf '%d %s of %s layers, receiving %s' $(( _don * 100 / _tot )) "$_don" "$_tot" "$_now"
    else
      printf '%d %s of %s layers' $(( _don * 100 / _tot )) "$_don" "$_tot"
    fi
  fi
  return 0
}

# git writes its progress as carriage-return updates on one long line, so the
# log has to be broken back into lines before the last percentage can be read.
clone_progress() {
  _l=$(tr '\r' '\n' < "$LOG" 2>/dev/null | grep 'Receiving objects:' | tail -1)
  if [ -z "$_l" ]; then return 0; fi
  # "Receiving objects:  63% (293/464), 10.8 MiB | 38.00 KiB/s"
  printf '%s' "$_l" | awk '{ p = $3; sub(/%/, "", p)
                             if (NF >= 9) { u = $9; sub(/,$/, "", u)
                                            printf "%s %s %s at %s %s", p, $5, $6, $8, u }
                             else printf "%s", p }'
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
    _share=""; _detail=""
    if [ "$_probe" != "-" ]; then _out=$("$_probe"); else _out=""; fi
    if [ -n "$_out" ]; then
      _share=${_out%% *}
      case "$_out" in *' '*) _detail="  (${_out#* })" ;; esac
    fi
    if [ -n "$_share" ]; then
      _pct=$(( _from + (_to - _from) * _share / 100 ))
    else
      _tick=$((_tick + 1))
      if [ "$_tick" -ge 3 ] && [ "$_pct" -lt "$_to" ]; then
        _pct=$((_pct + 1)); _tick=0
      fi
    fi
    ui_draw "$_pct" "$_label$_detail"
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

# --- Reset (only when asked) -------------------------------------------------
# Deliberately narrow. It removes the containers and volumes belonging to this
# one install and the checkout this installer manages, and nothing else on the
# machine: no other projects, and not the downloaded images, because keeping
# those is what makes a rebuild quick.
if [ "${CLOSEDHAND_RESET:-0}" = "1" ]; then
  if [ -f docker-compose.yml ] && [ -f .env.example ]; then
    say "Reset: removing this install's containers, volumes and settings."
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f .env
  elif [ -d "$DIR" ] && [ -f "$DIR/docker-compose.yml" ]; then
    say "Reset: removing this install's containers, volumes and $(pwd)/$DIR."
    ( cd "$DIR" && docker compose down -v --remove-orphans >/dev/null 2>&1 ) || true
    rm -rf "$DIR"
  else
    say "Reset: nothing installed here to remove."
  fi
  say ""
fi

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

say "Raw output: tail -f $LOG"
say "Or re-run with CLOSEDHAND_PLAIN=1 for no drawing at all."

ui_init
ui_intro
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
  # --progress because git stays silent when its output is not a terminal, and
  # here it is being written to a log. On a slow line this is the difference
  # between a bar that moves and one that looks hung for ten minutes.
  run_watched 0 20 "Getting the code" clone_progress \
    git clone --progress --depth 1 "$REPO" "$DIR" || die "could not clone $REPO."
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
