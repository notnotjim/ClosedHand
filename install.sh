#!/bin/sh
# Closedhand one-line installer.
#
#   curl -fsSL https://closedhand.com/install | sh
#
# Clones the repo, creates .env with generated secrets, and starts the stack.
# Idempotent: safe to re-run in place (it never overwrites an existing .env).
#
# Overrides (mostly for testing):
#   CLOSEDHAND_REPO    git URL to clone            (default: the public repo)
#   CLOSEDHAND_DIR     directory to install into   (default: ./closedhand)
#   CLOSEDHAND_NO_UP   set to 1 to skip docker compose up
#   CLOSEDHAND_NO_AUTOSTART  set to 1 to leave Docker's start-at-sign-in as it is
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

# A terminal still in a folder that has since been deleted (removing an old
# ~/closedhand does it) has no current folder to install into: use home.
if ! pwd -P >/dev/null 2>&1; then
  cd "$HOME" 2>/dev/null || fail "this terminal's folder no longer exists. Run cd ~ and try again."
  say "This terminal's folder no longer exists, so installing in your home folder."
fi

# --- The drawing -------------------------------------------------------------
# Decoration. The installer proper starts at "Preconditions" below.
#
# The Closedhand fist, held while the install runs. Taken from the brand icon
# (webapp/public/fist.png) by scripts/hand-frames.py: a shaded pixel picture,
# run-length coded, at two sizes.
HAND_FIST_32='12a5i3a4i12a5i2a15i9a24i7a25i6a12i3u13i4a4i3v5i3u5i2t8i1a4i3v1u4i4u4i3t13i2v3u3i3u2t3i3t1s12i1v8u9t2s11i9u9t7s7i8u9t8s7i7u1t7i1t9s7i6u1t14i1s1i1s8i5u1t16i2r8i4u1t5i2t1s8i3r8i2u3t4i2t9s4r4i1a3i1u4t4i1t9s5r4i1a3i5t4i9s5r5i2a3i4t5i7s6r5i2a3i5t5i5s7r4i3a3i5t6i2s8r5i4a2i3t3s8i7r5i4a2i2t5s9i4r5i6a1i1t5s2a17i6a2i4s5a14i8a1i3s8a11i9a1i1s13a7i10a1s17a3i7a'
HAND_FIST_64='25a7i54a12i5a8i26a6i6a14i2a12i22a11i2a31i19a46i16a48i15a50i13a51i13a24i4u26i9a10i2v12i6u11i2t14i7a8i6v9i7u10i4t15i5a7i6v1u9i8u8i6t15i3a7i6v3u7i8u1t8i6t16i2a7i5v4u7i7u2t8i6t16i2a6i5v5u7i6u3t7i7t17i1a6i3v8u5i6u5t5i8t17i1a6i2v10u3i6u18t2s23i1v18u19t4s5i2s14i1v18u19t12s14i18u18t14s14i17u18t15s14i16u18t16s14i15u2t9i7t17s14i13u2t17i17s15i12u2t23i12s15i11u2t33i2s1r15i10u2t33i2s2r15i9u3t32i1s3r9i1a6i8u3t10i3t18i2s4r9i1a6i6u5t8i6t6s9i3s5r9i1a6i5u6t7i6t18s6r9i1a6i4u6t8i4t19s7r8i2a6i3u7t7i4t19s8r8i3a5i2u8t7i3t18s9r9i3a5i1u9t8i1t18s10r9i3a6i9t8i18s11r9i3a6i10t8i16s11r9i5a5i10t9i14s12r9i5a5i10t10i12s13r9i5a5i11t10i9s14r9i6a5i11t11i7s15r9i7a5i9t2s12i4s16r9i7a5i8t4s14i16r9i9a4i6t7s15i14r9i9a4i5t9s17i10r10i10a3i4t10s1a19i6r10i11a4i2t10s4a19i3r11i12a3i1t9s7a31i13a3i9s10a28i15a3i7s13a26i15a3i6s16a23i17a2i4s21a19i19a2i2s25a15i20a2i1s28a12i20a3s31a9i21a2s35a5i15a'

