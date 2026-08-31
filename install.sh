#!/bin/sh
# ClosedHand one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/notnotjim/ClosedHand/main/install.sh | sh
#
# Clones the repo, creates .env with generated secrets, and starts the stack.
# Idempotent: safe to re-run in place (it never overwrites an existing .env).
#
# Overrides (mostly for testing):
#   CLOSEDHAND_REPO   git URL to clone            (default: the public repo)
#   CLOSEDHAND_DIR    directory to install into   (default: ./closedhand)
#   CLOSEDHAND_NO_UP  set to 1 to skip docker compose up

set -eu

REPO="${CLOSEDHAND_REPO:-https://github.com/notnotjim/ClosedHand.git}"
DIR="${CLOSEDHAND_DIR:-closedhand}"

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# --- Banner ------------------------------------------------------------------
# Decoration only. The installer proper starts at "Preconditions" below.
#
# A hand closing into a fist, cut out of a slab of blocks and drawn to fit the
# terminal it finds. It is built so it can never be the reason an install
# fails: it needs a real terminal, awk, and a sleep that understands fractions,
# it skips itself when any of those are missing, and every error inside it is
# discarded.
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
      if (v && P > 0.35 && hx > tx1 && hx < tx2 && hy > ty1 - 1.6 && hy < ty1 - 0.2) v = 0
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
  awk -v W="$BSW" -v PAD="$BPAD" -v H="$BH" -v P="$1" -v FI="$BFI" -v SH="$BSH" -v HL="$BHL" \
      "$HAND_AWK" </dev/null
}

banner() {
  if [ ! -t 1 ] || [ "${TERM:-dumb}" = "dumb" ]; then return 0; fi
  if ! command -v awk >/dev/null 2>&1; then return 0; fi
  # A shell whose sleep only counts whole seconds would turn this into a
  # ten-second wait, which is not a flourish any more.
  if ! sleep 0.07 2>/dev/null; then return 0; fi

  BW=80; BH=20
  if command -v tput >/dev/null 2>&1; then
    c=$(tput cols 2>/dev/null || echo 80)
    l=$(tput lines 2>/dev/null || echo 24)
    case "$c" in ''|*[!0-9]*) c=80 ;; esac
    case "$l" in ''|*[!0-9]*) l=24 ;; esac
    BW=$((c - 1))
    BH=$((l - 9))
  fi
  if [ "$BH" -gt 30 ]; then BH=30; fi
  if [ "$BW" -lt 40 ] || [ "$BH" -lt 12 ]; then return 0; fi
  # The hand can only be as big as the terminal is tall, so on a wide terminal
  # a full-width slab would leave it stranded in the middle of a grey field.
  # Size the slab to the hand instead, then centre it in the space available.
  BSW=$(( ((BH - 2) * 115 / 100) * 23 / 10 ))
  if [ "$BSW" -gt "$BW" ]; then BSW=$BW; fi
  BPAD=$(( (BW - BSW) / 2 ))

  # Block characters need a UTF-8 locale; anywhere else they arrive as rubbish.
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) BFI=$(printf '\342\226\222')
                                   BSH=$(printf '\342\226\210')
                                   BHL=$(printf '\342\226\221') ;;
    *) BFI='.'; BSH='#'; BHL=':' ;;
  esac

  trap 'printf "\033[?25h"; exit 130' INT
  printf '\033[?25l\n'
  hand_frame 0
  for p in 0.12 0.25 0.38 0.50 0.63 0.76 0.88 1; do
    sleep 0.06 2>/dev/null || true
    printf '\033[%dA' "$BH"
    hand_frame "$p"
  done
  sleep 0.35 2>/dev/null || true
  printf '\033[?25h'
  trap - INT
}
banner 2>/dev/null || true

say ""
say "  C L O S E D H A N D"
say "  A personal AI assistant you actually own."
say ""

# --- Preconditions -----------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required. Install it and re-run."
command -v docker >/dev/null 2>&1 || fail "docker is required. Install Docker (or Docker Desktop) and re-run."
docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is required (docker compose version failed)."
docker info >/dev/null 2>&1 || fail "the docker daemon isn't running. Start Docker and re-run."

# --- Clone (or reuse a checkout we're already inside) ------------------------
if [ -f docker-compose.yml ] && [ -f .env.example ]; then
  say "Existing ClosedHand checkout detected, installing here."
elif [ -d "$DIR" ]; then
  [ -f "$DIR/docker-compose.yml" ] || fail "$DIR exists but doesn't look like a ClosedHand checkout. Remove it or set CLOSEDHAND_DIR."
  say "Reusing existing checkout in $DIR."
  cd "$DIR"
  # Re-running the installer doubles as the upgrade path: fast-forward a clean
  # checkout so the rebuild uses current code. Local edits are left alone.
  if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
    git pull --ff-only 2>/dev/null && say "Checkout updated." || true
  fi
else
  say "Cloning ClosedHand into $DIR..."
  git clone --depth 1 "$REPO" "$DIR"
  cd "$DIR"
fi

# --- .env with generated secrets (first run only) ----------------------------
# Never regenerate: POSTGRES_PASSWORD must keep matching the existing data
# volume, and rotating WS/sandbox secrets on re-run would break a live stack.
if [ -f .env ]; then
  say "Keeping existing .env."
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
  say "Created .env with generated secrets."
fi

# --- Up ----------------------------------------------------------------------
if [ "${CLOSEDHAND_NO_UP:-0}" = "1" ]; then
  say "CLOSEDHAND_NO_UP=1, skipping docker compose up."
elif [ "${CLOSEDHAND_BUILD:-0}" = "1" ]; then
  say "CLOSEDHAND_BUILD=1: building from source (a few minutes)..."
  if ! docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build; then
    say ""
    say "The build hit an error; this is usually a brief registry or network"
    say "blip. Retrying once in 10 seconds..."
    sleep 10
    docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
  fi
else
  say "Downloading pre-built images (first run only) and starting..."
  # One retry for a genuine blip, then build from source. A missing or private
  # image is not a network problem and pulling it again cannot fix it, so the
  # fallback is the thing that actually works: slower, but it always boots.
  if ! docker compose pull; then
    say ""
    say "The download hit an error; this is usually a brief registry or"
    say "network blip. Retrying once in 10 seconds..."
    sleep 10
    if ! docker compose pull; then
      say ""
      say "Still no luck, so the pre-built images are unavailable to this"
      say "machine. Building from source instead (a few minutes, one time)."
      docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
      BUILT_FROM_SOURCE=1
    fi
  fi
  [ "${BUILT_FROM_SOURCE:-0}" = "1" ] || docker compose up -d
fi

# Take the user to the wizard rather than telling them an address to type.
# Wait until the dashboard actually answers (first boot includes a database
# init, usually well under a minute), then open the default browser where a
# desktop exists. On a headless server there is no browser to open, so the
# printed address below is the whole story there, and it never only says
# "opening..." without printing the address, because the open can fail
# silently in odd environments.
DASH_URL="http://localhost:3000"
say ""
say "ClosedHand is starting. Waiting for the dashboard to come up..."
tries=0
while [ "$tries" -lt 45 ]; do
  if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null --max-time 2 "$DASH_URL" 2>/dev/null; then
    break
  fi
  tries=$((tries + 1))
  sleep 2
done

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
