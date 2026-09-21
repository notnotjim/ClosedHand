# The installer's fist, taken from the brand icon (webapp/public/fist.png): the
# icon's strokes become a dark outline, the enclosed shape a light fill with a
# faint top-left light, one still picture per size. Levels: 0 background,
# 1..24 dark to light.
import sys
from PIL import Image
from collections import deque

LEVELS = 24

def load(path):
    im = Image.open(path).convert("RGBA")
    a = im.split()[3]
    w, h = im.size
    px = a.load()
    stroke = [[px[x, y] > 100 for x in range(w)] for y in range(h)]
    # flood the outside from the border across non-stroke pixels
    outside = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not stroke[y][x] and not outside[y][x]: outside[y][x] = True; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not stroke[y][x] and not outside[y][x]: outside[y][x] = True; q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            xx, yy = x + dx, y + dy
            if 0 <= xx < w and 0 <= yy < h and not stroke[yy][xx] and not outside[yy][xx]:
                outside[yy][xx] = True; q.append((xx, yy))
    return w, h, stroke, outside

def render(path, W, H):
    w, h, stroke, outside = load(path)
    # fit the icon's height, keep its aspect, centre it
    scale = h / H
    tw = int(round(w / scale))
    ox = (W - tw) // 2
    out = [[0] * W for _ in range(H)]
    for ty in range(H):
        for tx in range(tw):
            x0, x1 = int(tx * scale), max(int(tx * scale) + 1, int((tx + 1) * scale))
            y0, y1 = int(ty * scale), max(int(ty * scale) + 1, int((ty + 1) * scale))
            n = s = i = 0
            for y in range(y0, min(y1, h)):
                for x in range(x0, min(x1, w)):
                    n += 1
                    if stroke[y][x]: s += 1
                    elif not outside[y][x]: i += 1
            if not n: continue
            sf, inf = s / n, i / n
            if sf >= 0.30: v = 8                                     # outline
            elif inf + sf >= 0.5:
                # fill, lit from the top left
                t = 0.5 * (tx / max(1, tw - 1)) + 0.5 * (ty / max(1, H - 1))
                v = int(round(22 - 7 * t))
            else: continue
            out[ty][ox + tx] = v
    return out

def encode(fr):
    flat = [v for row in fr for v in row]
    s = []; i = 0
    while i < len(flat):
        j = i
        while j < len(flat) and flat[j] == flat[i]: j += 1
        s.append(f"{j - i}{chr(97 + flat[i])}"); i = j
    return "".join(s)

if __name__ == "__main__":
    src = sys.argv[1]
    sizes = [(32, 28), (64, 56)]
    frames = [render(src, W, H) for W, H in sizes]
    if len(sys.argv) > 2 and sys.argv[2] == "export":
        for f in frames: print(encode(f))
        sys.exit(0)
    from PIL import ImageDraw
    gap = 16
    px = [10, 5]
    im = Image.new("RGB", (sum(W * p for (W, H), p in zip(sizes, px)) + gap * 3, 28 * 10 + gap * 2), (30, 30, 30))
    d = ImageDraw.Draw(im)
    ox = gap
    for (W, H), p, f in zip(sizes, px, frames):
        for y in range(H):
            for x in range(W):
                v = f[y][x]
                if v:
                    g = int(8 + (v / LEVELS) * 238)
                    d.rectangle([ox + x * p, gap + y * p, ox + (x + 1) * p - 1, gap + (y + 1) * p - 1], fill=(g, g, g))
        ox += W * p + gap
    im.save(sys.argv[2] if len(sys.argv) > 2 else "sheet4.png"); print("ok")
