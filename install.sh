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
# The ClosedHand fist, held while the install runs. Taken from the brand icon
# (webapp/public/fist.png) by scripts/hand-frames.py: a shaded pixel picture,
# run-length coded, at two sizes.
HAND_FIST_32='11a2d2a1f1h2i1f1d1f2g1f13a2d1a1d1g3i1g10i1g10a1e1h2i2h6i1k1p1l3i1k1j2i1f8a1e7i1n1q1k2i1s1u1t1j1i1l2t1k1i1h8a1h1i1j1q1p2i1k2u1r2i1s2t1j1i1n2t1n1i1h8a2i1p2v1m1i1l2u1r2i1s2t1j1i1n1t1s1n1i1h8a2i1q2v1n1i1l2u1r2i1s2t1j1i1n2s1n1i1h8a2i1q1v1u1n1i1l1u1p1n2i3o1j1i1n2s1n1i1h8a2i1o2u1m1i1l1n10i1j1m1l1i1h8a1g2i1o1n18i1h8a1f9i1n5t1s1r1p1m1j2i1h1d7a1f2i2j1n1p3i1j1s3t5s1r1n2i1f7a1f1i1j3u1t1s1o2i1j3l1n5s1r1l1i1h7a1f1i1j3u3t1p6i1k3s2r1n2i7a1f1i1j2u5t1s1o1m2l2i1p1s3r1n2i7a1f1i1j1u7t4s1j1i1p4r1n2i7a1f1i1j7t5s1q1p1s4r1m1i1h7a1f2i6t8s5r1k1i1g7a1e2i1r4t8s6r1j1i1f7a1d2i1p4t7s6r1p2i1e8a1h1i1m3t7s7r1m2i1d8a1g1i1j1s1t7s7r1q2i1g9a1d2i1m7s7r1q1l2i1e10a1g2i1o5s7r1q1n2i1g11a1d1h2i1n4s6r1p1l2i1h1d12a1e1h2i1j1m1n2o3n1m1k3i1h1e14a1d1g13i1g1d17a1e1g1h6i1h1g1f1d10a'
HAND_FIST_48='24a1e1h2i1h1g1d2a1d2f1e1d26a1d1f2g1f1e1d1g6i1h1e1g5i1f19a1e1d3a1f6i1h16i1g15a1d1g3i1h1g1f11i1l1m1j11i1f13a1e18i1o2u1s1j3i1j1p1q1n4i1d11a1d1h10i1m2u1o4i1t1u2t1n3i1p3t1m3i1e11a1f3i1j2n5i4u1k3i1u3t1o3i1r3t1p3i1e11a1h3i1t2v1r3i1k4u1m3i4t1o3i1r2t1s1p3i1e11a3i1m4v1k2i1k4u1m3i4t1o3i1r2t1s1p3i1e11a3i1m4v1k2i1k4u1m3i4t1n3i1r1t2s1p3i1e11a3i1m3v1u1k2i1k4u1m3i4t1n3i1r3s1p3i1e11a3i1m2v2u1k2i1k1u1s1n1m1j3i4m1k3i1q3s1p3i1e11a3i1l1v3u1k2i1k1r16i1j1l2o3i1e11a1h3i1r2u1p3i1j1m23i1e11a1f4i2l29i1d11a1e14i1j8t2s1r1p1n1k6i1e11a1e8i1k6i1r6t7s1r1n1j3i1h11a1e3i1j1i1j1l1q1u1n5i1k1s4t10s1q1j3i1e10a1e3i1p5u1t1s1o1j3i1j1m4n1p9s1p3i1g10a1e3i1p4u4t1r1j9i1k1r6s2r1j2i1h10a1e3i1p4u5t1q1j9i1m5s3r1k3i10a1e3i1p2u8t1s1o1l1j7i1q3s4r1l3i10a1e3i1p2u11t4s1p3i1o2s5r1l3i10a1e3i1p1u11t6s1j2i1q1s6r1k2i1h10a1e3i1p11t7s1q1n1p1s7r3i1h10a1d3i1n10t11s7r1q3i1g11a3i1m9t11s8r1p3i1f11a1h2i1l8t12s8r1n3i1e11a1g2i1j7t12s9r1l3i1d11a1g3i1s5t12s9r1q1j2i1h12a1f3i1o5t11s10r1o3i1f12a1d3i1k4t11s10r1q1k3i1e13a1g3i1q2t11s10r1q1o3i1h14a1e3i1k1t11s10r2q1k3i1e15a1h3i1o10s10r2q1m3i1h16a1e4i1o8s10r2q1l4i1e17a1f4i1m6s11r1q1k4i1f19a1g4i1j1o1r2s9r1q1n1k5i1g21a1g6i1j1k7l1k1j7i1g23a1g21i1h1e25a1e1g17i1h1f1d28a1d1f1g2h7i2h1g1f1d16a'
HAND_FIST_64='32a1e1g3i1h1g1d5a3e1d38a4e3a1e1h8i1g1a1e1g5i1h1f34a1f5i1h1f1d1h10i1g9i1g1d24a2e4a1d1h31i1h21a1f1h4i1h1f1e16i2k16i1f18a1e1h23i1l1t2u1q7i1l2m1j5i1d17a1h14i1j2l7i1t2u2t1o5i1m3t1r1j4i1f16a1g14i1l3u1s1j4i1k2u3t1r4i1j1s4t1n4i1f15a1e5i1j2m1j6i1t4u1r4i1k1u4t1r4i1l5t1q4i1g15a1g4i1l1t2v1u1l4i1k6u4i1k5t1r4i1l4t1s1q4i1g15a1h4i1t4v1s4i1k6u4i1k5t1r4i1l4t1s1q4i1g15a4i1k6v4i1k6u4i1k5t1r4i1l3t2s1q4i1g15a4i1l6v4i1k6u4i1k5t1r4i1l2t3s1q4i1g15a4i1l5v1u4i1k6u4i1k5t1r4i1l1t4s1q4i1g15a4i1l4v2u4i1k6u4i1k5t1r4i1l5s1q4i1g15a4i1l3v3u4i1k2u1o1j17i1k1q4s1q4i1g15a4i1k2v4u4i1k1u1m21i1j1l1p1r1q4i1g15a1h4i1r1v3u1q4i1k1q26i1k4i1g15a1g4i1j1p1u1t1p6i1l31i1f15a1e47i1e16a20i1q10t3s1q1o1n1l9i1e16a20i1n9t9s1o1k7i1d15a10i1j1p1l7i1j1r8t11s1q1m5i1h15a5i1l2i1l1o1t2u1n7i1k1s6t14s1n5i1e14a5i8u1t1r1m1j5i1j1m5o1p13s1r1k4i1f14a5i7u5t1l13i1m10s2r1o4i1g14a5i6u7t1l13i1k1r7s4r4i1h14a5i5u8t1s1l13i1m6s5r1j4i14a5i4u11t1q1l12i1r4s6r1k4i14a5i3u14t1r1q5o1k4i1o3s7r1k4i14a5i2u15t7s1p4i1o2s8r1j4i14a5i1u15t8s1r1j3i1q1s9r4i1h14a5i1u15t9s1q2k1o2s8r1q4i1h14a5i15t15s9r1p4i1g14a1h4i1r13t15s10r1m4i1f14a1g4i1q12t15s11r1l4i1e14a1g4i1p11t15s12r1j4i1e14a1f4i1n10t15s12r1p5i15a1d4i1l9t15s13r1m4i1g16a1h4i8t15s14r1k4i1e16a1g4i1q6t15s14r1q5i17a1f4i1n5t15s14r1q1m4i1g17a1e5i1s3t15s14r2q1j4i1e18a1h4i1n2t16s13r2q1m4i1h19a1f5i1r1t15s13r2q1p5i1f20a5i1k15s13r3q1k5i21a1f5i1n13s14r2q1l5i1f22a1h5i1o11s13r3q1l5i1h23a1d1h5i1m9s14r1q1o1k5i1h1d24a1e6i1j1p6s14r1p1l7i1e26a1f7i1k1n1q2s11r1q1o1m1k8i1f28a1f10i1j9k1j12i1e30a1e1h29i1g1d33a1g26i1h1e36a1e1g22i1g1e41a1e2g2h9i3h1g1f1e23a'

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
  case "$BSW" in 64) _fr=$HAND_FIST_64 ;; 48) _fr=$HAND_FIST_48 ;; *) _fr=$HAND_FIST_32 ;; esac
  awk -v FR="$_fr" -v PW="$BSW" -v ROWS="$BH" -v PAD="$BPAD" -v COLOR="$BCOLOR" \
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
  # The hand comes in two sizes, 32 cells wide by 14 tall and 48 by 21, and a
  # terminal that cannot fit the small one gets plain lines. The larger one
  # sat too big over the wordmark at 64 wide, so 48 is the top size.
  if [ "$BH" -ge 21 ] && [ "$BW" -ge 70 ]; then BSW=48; BH=21; BMID=23
  elif [ "$BH" -ge 14 ] && [ "$BW" -ge 60 ]; then BSW=32; BH=14; BMID=15
  else return 0; fi
  BK=1
  # Centre the fist on the wordmark under it, not the frame on the terminal:
  # the picture sits a few pixels in from the frame's edges, so the frame is
  # placed so the picture's own middle column lands on the middle of the
  # 21-character wordmark.
  BPAD=$(( (BW - 21) / 2 + 10 - BMID ))
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
  ui_centred "A personal AI assistant you actually own."
  ui_line ""
  ui_bar "$_dpct"
  ui_centred "$_dpct%  $_dtext"
  ui_centred "$(images_line "$SPIN")"
  ui_line ""
  ui_centred "Everything stays on this machine. No ClosedHand account required."
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
    _w=10
    while [ "$_w" -gt 0 ]; do
      sleep 1
      if [ "$UI" = "1" ]; then ui_draw 30 "Download stalled, retrying"; fi
      _w=$((_w - 1))
    done
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
if [ -n "${SSH_CONNECTION:-}" ]; then
  # The browser belongs on the connecting computer, not this SSH host.
  OPENED=0
elif command -v open >/dev/null 2>&1; then
  open "$DASH_URL" 2>/dev/null && OPENED=1
elif command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  xdg-open "$DASH_URL" 2>/dev/null && OPENED=1
fi

say ""
if [ -n "${SSH_CONNECTION:-}" ]; then
  say "ClosedHand is running on this server. On your own computer, open a second"
  say "terminal and run the command below, using the same user and server address"
  say "you used to connect here:"
  say "  ssh -N -L 3000:127.0.0.1:3000 user@server"
  say "Keep that terminal open, then open $DASH_URL on your computer."
  say "After setup, Settings > Dashboard link explains personal address access."
elif [ "$OPENED" = "1" ]; then
  say "Opening the setup page in your browser: $DASH_URL"
else
  say "Open $DASH_URL in a browser to reach the setup page."
fi
say ""
say "ClosedHand browses and runs code on its own sandboxed computer. It cannot"
say "see your files or the rest of your machine. Watch it work in Computers."
