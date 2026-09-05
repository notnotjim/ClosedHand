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
# then held while the install runs. Eight frames of 32 by 28 shaded pixels,
# run-length coded; scripts/hand-frames.py renders them from a lit model.
HAND_FRAMES='44a1w1v1m28a1q1y1v1p1h27a1u1w1t1n1f2a1w1v1m17a1w1v1m2a1t1v1s1m1e1a1q1y1v1p1h15a1q1y1v1p1h1a1t1v1s1m1e1a1u1w1t1n1f15a1u1w1t1n1f1a1t1v1s1m1e1a1t1v1s1m1e15a1t1v1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e15a1t1v1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e2a1w1v1m6a1x1v1p1k1u1v1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e1a1q1y1v1p1h4a2x1u1r3v1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e1a1u1w1t1n1f4a1m4s2v1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e5a1n1q2s1w1u1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e5a1f1n1r1s1v1u1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e1a1t1v1s1m1e6a1g1o1r1t1u1s1m1j1k2v1s1m2k1w1v1s1m2k2v1s1m1j1l1t1o4a1g1o1s1u1s1m1q2w1u1s1n1r1w1x1u1s1n1r2w1u1s1n1q1w1q1f5a1g1p1r1p1o1s1u1v1s2p1t1u1v1t1q1p1t1u1v1s1p1o2s1l1f6a1h1n1o1p1s2t1r1q1r1t2s1r1q1r3s1r1p1q1s1q1l1e7a1h1n1q2t17s1q1l1e8a1j1t1u1t17s1q1l1e8a1o1v1u17s1r1q1l1e8a1q1v1s10q8p1o1l1f8a1r1p3k1p7o1m4j4k1i1f8a1m2e1d1k1t6r1q1l7d3e12a1u1v6t1r1g22a1u1v1t5s1q1g22a1u1v1t5s1q1g22a1n1h1f7e11a
76a1x1u1l28a2x1u1p1k2a1n1r1i17a1p1t1j2a1t1v1s1n1e1a1q1y1w1q1h15a1q1y1w1q1h1a1t1v1s1n1e1a1v1w1u1o1g15a1u1w1u1o1f1a1t1v1s1n1e1a1t1v1s1n1e15a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e15a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e2a1x1v1m7a1n2a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1u1y1v1p1j5a1x1w1s1j2v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1u1v1t1n1e4a2x1v2t1w1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e4a1q3s1t1v1u1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e4a1g1h1o1r1s1u1t1s1n1h1k1u1v1s1n1h1k1u1v1s1n1h1k1u1v1s1n2h1l1n3a1j1n1q1s1t1s1n1p2w1v1s1n1q1w1x1v1s1n1q2w1v1s1n1o1v1s1h4a1h1l1p1t1s1p1t1v1w1u1s1p1u1v1w1t1s1p1t1v1w1t1s1o1r1s1l1f5a1f1g1q1p1r2t1u1s2q4t1q1r3t1s1q1p1r1p1k1f7a1i1l1q2s1r1s1r5s1r4s1r1q2r1p1k1e8a1k2s1r16s1r1p1k1e8a1r1u1t1s1t15s1r1p1k1e8a1u1v1t8s9r1q1p1k1f8a1u1t1q14p4o1n1k1f8a1s1n3k5o3n1l6j2k1i1f8a1k2e1d1k1t6r1p1l7d3e12a1t1v6t1q1g22a1u1v1t5s1q1g22a1u1v1t5s1q1g22a1n1h1f7e11a
76a1t1v1k28a1u1y1w1q1j23a1n3a1u1w1t1o1e2a1x1u1m16a1p1x1w1q1h1a1t1v1s1n1e1a1w1x1v1p1k15a1v1x1u1p1g1a1t1v1s1n1e1a1t1v1t1n1e15a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e15a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e2a1x1u1m10a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a2x1v1q1k6a1q1i1a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1t1o1e5a2x1u1t1w1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e4a1u1x1v1u1t1v1u1s1n1f1k1t1v1s1n1f1k1t1v1s1n1f1k1t1v1s1n1f1g1k1p1a1o1t2s2t1u1s2n1k1w1v1s1n1o1v1w1v1s2n1v1w1v1s1n1l1n1t1j1a1h1g1n1p1r1s1t2r1s1v1w1u1s1p1t2w1u1s1p1t1v1w1u1s1n1q1t1m1f3a1h1i1n1p1r1s3t1v1t2r3u1t2r2u1v1t1r1o1r1p1k1f4a1e1f1j1n1p1r1s3t1r1s4t1r5s1q1p1q1o1k1e6a1e1k1n1o1p1r2s1q11s1q1r1q1o1k1e7a1h1n3r1q1p1r12s1r1q1o1k1e7a1m1t2u1r1q1r13s1r1q1o1k1e7a1p1v1u1t1s14r2q1p1o1k1f7a1q1v1s3p16o1n1k1f7a1s1r1l3k2o6n1l6j2k1i1f7a1m1f2e1d1j1s2r4q1o1k6d4e12a1t1v1t5s1q1g22a1u1v1t5s1q1g22a1u1v1t5s1q1g22a1n1h1f7e11a
107a1p1x1u1q1h27a1v1x1v1q1g2a1v1u1l17a1x1u1m2a1t1v1t1o1e1a1u1y1v1q1j15a1w1x1v1q1k1a1t1v1s1n1e1a1u1w1t1o1e15a1t1v1t1o1e1a1t1v1s1n1e1a1t1v1s1n1e15a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1k1x1u1p1g9a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1w1x1v1q1h9a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1t1o1e6a1r1j1a1s1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e5a1w1x1v1t1u1v1s1n2k2v1s1n1l1j2v1s1n1l1j2v1s1n1j1l1t1l1a1u1x1v4u1t1o1p1t1w1v1s1o1s2w1u1s1o1r2w1v1s1n1o1t1n1f1a1o1t2s2t1u1t1s1t1v1x1u1s1r1u2v1u1s1r1u1v1w1u1s1p1q1p1k1f1a1g2m1o1p1r1s2t4u1t1s2u2t2s4t1r1o1p1n1k1e2a3e1k1m1o1q1r1s1t2u1s2t9s1q2p1n1k1e5a2e1i1l1n1p1q1r1s1t1s1q9s2r1p1n1k1e7a1g1j3q2p1q1o1q9s2r1p1n1k1e7a1p1s1u1t1r2q2p7s5r1p1n1k1e7a1s1v1u1s3r2q1r11q1p1n1k1f7a2u1r1p7o11n1m1k1f7a1t1o2l2k5n3m1k6j2k1j1g7a1k2e2d1j1s1r5q1o1h6d4e12a1r1v1t5s1q1g22a1u1v1t5s1q1g22a1u1v1t5s1q1g22a1n1h1f7e11a
108a1r1u1k28a1u1y1w1r1j2a1p1t1i17a1v1u1l2a1u1w1u1p1e1a1r1y1w1r1i15a1u1y1v1r1j1a1t1v1s1n1e1a1u1w1u1p1f15a1u1w1t1p1e1a1t1v1s1n1e1a1t1v1s1o1e3a1n11a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1q2w1r1i9a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1v1x1v1q1g9a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1s1n1e1a1t1v1t1o1e9a1t1v1s1n1i1k1u1v1s1n2j2v1s1n1j1k2v1s1n1i1h2n3a1s1o1j1s1v1s2n1v1w1v1s1n1q2w1v1s1n1q2w1v1s1n1m1n1p1g2a1w1x1v1u2v1t2p1u1w1u1s1q1u1v1w1u1s1q1u1v1w1u1s1o1p1q1k1f1a1t1x1w4u2t1u1v1w1u1s1t4u1s1t3u1t1s2p1n1k1f1a1p1t1s1r1s2t7u1v1u3t1s2t2s1t1r2o1n1k1f1a1g3n1o1p1q1r1s2t4u2t8s1q2p1n1k1f2a1f2e1h1k1l1n1o1p1q1r1s3t1s1q6s2r1q1p1n1k1f5a1d1e1h1l1m3n1o1p1q1r1o1p6s2r1q1p1n1k1f6a1g1j1m1p1q1p1o2p1o1n1m1q8r1q1p1n1k1f6a1m1s1v1t2r2q1p1o1n1o3q7p1o1n1k1f6a1p1v1t1p5o14n1m1k1f6a1q1s1m2l2k1m2n5m6j3k1j1f6a1m1g3e1d1j1r2q4p1n1h5d5e12a1p1v1t5s1q1g22a1u1v1t5s1q1g22a1u1v1t5s1q1g22a1n1h1f7e11a
109a1l29a1q1w1v1r1i3a1n18a1r1t1k2a1v1x1v1q1g1a1q2w1r1i15a1s1y1w1r1j1a1t1v1t1o1e1a1v1x1v1q1g15a1u1w1u1p1e1a1t1u1s1o1e1a1t1v1t1o1e2a1n1q1i10a1t1v1s1o1e1a1t1u1s1o1e1a1t1u1s1o1e1a1r1y1w1r1i9a1t1u1s1o1e1a1t1u1s1o1e1a1t1u1s1o1e1a1u1x1u1q1f9a1t1u1s1o1h1k2u1s1o1h1k2u1s1o1h1k1u1v1s1o2g2p6a1t1u1s1o1l1k1v1u1s2o2w1u1s1o1n1w1v1u1s1o1k1m1q1g6a1q1u1s1o1q2w1u1s1p1t2w1u1s1p1t1v1w1u1s2o1q1k1g3a1s1p1m1n1w1s1q1s1v1w1u1s1t3v1u1s1t2u1v1t1s2o1n1k1f2a1w1x1w2v1u1t1u1p1v1w1v1t5u6t1s1p1n1m1k1f1a1s1x1w3u5v2u3v1u1t6s1t1r1o1n1m1k1f1a1p2t1r2s3t3u3v3u1t4s2r1q1p1o1m1k1f1a1g1o3n1o1p2q1r2s3t3u1r1q3s3r1q1o1m1k1f2a1f2e1f1i1j1k1l1m1n1o1p2q3r2o1r1s4r1q1o1m1k1f5a2d1f1i1l7m2n1k1o2r4q1p1o1m1k1f6a1h1l1m1o4n4m1k1l7p2o1m1k1f6a1p1t1r4o4n1m1l3n5m1n2m1k1f6a1r1q3l2k4m4l6j3k1j1g6a1l4e1d1j1r1q5p1n1h4d6e12a1o1v1t5s1q1g22a1u1v1t5s1q1g22a1u1v1t5s1q1g22a1n1h1f7e11a
140a1v1u1l4a1l18a1r1t1k2a1w1y1v1r1k1a1q2w1r1i15a1s1y1w1r1j1a1t1w1t1p1e1a1v1x1v1q1g15a1u1w1u1q1e1a1t1v1s1o1e1a1t1v1t1p1e2a1v1u1m10a1t1v1s1o1e1a1t1u1s1o1e1a1t1u1s1o1e1a1u1y1w1r1j8a1k1t1u1s1o1f1k2u1s1o1f1k2u1s1o1f1k1v1w1u1p2g1m1o5a1j2u1s1o2k1v1u1s1o1m1k1v1u1s1o1l1k2v1s1o1j1l1o1i5a1j2u1s1o1p2w1u1s1p1s2w1u1s1o1r2w1u1s1o1m1p1l1g5a1j2u1s1p1t2w1u2s3v1u1t1s2u1w1u1s1o2n1k1f5a1k1p1u1s1q1u2v1u1t5u1t2u1t1u1t1s1o1n1m1k1f2a1l1s1p2o1q1s1o1p1u1v3u7t2s1t1s1o2m1k1f2a1v1y1w12v3u1t3s1r1s1q1n2m1k1f1a1p1x1w1v2u13v1u1t1s3r1q2o1m1k1f1a1o2t2r3s4t5u2v1u1q1p3r1q1p1o1m1k1f1a1f2o2n3o2p3q3r3s1r1o1n1q2r1q1p1o1m1k1f2a1f2e1f2h1i1j2k2l1m2n3o1n1j1l1p2q2p1o1m1k1f5a1e1d1e1f1g2h1i6k1j1i1h1k5o1n1m1k1f5a1g1k1l1k2j4i3h3g1i2l6m1k1f5a1o1r1o1l3k1j2k1j2i2h1i1h1i4j3k1j1g5a1n1h4e1d1i1o2p4o1n1h4d6e12a1m1v1t5s1q1f22a1u1v1t5s1q1g22a1u1v1t5s1q1g22a1n1h1f7e11a
140a1s1t1k4a1l18a1s1t1k2a1v1y1w1s1k1a1r2w1s1i15a1v1y1w1s1q1k2w1u1q1k1j1y1x1v1s1l1e2a1l10a1o2w1u1q1l1j2t1r1n2i2v1t1p1j1h1r2w1s1i8a1k2t1r1n2h1t1s1q1m1h1i2s1q1m1g1i2x1v1s1l1f7a1h2s1q1m1h1j2u1s1o2k2t1r1n1j1k2v1t1p1j1h1m1l5a1j2u1s1o1n1v1w1u1s1o1r2w1u1s1o1p1x1u1s1q1m2h1j1g5a1j2u1s1o1s2w1u2s2v1w1u1s1r1u2v1t1r1n1k1l1h1f5a1j2u1s1q1u2v3u3v1u1t4u1t1s1o1m1l1h1f5a1j2u1s1r1u1v8u6t1s1o1m1l1h1f5a1k1q1p1t1n3u7t6s1r1o2l1i1f2a1l1r1q9p3v5u1t1s1q1r1q1m1l1m1i1f2a1t1y11w7v1t1q1p1q1p2n1m1j1f1a1o2w1v5u12v1u1p1n1o1q1p1n1m1k1f1a1o1u1t1s3r9s5t1r1n2m2p1n1m1k1f1a1f2p5n6o7p1o1k1h1l1p1o1n1m1k1f2a1f1e3g4h3i4j4k1j1e1f1m2o1n1m1k1f4a4c4d1e9f1e1d1j2l3m1k1g5a1g1i7g1h3g3f2e1g1i1j4k1j1g5a1j1e5d1h7k1j1h3d7e12a1m1v1t5s1q1f22a1u1v1t5s1q1g22a1u1v1t5s1q1g22a1n1h1f7e11a'

