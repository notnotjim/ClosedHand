# Generates the hand-to-fist frames as 32x28 bitmaps. Pixels are square:
# each terminal cell shows two of them, one above the other, via half blocks.
import math, sys
W, H = 32, 28

def rrect(x, y, x1, y1, x2, y2, r):
    # rounded rectangle, r = corner radius
    cx = min(max(x, x1 + r), x2 - r); cy = min(max(y, y1 + r), y2 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def capsule(x, y, ax, ay, bx, by, r):
    # thick segment with round caps
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0 if L2 == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / L2))
    px, py = ax + t * dx, ay + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= r * r

def lerp(a, b, p): return a + (b - a) * p

def frame(P, crease=0.0):
    # P: 0 open, 1 closed. crease: 0..1, the thumb outline settling in.
    hand = [[0] * W for _ in range(H)]
    thumb = [[0] * W for _ in range(H)]
    # fingers: x centres, open tops, closed tops
    fx = [10.5, 16.5, 22.5, 28.5]
    top_open = [4, 1, 3, 8]
    top_shut = [4, 3, 4, 6]
    fw = 2.4                                  # half width
    bottom = lerp(16, 15, P)
    for i in range(4):
        top = lerp(top_open[i], top_shut[i], P)
        for y in range(H):
            for x in range(W):
                if capsule(x + .5, y + .5, fx[i], top + fw, fx[i], bottom, fw): hand[y][x] = 1
    # palm: its top stays below the fingers so the gaps between them survive
    # into the fist, which is what makes it read as knuckles rather than a blob
    px1, py1, px2, py2 = 7, lerp(14, 15.2, P), 31.5, lerp(24, 23, P)
    for y in range(H):
        for x in range(W):
            if rrect(x + .5, y + .5, px1, py1, px2, py2, lerp(4, 6, P)): hand[y][x] = 1
    # the index-side bulge where the thumb folds in, only once the hand closes
    if P > 0.3:
        q = (P - 0.3) / 0.7
        for y in range(H):
            for x in range(W):
                if rrect(x + .5, y + .5, lerp(6, 1.5, q), lerp(13, 7, q), 10, 19, 3): hand[y][x] = 1
    # wrist, running off the bottom edge
    for y in range(H):
        for x in range(W):
            if rrect(x + .5, y + .5, 12, lerp(22, 21, P), 26, H + 4, 3): hand[y][x] = 1
    # thumb: a lobe out to the left when open, lying across the front when shut
    ax, ay = lerp(2.5, 4.0, P), lerp(11, 18.5, P)
    bx, by = lerp(8, 20, P), lerp(17, 19, P)
    r = lerp(2.6, 3.2, P)
    for y in range(H):
        for x in range(W):
            if capsule(x + .5, y + .5, ax, ay, bx, by, r):
                thumb[y][x] = 1; hand[y][x] = 1
    # crease: a one pixel dark line around the thumb where it lies over fingers
    if crease > 0:
        out = [[0] * W for _ in range(H)]
        for y in range(H):
            for x in range(W):
                if thumb[y][x]: continue
                near = any(0 <= y + dy < H and 0 <= x + dx < W and thumb[y + dy][x + dx]
                           for dy in (-1, 0, 1) for dx in (-1, 0, 1))
                if near and y + .5 < 20: out[y][x] = 1   # only the upper edge and the tip
        for y in range(H):
            for x in range(W):
                if out[y][x] and hand[y][x] and crease >= 1: hand[y][x] = 0
    return hand

def text(bm): return "\n".join("".join("#" if v else "." for v in row) for row in bm)

def export(n=8):
    steps = [(i / n, 0) for i in range(n + 1)] + [(1, 1)]
    lines = []
    for p, c in steps:
        bm = frame(p, c)
        lines.append("".join("%08x" % int("".join(str(v) for v in row), 2) for row in bm))
    return lines

if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[2] == "export":
    print("\n".join(export()))
    sys.exit(0)

if __name__ == "__main__":
    steps = [(0,0),(.2,0),(.4,0),(.6,0),(.8,0),(1,0),(1,1)]
    frames = [frame(p, c) for p, c in steps]
    from PIL import Image, ImageDraw
    px, gap = 7, 16
    im = Image.new("RGB", (len(frames) * (W * px + gap) + gap, H * px + 2 * gap), (30, 30, 30))
    d = ImageDraw.Draw(im)
    for i, f in enumerate(frames):
        ox = gap + i * (W * px + gap)
        for y in range(H):
            for x in range(W):
                if f[y][x]: d.rectangle([ox + x * px, gap + y * px, ox + (x + 1) * px - 1, gap + (y + 1) * px - 1], fill=(200, 200, 200))
    im.save(sys.argv[1] if len(sys.argv) > 1 else "sheet2.png")
    print("ok")