HAND_AWK='# The fist. FR is PW pixels wide and twice ROWS tall, one grey level per
# pixel, run-length coded as <count><letter>: a is background, b..y dark to
# light. A terminal cell shows two pixels, one above the other, with the
# half-block glyphs.
#   PW  pixel width     ROWS  cell rows     PAD  blank columns on the left
#   COLOR  1 = 256-colour greys, 0 = shades of block characters
#   TP BT  top and bottom half blocks     SH1..SH4  the mono ramp
BEGIN {
  n = 0; i = 1; L = length(FR)
  while (i <= L) {
    c = ""; ch = substr(FR, i, 1)
    while (ch >= "0" && ch <= "9") { c = c ch; i++; ch = substr(FR, i, 1) }
    v = index("abcdefghijklmnopqrstuvwxy", ch) - 1
    for (k = 0; k < c + 0; k++) { px[n % PW, int(n / PW)] = v; n++ }
    i++
  }
  margin = ""
  for (k = 0; k < PAD; k++) margin = margin " "
  # macOS Terminal draws block characters short of their cell, so half
  # blocks leave a seam wherever the two pixels of a cell differ. There, at
  # the large size (SPACES), the fist is drawn with coloured spaces alone,
  # which fill the cell edge to edge: each pixel of the 32-wide picture is two
  # spaces, the same picture with no seams.
  if (SPACES && COLOR) {
    for (y = 0; y < ROWS; y++) {
      line = margin
      for (c = 0; c < PW; c++) {
        v = px[c, y]
        line = line (v ? sprintf("\033[48;5;%dm  ", 231 + v) : "\033[0m  ")
      }
      printf "\033[2K%s\033[0m\n", line
    }
    exit
  }
  for (r = 0; r < ROWS; r++) {
    line = margin
    for (c = 0; c < PW; c++) {
      t = px[c, 2 * r]; b = px[c, 2 * r + 1]
      if (COLOR) {
        if (t && b)       line = line sprintf("\033[38;5;%d;48;5;%dm%s", 231 + t, 231 + b, TP)
        else if (t)       line = line sprintf("\033[0;38;5;%dm%s", 231 + t, TP)
        else if (b)       line = line sprintf("\033[0;38;5;%dm%s", 231 + b, BT)
        else              line = line "\033[0m "
      } else {
        a = (t + b) / 2
        if (a <= 0)       line = line " "
        else if (a < 7)   line = line SH1
        else if (a < 13)  line = line SH2
        else if (a < 19)  line = line SH3
        else              line = line SH4
      }
    }
    printf "\033[2K%s\033[0m\n", line
  }
}
'

# Print the fist at the size ui_init settled on.
hand_frame() {
  # macOS Terminal at the large size gets the spaces-only drawing (see
  # HAND_AWK). A space holds one colour, so the small size has no clean
  # equivalent and keeps its half blocks everywhere.
  _sp=0
  if [ "$BK" -ge 2 ]; then case "${TERM_PROGRAM:-}" in Apple_Terminal) _sp=1 ;; esac; fi
  if [ "$_sp" = 1 ]; then _fr=$HAND_FIST_32; _pw=32
  elif [ "$BK" -ge 2 ]; then _fr=$HAND_FIST_64; _pw=$BSW; else _fr=$HAND_FIST_32; _pw=$BSW; fi
  awk -v FR="$_fr" -v PW="$_pw" -v ROWS="$BH" -v PAD="$BPAD" -v COLOR="$BCOLOR" -v SPACES="$_sp" \
      -v TP="$BTP" -v BT="$BBT" \
      -v SH1="$BS1" -v SH2="$BS2" -v SH3="$BS3" -v SH4="$BS4" "$HAND_AWK" </dev/null
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
  # Centre the fist on the wordmark under it, not the frame on the terminal:
  # the picture sits 3 pixels in from the frame's left edge and 4 from its
  # right, so the frame is placed so the picture's own middle (15.5 cells per
  # size step) lands on the middle of the 21-character wordmark.
  BPAD=$(( (BW - 21) / 2 + 10 - (31 * BK) / 2 ))
  if [ "$BPAD" -lt 0 ]; then BPAD=0; fi
  BLOCK=$((BH + 9))

  # Block characters need a UTF-8 locale; anywhere else they arrive as rubbish.
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) BTP=$(printf '\342\226\200')
                                   BBT=$(printf '\342\226\204')
                                   BS1=$(printf '\342\226\221')
                                   BS2=$(printf '\342\226\222')
                                   BS3=$(printf '\342\226\223')
                                   BS4=$(printf '\342\226\210')
                                   BSH=$BS4
                                   BHL=$BS1 ;;
    *) BTP="'"; BBT=','; BS1='.'; BS2=':'; BS3='+'; BS4='#'; BSH='#'; BHL=':' ;;
  esac
  # The shading wants 256 colours; with fewer, the hand is drawn in four
  # shades of block character instead.
  BCOLOR=0
  _colors=$(tput colors 2>/dev/null || echo 0)
  case "$_colors" in ''|*[!0-9]*) _colors=0 ;; esac
  if [ "$_colors" -ge 256 ] || [ -n "${COLORTERM:-}" ]; then BCOLOR=1; fi
  case "${TERM:-}" in *256color*|*truecolor*|*direct*) BCOLOR=1 ;; esac
  # Green for what is finished: the filled part of the bar and each ticked
  # box. Setup's own green where there are 256 colours, plain green otherwise.
  if [ "$BCOLOR" = 1 ]; then GREEN=$(printf '\033[38;5;108m'); else GREEN=$(printf '\033[32m'); fi
  RESET=$(printf '\033[0m')

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