HAND_AWK='# One frame of the hand. FR is 32x28 pixels of grey level, run-length coded
# as <count><letter>, a = background and b..y = dark to light. A terminal
# cell shows two pixels, one above the other, using the half-block glyphs.
#   K  cells per pixel, sideways     PAD  blank columns on the left
#   COLOR  1 = 256-colour greys, 0 = shades of block characters
#   FU TP BT  full, top and bottom half blocks    SH1..SH4  the mono ramp
BEGIN {
  n = 0; i = 1; L = length(FR)
  while (i <= L) {
    c = ""; ch = substr(FR, i, 1)
    while (ch >= "0" && ch <= "9") { c = c ch; i++; ch = substr(FR, i, 1) }
    v = index("abcdefghijklmnopqrstuvwxy", ch) - 1
    for (k = 0; k < c + 0; k++) { px[n % 32, int(n / 32)] = v; n++ }
    i++
  }
  margin = ""
  for (k = 0; k < PAD; k++) margin = margin " "
  rows = 14 * K
  for (r = 0; r < rows; r++) {
    line = margin
    for (c = 0; c < 32 * K; c++) {
      t = px[int(c / K), int((2 * r) / K)]
      b = px[int(c / K), int((2 * r + 1) / K)]
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

# Print frame N (1 to 8) of the hand at the size ui_init settled on.
hand_frame() {
  _fr=$(printf '%s\n' "$HAND_FRAMES" | sed -n "${1}p")
  awk -v FR="$_fr" -v K="$BK" -v PAD="$BPAD" -v COLOR="$BCOLOR" \
      -v TP="$BTP" -v BT="$BBT" \
      -v SH1="$BS1" -v SH2="$BS2" -v SH3="$BS3" -v SH4="$BS4" "$HAND_AWK" </dev/null
}
HAND_FRAME=8

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
  while [ "$_f" -le 8 ]; do
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
