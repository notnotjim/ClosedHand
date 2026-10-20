#!/usr/bin/env python3
# scripts/brand.py: Closedhand's fist, everywhere it appears, from one place.
#
# Each mark is a full set of the files the fist lives in (brand/marks/<name>/,
# mirroring the repo's paths) plus the two installer art lines. Putting a set
# in place is a copy, so going back is one command:
#
#   python3 scripts/brand.py use brush        the brush-drawn one-line fist
#   python3 scripts/brand.py use original     the fist before it
#   python3 scripts/brand.py which            the set in place now
#
# Building the brush set (needs Pillow and potrace; the 3D ring film also
# needs Chrome, ffmpeg and Playwright, see closedhand-com/tools/ring-video):
#
#   python3 scripts/brand.py build-brush [--film]
#
# Every file is drawn the way the original is: the same canvas, colour and
# placement, the app icon on the same dark gradient, the circle mark in the
# same ring, the favicon the same colour-following mask.
import math, os, shutil, subprocess, sys, base64, re, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKS = os.path.join(ROOT, "brand", "marks")
ACTIVE = os.path.join(ROOT, "brand", "ACTIVE")

# The files a set holds, by their place in the repo.
FILES = [
    "closedhand-com/public/fist.png",
    "closedhand-com/public/logo.png",
    "closedhand-com/public/logocircle.png",
    "closedhand-com/public/orb/ring-glass.webm",
    "closedhand-com/public/orb/ring-glass.mov",
    "closedhand-com/public/orb/ring-glass-poster.png",
    "closedhand-com/tools/ring-video/fist.svg",
    "webapp/public/fist.png",
    "webapp/public/logo.png",
    "webapp/public/logocircle.png",
    "webapp/public/favicon.svg",
    "webapp/public/favicon.ico",
    "desktop/AppIcon.icns",
    "desktop/dmg/fist-dark.png",
    "desktop/Sources/ClosedHand/Resources/logo.png",
    "bridge-app/Sources/Resources/logo.png",
]
INSTALL = os.path.join(ROOT, "install.sh")
ART = re.compile(r"^(HAND_FIST_(?:32|64))='[^']*'$", re.M)

# Cream on dark, ink on light, white for the menu bar, and the mid-tone the
# .ico favicon uses so it reads on light and dark tab bars alike.
CREAM, INK, WHITE, MID = (239, 230, 214), (16, 14, 13), (255, 255, 255), (134, 129, 120)


def use(name):
    src = os.path.join(MARKS, name)
    if not os.path.isdir(src):
        sys.exit(f"No mark called {name}. There are: {', '.join(sorted(os.listdir(MARKS)))}")
    for rel in FILES:
        shutil.copyfile(os.path.join(src, rel), os.path.join(ROOT, rel))
    art = dict(line.split("=", 1) for line in open(os.path.join(src, "install-art.txt")).read().splitlines() if "=" in line)
    script = open(INSTALL).read()
    script = ART.sub(lambda m: f"{m.group(1)}={art[m.group(1)]}", script)
    open(INSTALL, "w").write(script)
    open(ACTIVE, "w").write(name + "\n")
    print(f"The {name} fist is in place ({len(FILES)} files and the installer art).")


def save(name):
    """Copy the files in place now into a set (used once, to keep the original)."""
    dst = os.path.join(MARKS, name)
    for rel in FILES:
        os.makedirs(os.path.dirname(os.path.join(dst, rel)), exist_ok=True)
        shutil.copyfile(os.path.join(ROOT, rel), os.path.join(dst, rel))
    open(os.path.join(dst, "install-art.txt"), "w").write("".join(m.group(0) + "\n" for m in ART.finditer(open(INSTALL).read())))
    print(f"Saved the files in place as {name}.")


# --- The brush fist -----------------------------------------------------------
# One unbroken line on a 120 grid: up the outer edge, four knuckles (the little
# finger smallest), down the far side, along the base, then the thumb across
# the front. A soft brush: full through the middle, tapering at both ends.
START = (38, 104)
SEGS = [
    ((31, 90), (27, 72), (31, 57)),
    ((33, 43), (50, 42), (51, 55)),
    ((53, 40), (70, 40), (71, 54)),
    ((73, 41), (89, 42), (89, 56)),
    ((96, 50), (104, 60), (98, 72)),
    ((96, 86), (92, 97), (84, 103)),
    ((74, 98), (60, 96), (53, 87)),
    ((47, 79), (51, 68), (63, 70)),
    ((75, 72), (83, 74), (89, 70)),
]