# $2, when given, is the same text with colour added. It is printed in place
# of $1 but measured as $1: colour codes take no room on screen.
ui_centred() {
  _t="$1"
  _i=$(( (BW - ${#_t}) / 2 ))
  if [ "$_i" -lt 0 ]; then _i=0; fi
  if [ -n "${2:-}" ] && [ "$((_i + ${#_t}))" -le "$BW" ]; then
    printf '\033[2K%s%s%s\n' "$(spaces "$_i")" "$2" "$RESET"
    return 0
  fi
  ui_line "$(spaces "$_i")$_t"
}

ui_bar() {
  _done=$(( BSW * $1 / 100 ))
  _left=$(( BSW - _done ))
  _s=""; _r=""
  while [ "$_done" -gt 0 ]; do _s="$_s$BSH"; _done=$((_done - 1)); done
  while [ "$_left" -gt 0 ]; do _r="$_r$BHL"; _left=$((_left - 1)); done
  printf '\033[2K%s%s%s%s%s\n' "$(spaces "$BPAD")" "$GREEN" "$_s" "$RESET" "$_r"
}

# Which images have arrived, so a step that looks frozen still shows what has
# actually been finished. Names as a person would say them, not as the registry
# spells them. The ones still coming carry a dot that grows each redraw, so a
# box that has not been ticked yet is visibly being worked on rather than
# waiting its turn. $1 is the phase, 0 to 2.
images_line() {
  awk -v PH="$1" '$1 == "Image" && ($3 == "Pulling" || $3 == "Pulled") { seen[$2] = 1 }
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
           busy = substr("...", 1, PH + 1) substr("   ", 1, 2 - PH)
           out = out ((order[i] in got) ? "[ x ] " : "[" busy "] ") r "   "
         }
         print out
       }' "$LOG" 2>/dev/null
}

# Functions in sh share one set of variables, so anything ui_draw assigns is
# also assigned in whatever called it. These names are its own: when they were
# _pct and _label, a caller that passed "$_label$_detail" got that written back
# over its own _label and the detail appended again every second.
SPIN=0
ui_draw() {
  _dpct=$1; _dtext=$2
  SPIN=$(( (SPIN + 1) % 3 ))
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

  hand_frame
  ui_line ""
  ui_centred "C L O S E D H A N D"
  ui_centred "A personal AI assistant you actually own"
  ui_line ""
  ui_bar "$_dpct"
  ui_centred "$_dpct%  $_dtext"
  _il=$(images_line "$SPIN")
  ui_centred "$_il" "$(printf '%s' "$_il" | sed "s|\[ x \]|[ ${GREEN}x${RESET} ]|g")"
  ui_line ""
  ui_note
  UIDRAWN=1
}

# Whether the end of the install opens setup in a browser on this computer:
# not over SSH, and on Linux only with a desktop. The opening below asks this
# same question.
browser_here() {
  [ -z "${SSH_CONNECTION:-}" ] || return 1
  [ "$(uname -s 2>/dev/null)" = "Darwin" ] && return 0
  command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]
}

# The closing line says what Closedhand is and, where a browser will open,
# alternates every 8 seconds with what happens when installing ends. Around
# each change the line is faint for a frame, so it fades across instead of
# jumping. Faint rather than grey: greys are the fist's own colours.
NOTE_LAST=""
ui_note() {
  _nt="Your data stays with you."
  _faint=0
  if browser_here; then
    _now=$(date +%s 2>/dev/null) || _now=0
    case "$_now" in ''|*[!0-9]*) _now=0 ;; esac
    if [ $(( _now / 8 % 2 )) -eq 1 ]; then _nt="Setup opens in your browser when installation is done."; fi
    if [ -n "$NOTE_LAST" ] && [ "$_nt" != "$NOTE_LAST" ]; then _faint=1; fi
    if [ $(( _now % 8 )) -eq 7 ]; then _faint=1; fi
  fi
  NOTE_LAST=$_nt
  if [ "$_faint" = "1" ]; then ui_centred "$_nt" "$(printf '\033[2m')$_nt"; else ui_centred "$_nt"; fi
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
    say "Reset: removing Closedhand's containers, volumes and settings."
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f .env
  elif [ -d "$DIR" ] && [ -f "$DIR/docker-compose.yml" ]; then
    say "Reset: removing Closedhand's containers, volumes and $(pwd)/$DIR."
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
  # Said plainly: someone expecting a fresh start should see at once that this
  # is an update of what is already there.
  say "Updating the Closedhand already in $(pwd)/$DIR, keeping its settings and data."
else
  say "Installing into $(pwd)/$DIR"
fi

say "Raw output: tail -f $LOG"
say "Or re-run with CLOSEDHAND_PLAIN=1 for no drawing at all."

ui_init
: > "$LOG" 2>/dev/null || true

# --- Clone (or reuse a checkout we're already inside) ------------------------
if [ -f docker-compose.yml ] && [ -f .env.example ]; then
  step 0 "Using this checkout"
elif [ -d "$DIR" ]; then
  [ -f "$DIR/docker-compose.yml" ] || fail "$DIR exists but doesn't look like a Closedhand checkout. Remove it or set CLOSEDHAND_DIR."
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

# --- .env (first run only) ----------------------------------------------------
# Settings only. The secrets that used to be generated into it live in
# secrets/ (next step).
FIRST_INSTALL=0
if [ -f .env ]; then
  chmod 600 .env  # earlier installs left it readable by every account here
  step 28 "Keeping your settings"
else
  FIRST_INSTALL=1
  cp .env.example .env
  chmod 600 .env
  step 28 "Settings ready"
fi

# --- Secrets, one file each in secrets/ ---------------------------------------
# The database password, the encryption key and the keys the services share
# are files in secrets/, a folder only your account can open, and Docker hands
# each one only to the containers that use it (docker-compose.yml). None goes
# into .env or into any container's settings. An install from before keeps its
# values: they move out of .env once, and their lines are taken out of it.
# Never regenerate one that exists: the database password must keep matching
# the data, and the encryption key opens every sign-in already stored.
if command -v openssl >/dev/null 2>&1; then
  rand() { openssl rand -hex 24; }
  rand_key() { openssl rand -base64 32; }
else
  rand() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
  rand_key() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
fi
mkdir -p secrets
chmod 700 secrets
for pair in POSTGRES_PASSWORD:postgres_password TOKEN_ENCRYPTION_KEY:token_encryption_key \
            WS_AUTH_SECRET:ws_auth_secret SANDBOX_TOKEN:sandbox_token COOKIE_SECRET:cookie_secret; do
  var=${pair%%:*}
  file=secrets/${pair#*:}
  if [ ! -s "$file" ]; then
    value=$(grep -E "^$var=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')
    if [ -z "$value" ]; then
      if [ "$var" = TOKEN_ENCRYPTION_KEY ]; then value=$(rand_key); else value=$(rand); fi
    fi
    (umask 077; printf '%s' "$value" > "$file")
  fi
  chmod 600 "$file"
  if grep -qE "^$var=" .env 2>/dev/null; then
    grep -vE "^$var=" .env > .env.tmp && mv .env.tmp .env && chmod 600 .env
  fi
done
# The database reads its password as its own user inside its container, so
# that one file is readable there; the folder still keeps it from every other
# account on this computer.
chmod 644 secrets/postgres_password
step 30 "Secrets kept in secrets/, readable only by you"

# --- Up ----------------------------------------------------------------------
# Every update replaces Closedhand's images, and the ones it replaces would stay
# on disk for good, 3 to 5 GB each time, until the disk fills. Note exactly
# which images it runs on now; once the new version answers, those go. Nothing
# else on this computer is touched, and an image a container still uses stays.
closedhand_images() {
  for img in $(docker compose config --images 2>/dev/null); do
    docker image inspect --format '{{.Id}}' "$img" 2>/dev/null || true
  done
}
PREVIOUS_IMAGES=$(closedhand_images)

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
  if ! run_watched 30 65 "Downloading Closedhand" pull_progress docker compose pull; then
    step 30 "Download stalled, retrying"
    _w=10
    while [ "$_w" -gt 0 ]; do
      sleep 1
      if [ "$UI" = "1" ]; then ui_draw 30 "Download stalled, retrying"; fi
      _w=$((_w - 1))
    done
    if ! run_watched 30 65 "Downloading Closedhand" pull_progress docker compose pull; then
      run_watched 30 70 "Building from source" - \
        docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build \
        || die "both the download and the build failed."
      BUILT_FROM_SOURCE=1
    fi
  fi
fi

if [ "$BUILT_FROM_SOURCE" = "0" ]; then
  step 72 "Starting Closedhand"
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

if [ "$tries" -lt 45 ] && [ -n "$PREVIOUS_IMAGES" ]; then
  step 98 "Clearing out the old version"
  CURRENT_IMAGES=$(closedhand_images)
  for id in $PREVIOUS_IMAGES; do
    case " $(echo $CURRENT_IMAGES) " in *" $id "*) ;; *) docker image rm "$id" >/dev/null 2>&1 || true ;; esac
  done
fi

# Closedhand's containers start again whenever Docker does, so it is back after
# a restart only if Docker is. Docker Desktop doesn't open at sign-in unless
# asked: a Mac that restarted itself overnight left Closedhand off until
# someone opened Docker. A new install turns on Docker's own "Start Docker
# Desktop when you sign in", which its Settings show and can turn off again;
# a re-run to update leaves whatever the person chose.
AUTOSTART=""
start_with_computer() {
  [ "$FIRST_INSTALL" = "1" ] && [ "${CLOSEDHAND_NO_AUTOSTART:-0}" != "1" ] || return 0
  case "$(uname -s 2>/dev/null)" in
    Darwin)
      sock="$HOME/Library/Containers/com.docker.docker/Data/backend.sock"
      { [ -S "$sock" ] && command -v curl >/dev/null 2>&1; } || { AUTOSTART=ask; return 0; }
      autostart_on() { curl -fsS --max-time 5 --unix-socket "$sock" http://localhost/app/settings 2>/dev/null | grep -Eq '"autoStart": ?true'; }
      autostart_on && return 0
      curl -fsS --max-time 5 --unix-socket "$sock" -X POST -H 'Content-Type: application/json' \
        -d '{"desktop":{"autoStart":true}}' http://localhost/app/settings >/dev/null 2>&1 || true
      if autostart_on; then AUTOSTART=set; else AUTOSTART=ask; fi ;;
    Linux)
      command -v systemctl >/dev/null 2>&1 || return 0
      systemctl is-enabled docker >/dev/null 2>&1 || systemctl --user is-enabled docker-desktop >/dev/null 2>&1 \
        || AUTOSTART=linux ;;
  esac
}
start_with_computer

