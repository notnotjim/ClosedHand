#!/bin/sh
# Films the desktop home page's smoke ring, with the ClosedHand fist in 3D
# inside it, for phones and tablets, which play it as a small looping video
# instead of running 3D. The ring uses the desktop's own shaders, read from
# views/home.html, so a change there is filmed exactly. The fist is
# fist.svg (the logo traced with potrace), extruded as thin glass.
# Needs Google Chrome, ffmpeg with hevc_videotoolbox and libvpx-vp9 (macOS),
# Python 3 with Pillow, and Playwright (PW=/path/to/node_modules/playwright).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
python3 - "$ROOT/views/home.html" "$HERE/shaders.js" <<'PY'
import sys
s = open(sys.argv[1]).read()
def take(start):
    a = s.index(start); b = s.index("].join('\\n');", a) + len("].join('\\n');")
    return s[a:b]
open(sys.argv[2], 'w').write(take("  var vertexShader = [") + "\n" + take("  var fragmentShader = [") + "\n")
PY
# 200 frames make a 10 second loop at 20 frames a second. 0.0375 is the
# smoke's drift through the noise (with the ring's sway in film.html, three
# quarters of what it was, so the smoke moves slower while the fist keeps its
# pace); the fist is 2.3 tall and 0.12 deep, thinner than its stroke so a
# turned side wall stays a slim edge.
node "$HERE/film.js" 200 0.0375 2.3 0.12 "$WORK/frames"
cd "$WORK"
# Frames are 1296 pixels (see film.html); the videos are 648, what a phone
# shows (216 CSS pixels at three device pixels each), so nothing is blown up.
ffmpeg -hide_banner -loglevel error -y -framerate 20 -i frames/f%04d.png -vf "scale=648:648:flags=lanczos" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 600k -pass 1 -row-mt 1 -deadline good -an -f null /dev/null
ffmpeg -hide_banner -loglevel error -y -framerate 20 -i frames/f%04d.png -vf "scale=648:648:flags=lanczos" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 600k -pass 2 -row-mt 1 -deadline good -an "$ROOT/public/orb/ring-glass.webm"
# Safari's HEVC transparency expects colour already multiplied by its
# opacity; handed plain colour it shows every faint wisp at full strength.
python3 - <<'PY'
import glob, os
from PIL import Image, ImageChops
os.makedirs('premultiplied', exist_ok=True)
for p in sorted(glob.glob('frames/f*.png')):
    r, g, b, a = Image.open(p).convert('RGBA').split()
    Image.merge('RGBA', [ImageChops.multiply(c, a) for c in (r, g, b)] + [a]).save('premultiplied/' + os.path.basename(p))
PY
ffmpeg -hide_banner -loglevel error -y -framerate 20 -i premultiplied/f%04d.png -vf "scale=648:648:flags=lanczos" -c:v hevc_videotoolbox -alpha_quality 0.5 -b:v 700k -tag:v hvc1 -an "$ROOT/public/orb/ring-glass.mov"
python3 -c "
from PIL import Image
im = Image.open('frames/f0000.png').convert('RGBA').resize((648, 648), Image.LANCZOS)
im.quantize(colors=255, method=Image.Quantize.FASTOCTREE).save('$ROOT/public/orb/ring-glass-poster.png', optimize=True)"
rm -rf "$WORK" "$HERE/shaders.js"
echo "Wrote public/orb/ring-glass.webm, ring-glass.mov and ring-glass-poster.png"
