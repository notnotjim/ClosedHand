# A lit hand, open to fist, as a heightfield: each primitive says how far it
# stands out of the screen at a pixel, the tallest wins, and the slope of
# that surface under a top-left light gives the shade. 32x28 pixels, one
# grey level per pixel (0 = background, 1..24 = dark to light).
import math, sys
W, H = 32, 28
LEVELS = 24

def lerp(a, b, p): return a + (b - a) * p

def cap_h(x, y, ax, ay, bx, by, r):
    # capsule seen from the front: a cylinder of radius r along the segment
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0 if L2 == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / L2))
    px, py = ax + t * dx, ay + t * dy
    d2 = (x - px) ** 2 + (y - py) ** 2
    return math.sqrt(r * r - d2) if d2 < r * r else 0

def sph_h(x, y, cx, cy, r):
    d2 = (x - cx) ** 2 + (y - cy) ** 2
    return math.sqrt(r * r - d2) if d2 < r * r else 0

def box_h(x, y, x1, y1, x2, y2, h, roll):
    # a slab with rounded edges: full height inside, falling off over `roll`
    if x < x1 or x > x2 or y < y1 or y > y2: return 0
    d = min(x - x1, x2 - x, y - y1, y2 - y)
    if d >= roll: return h
    t = d / roll
    return h * math.sqrt(1 - (1 - t) ** 2)

def heights(P):
    z = [[0.0] * W for _ in range(H)]
    fx = [7.5, 13.5, 19.5, 25.5]
    top_open = [4, 1, 3, 8]
    top_shut = [5.5, 4.5, 5.0, 7.0]
    fr = lerp(2.4, 2.95, P)
    fbot = lerp(16, 15, P)
    kn_r = lerp(0, 3.3, P)                         # knuckle bumps grow as it closes
    # thumb: out to the left when open, across the front when shut
    tax, tay = lerp(2.5, 3.5, P), lerp(11, 18.2, P)
    tbx, tby = lerp(8.5, 21.0, P), lerp(17.5, 18.8, P)
    tr = lerp(2.5, 3.4, P)
    # palm: tall and narrow when open, a squat block when shut
    px1, py1, px2, py2 = lerp(7, 3.5, P), lerp(14, 8.5, P), 31, lerp(24, 24.5, P)
    ph = lerp(3.2, 4.6, P)
    for y in range(H):
        for x in range(W):
            X, Y = x + .5, y + .5
            best = 0
            # the body: a slab with well-rounded edges, domed so the middle of
            # the fist stands proudest and the sides fall away
            body = box_h(X, Y, px1, py1, px2, py2, ph, lerp(3.0, 6.5, P))
            if body:
                cx = (px1 + px2) / 2; hw = (px2 - px1) / 2
                body *= 1 - lerp(0.10, 0.35, P) * ((X - cx) / hw) ** 2
            best = max(best, body)
            best = max(best, box_h(X, Y, 11, lerp(22, 21, P), 21.5, H + 3, 2.6, 2.2))
            for i in range(4):
                top = lerp(top_open[i], top_shut[i], P)
                h = cap_h(X, Y, fx[i], top + fr, fx[i], fbot, fr)
                if h: best = max(best, h + 1.2)
                if kn_r > 0:
                    h = sph_h(X, Y, fx[i], top + fr - 0.3, kn_r)
                    if h: best = max(best, h + 1.2)
            # thumb sits in front of the fingers it crosses
            h = cap_h(X, Y, tax, tay, tbx, tby, tr)
            if h: best = max(best, h + lerp(0.6, 2.4, P))
            z[y][x] = best
    return z

def shade(z):
    # light from the top left and slightly in front
    lx, ly, lz = -0.45, -0.55, 0.70
    n = math.sqrt(lx * lx + ly * ly + lz * lz); lx, ly, lz = lx / n, ly / n, lz / n
    out = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if z[y][x] <= 0: continue
            zl = z[y][x - 1] if x > 0 else 0; zr = z[y][x + 1] if x < W - 1 else 0
            zu = z[y - 1][x] if y > 0 else 0; zd = z[y + 1][x] if y < H - 1 else 0
            # a neighbour that is background is a cliff: treat as a steep slope
            dzdx = (zr - zl) / 2; dzdy = (zd - zu) / 2
            nx, ny, nz = -dzdx, -dzdy, 1.0
            m = math.sqrt(nx * nx + ny * ny + nz * nz); nx, ny, nz = nx / m, ny / m, nz / m
            lam = max(0.0, nx * lx + ny * ly + nz * lz)
            # occlusion: anything standing well above this pixel nearby darkens it
            occ = 0.0
            for dy in (-2, -1, 0, 1, 2):
                for dx in (-2, -1, 0, 1, 2):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < H and 0 <= xx < W and z[yy][xx] > z[y][x] + 1.2: occ += 1
            ao = 1.0 - min(0.55, occ * 0.06)
            v = (0.18 + 0.82 * lam) * ao
            out[y][x] = max(1, min(LEVELS, int(round(v * LEVELS))))
    return out

def frames(n=8):
    return [shade(heights(i / (n - 1))) for i in range(n)]

def encode(fr):
    # run-length: <count><letter>, letter a..y for levels 0..24
    s = []
    flat = [v for row in fr for v in row]
    i = 0
    while i < len(flat):
        j = i
        while j < len(flat) and flat[j] == flat[i]: j += 1
        s.append(f"{j - i}{chr(97 + flat[i])}")
        i = j
    return "".join(s)

if __name__ == "__main__":
    fs = frames()
    if len(sys.argv) > 1 and sys.argv[1] == "export":
        for f in fs: print(encode(f))
        sys.exit(0)
    from PIL import Image, ImageDraw
    px, gap = 7, 16
    im = Image.new("RGB", (len(fs) * (W * px + gap) + gap, H * px + 2 * gap), (30, 30, 30))
    d = ImageDraw.Draw(im)
    for i, f in enumerate(fs):
        ox = gap + i * (W * px + gap)
        for y in range(H):
            for x in range(W):
                v = f[y][x]
                if v:
                    g = int(8 + (v / LEVELS) * 238)
                    d.rectangle([ox + x * px, gap + y * px, ox + (x + 1) * px - 1, gap + (y + 1) * px - 1], fill=(g, g, g))
    im.save(sys.argv[1] if len(sys.argv) > 1 else "sheet3.png")
    print("ok", sum(len(encode(f)) for f in fs), "bytes encoded")