step 100 "Ready"

# Over SSH the browser belongs on the connecting computer, not this host.
OPENED=0
if browser_here; then
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then open "$DASH_URL" 2>/dev/null && OPENED=1
  else xdg-open "$DASH_URL" 2>/dev/null && OPENED=1; fi
fi

say ""
if [ -n "${SSH_CONNECTION:-}" ]; then
  say "Closedhand is running on this server. On your own computer, open a second"
  say "terminal and run the command below, using the same user and server address"
  say "you used to connect here:"
  say "  ssh -N -L 3000:127.0.0.1:3000 user@server"
  say "Keep that terminal open, then open $DASH_URL on your computer."
  say "Setup gives Closedhand its personal URL; Settings > Personal URL manages it."
elif [ "$OPENED" = "1" ]; then
  # A re-run is an update: setup was done the first time.
  if [ "$FIRST_INSTALL" = "1" ]; then say "Opening the setup page in your browser: $DASH_URL"
  else say "Opening Closedhand in your browser: $DASH_URL"; fi
elif [ "$FIRST_INSTALL" = "1" ]; then
  say "Open $DASH_URL in a browser to reach the setup page."
else
  say "Open $DASH_URL in a browser to reach Closedhand."
fi
case "$AUTOSTART" in
  set)
    say ""
    say "Closedhand starts again by itself after this computer restarts: Docker Desktop"
    say "now opens when you sign in. To stop that, turn off \"Start Docker Desktop when"
    say "you sign in\" in Docker Desktop's settings." ;;
  ask)
    say ""
    say "To have Closedhand start again by itself after this computer restarts, turn on"
    say "\"Start Docker Desktop when you sign in\" in Docker Desktop's settings." ;;
  linux)
    say ""
    say "To have Closedhand start again by itself after this computer restarts, run:"
    say "  sudo systemctl enable docker" ;;
esac
say ""
say "Closedhand browses and runs code on its own sandboxed computer. It can't see"
say "your files or the rest of your machine unless you give it explicit permission."
say "Watch it work in the Computers tab."