def _cubic(p0, p1, p2, p3, t):
    u = 1 - t
    return (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
            u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def _taper(t, start, end):
    a = min(1, t / start) if start else 1
    b = min(1, (1 - t) / end) if end else 1
    return (0.35 + 0.65 * a) * (0.25 + 0.75 * b)


# Where the line starts at the wrist it leaves the hand open; this closes it
# for the installer's fill (scripts/hand-frames.py --close), never drawn.
CLOSE = ((36, 107), (57, 90))
SCALE = 40


def brush_mask(scale=SCALE, per=240, with_box=False):
    """The mark as a white-on-black mask, cropped to the ink."""
    from PIL import Image, ImageDraw
    pts, cur = [START], START
    for c1, c2, end in SEGS:
        pts += [_cubic(cur, c1, c2, end, i / per) for i in range(1, per + 1)]
        cur = end
    im = Image.new("L", (120 * scale, 120 * scale), 0)
    d = ImageDraw.Draw(im)
    n = len(pts)
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        r = max(0.8, (1.6 + 3.4 * math.sin(math.pi * t) ** 0.5) * _taper(t, 0.04, 0.05)) * scale
        d.ellipse([x * scale - r, y * scale - r, x * scale + r, y * scale + r], fill=255)
    box = im.getbbox()
    return (im.crop(box), box) if with_box else im.crop(box)


def grid_to_canvas(pt, mask_box, size):
    """Where a point of the 120 grid lands, as fractions of a canvas the mark is fitted into."""
    W, H = size
    mw, mh = mask_box[2] - mask_box[0], mask_box[3] - mask_box[1]
    k = min(W / mw, H / mh)
    ox, oy = (W - round(mw * k)) // 2, (H - round(mh * k)) // 2
    return ((ox + (pt[0] * SCALE - mask_box[0]) * k) / W, (oy + (pt[1] * SCALE - mask_box[1]) * k) / H)


def fit(mask, size, colour, box=None):
    """The mark in one colour on transparent, as large as fits in box (x, y, w, h) of a canvas size."""
    from PIL import Image
    W, H = size
    bx, by, bw, bh = box or (0, 0, W, H)
    k = min(bw / mask.width, bh / mask.height)
    m = mask.resize((max(1, round(mask.width * k)), max(1, round(mask.height * k))), Image.LANCZOS)
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    solid = Image.new("RGBA", m.size, colour + (255,))
    out.paste(solid, (bx + (bw - m.width) // 2, by + (bh - m.height) // 2), m)
    return out


def build_brush(film=False):
    from PIL import Image
    orig = os.path.join(MARKS, "original")
    dst = os.path.join(MARKS, "brush")
    out = lambda rel: (os.makedirs(os.path.dirname(os.path.join(dst, rel)), exist_ok=True), os.path.join(dst, rel))[1]
    mask, mask_box = brush_mask(with_box=True)
    # Cream on transparent, the original's own canvases.
    for rel in ("closedhand-com/public/fist.png", "webapp/public/fist.png"):
        fit(mask, (242, 267), CREAM).save(out(rel), optimize=True)
    for rel in ("closedhand-com/public/logo.png", "webapp/public/logo.png"):
        fit(mask, (3579, 3959), CREAM).save(out(rel), optimize=True)
    fit(mask, (242, 267), INK).save(out("desktop/dmg/fist-dark.png"), optimize=True)
    for rel in ("desktop/Sources/ClosedHand/Resources/logo.png", "bridge-app/Sources/Resources/logo.png"):
        fit(mask, (64, 64), WHITE).save(out(rel), optimize=True)
    # The circle mark: the original's ring, the fist inside it where the old one sat.
    ring = Image.open(os.path.join(orig, "closedhand-com/public/logocircle.png")).convert("RGBA")
    cx = cy = ring.width / 2
    px = ring.load()
    inner = next(x for x in range(int(cx) + 140, ring.width) if px[x, int(cy)][3] > 128) - cx
    for y in range(ring.height):
        for x in range(ring.width):
            if (x - cx) ** 2 + (y - cy) ** 2 < (inner - 3) ** 2:
                px[x, y] = (0, 0, 0, 0)
    ring.alpha_composite(fit(mask, (242, 267), CREAM), (191, 178))
    for rel in ("closedhand-com/public/logocircle.png", "webapp/public/logocircle.png"):
        ring.save(out(rel), optimize=True)
    # The favicon: the same colour-following mask, over the new fist.
    svg = open(os.path.join(orig, "webapp/public/favicon.svg")).read()
    fist64 = base64.b64encode(open(out("webapp/public/fist.png"), "rb").read()).decode()
    svg = re.sub(r'href="data:image/png;base64,[^"]+"', f'href="data:image/png;base64,{fist64}"', svg)
    open(out("webapp/public/favicon.svg"), "w").write(svg)
    ico = Image.open(os.path.join(orig, "webapp/public/favicon.ico"))
    sizes = sorted(ico.info.get("sizes", {(16, 16), (32, 32)}))
    big = fit(mask, (256, 256), MID, (16, 0, 224, 256))
    big.save(out("webapp/public/favicon.ico"), sizes=sizes)
    # The app icon: the original's dark gradient, the fist where the old one stood.
    app = _icns_png(os.path.join(orig, "desktop/AppIcon.icns"))
    ap = app.load()
    for y in range(app.height):
        edge = ap[8, y]
        for x in range(200, 824):
            ap[x, y] = edge
    app.alpha_composite(fit(mask, (1024, 1024), CREAM, (234, 214, 554, 612)))
    _icns_write(app, out("desktop/AppIcon.icns"))
    # The traced outline the 3D film extrudes, on the logo's canvas.
    _trace(fit(mask, (3579, 3959), (0, 0, 0)), out("closedhand-com/tools/ring-video/fist.svg"))
    # The installer's pixel fist, from the new fist.png.
    close = ",".join(f"{v:.4f}" for pt in CLOSE for v in grid_to_canvas(pt, mask_box, (242, 267)))
    lines = subprocess.run([sys.executable, os.path.join(ROOT, "scripts/hand-frames.py"), out("webapp/public/fist.png"), "export", "--close", close],
                           capture_output=True, text=True, check=True).stdout.split()
    open(os.path.join(dst, "install-art.txt"), "w").write(f"HAND_FIST_32='{lines[0]}'\nHAND_FIST_64='{lines[1]}'\n")
    if film:
        _film(dst)
    else:
        for rel in ("closedhand-com/public/orb/ring-glass.webm", "closedhand-com/public/orb/ring-glass.mov", "closedhand-com/public/orb/ring-glass-poster.png"):
            if not os.path.exists(os.path.join(dst, rel)):
                print(f"{rel}: not filmed yet (run with --film)")
    print("Built the brush set in brand/marks/brush.")


def _icns_png(path):
    from PIL import Image
    tmp = tempfile.mkdtemp()
    subprocess.run(["sips", "-s", "format", "png", path, "--out", os.path.join(tmp, "a.png")], capture_output=True, check=True)
    return Image.open(os.path.join(tmp, "a.png")).convert("RGBA").resize((1024, 1024))


def _icns_write(img, path):
    from PIL import Image
    tmp = tempfile.mkdtemp()
    iconset = os.path.join(tmp, "AppIcon.iconset")
    os.makedirs(iconset)
    for s in (16, 32, 128, 256, 512):
        img.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}.png"))
        img.resize((s * 2, s * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}@2x.png"))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", path], check=True)


def _trace(img, path):
    from PIL import Image
    tmp = tempfile.mkdtemp()
    bw = Image.new("L", img.size, 255)
    bw.paste(0, mask=img.split()[3].point(lambda a: 255 if a > 127 else 0))
    bw.convert("1").save(os.path.join(tmp, "m.bmp"))
    subprocess.run(["potrace", "-s", "-o", path, os.path.join(tmp, "m.bmp")], check=True)


def _film(dst):
    tool = os.path.join(ROOT, "closedhand-com/tools/ring-video")
    live = os.path.join(tool, "fist.svg")
    keep = open(live, "rb").read()
    shutil.copyfile(os.path.join(dst, "closedhand-com/tools/ring-video/fist.svg"), live)
    orb = os.path.join(ROOT, "closedhand-com/public/orb")
    before = {f: open(os.path.join(orb, f), "rb").read() for f in ("ring-glass.webm", "ring-glass.mov", "ring-glass-poster.png")}
    try:
        subprocess.run(["sh", os.path.join(tool, "make.sh")], check=True)
        os.makedirs(os.path.join(dst, "closedhand-com/public/orb"), exist_ok=True)
        for f in before:
            shutil.copyfile(os.path.join(orb, f), os.path.join(dst, "closedhand-com/public/orb", f))
    finally:
        open(live, "wb").write(keep)
        for f, data in before.items():
            open(os.path.join(orb, f), "wb").write(data)


if __name__ == "__main__":
    cmd = sys.argv[1:] or ["which"]
    if cmd[0] == "use" and len(cmd) == 2:
        use(cmd[1])
    elif cmd[0] == "save" and len(cmd) == 2:
        save(cmd[1])
    elif cmd[0] == "build-brush":
        build_brush(film="--film" in cmd)
    elif cmd[0] == "which":
        print(open(ACTIVE).read().strip() if os.path.exists(ACTIVE) else "original")
    else:
        sys.exit("Usage: brand.py use <mark> | which | build-brush [--film] | save <name>")
