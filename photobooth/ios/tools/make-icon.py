#!/usr/bin/env python3
"""Generate the Receipt Photo Booth app icon ("Thermal Arcade" style).

Everything is drawn as vector-ish shapes with Pillow at 2048 px and
downsampled to 1024 — no emoji, no fonts, no external artwork.

    uv run --with pillow photobooth/ios/tools/make-icon.py

Writes:
  App/Assets.xcassets/AppIcon.appiconset/icon-1024.png  (RGB, no alpha)
  build/icon-preview/{icon-1024,icon-120,icon-60,homescreen}.png
"""
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

# DESIGN.md tokens
INK = (0x1A, 0x14, 0x23)
PAPER = (0xFF, 0xF4, 0xDC)
SUN = (0xFF, 0xD2, 0x3F)
PINK = (0xFF, 0x5D, 0xA2)
TOMATO = (0xFF, 0x6B, 0x4A)
SKY = (0x3E, 0xC1, 0xFF)
MINT = (0x2E, 0xE6, 0xA6)
GRAPE = (0x9B, 0x6B, 0xFF)
WHITE = (0xFF, 0xFF, 0xFF)

S = 2048  # supersampled canvas
LINE = 40  # ink outline width at 2048 (≈ 1.2 px at 60 px)
SHADOW = (52, 52)  # hard offset shadow, no blur
TILT = 7  # degrees, counter-clockwise

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT / "App/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
PREVIEW = ROOT / "build/icon-preview"


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


# --- outlined primitives: ink grows outward by LINE, fill on top -------------

def rrect(d, box, r, fill, w=LINE):
    x0, y0, x1, y1 = box
    d.rounded_rectangle((x0 - w, y0 - w, x1 + w, y1 + w), r + w, fill=INK)
    d.rounded_rectangle(box, r, fill=fill)


def circle(d, c, r, fill, w=LINE):
    cx, cy = c
    d.ellipse((cx - r - w, cy - r - w, cx + r + w, cy + r + w), fill=INK)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)


def poly(d, pts, fill, w=LINE):
    d.polygon(pts, fill=INK)
    d.line(pts + pts[:1], fill=INK, width=2 * w, joint="curve")
    for x, y in pts:  # round joins
        d.ellipse((x - w, y - w, x + w, y + w), fill=INK)
    d.polygon(pts, fill=fill)


def star(c, r_out, r_in, n, rot=0.0):
    cx, cy = c
    pts = []
    for i in range(2 * n):
        r = r_out if i % 2 == 0 else r_in
        a = rot + math.pi * i / n - math.pi / 2
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def with_shadow(layer, off=SHADOW):
    """Composite a hard ink shadow (from the layer's alpha) under the layer."""
    alpha = layer.getchannel("A")
    sh = Image.new("RGBA", layer.size, INK + (0,))
    sh.putalpha(ImageChops.offset(alpha, *off))
    return Image.alpha_composite(sh, layer)


# --- scene -------------------------------------------------------------------

def background():
    img = Image.new("RGBA", (S, S), SUN + (255,))
    d = ImageDraw.Draw(img)
    dot = mix(SUN, INK, 0.13)
    step, r = 176, 15
    start = (S - step * (S // step)) // 2 + step // 2
    for y in range(start, S, step):
        for x in range(start, S, step):
            d.ellipse((x - r, y - r, x + r, y + r), fill=dot)
    return img


def sticker(center, radius):
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    circle(ImageDraw.Draw(layer), center, radius, WHITE, w=44)
    return with_shadow(layer, (58, 58))


def strip_layer(cx, top, bottom, width):
    """Receipt strip with a zig-zag torn bottom and two ink photo frames."""
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, x1 = cx - width / 2, cx + width / 2
    teeth = 5
    tw = width / teeth
    pts = [(x0, top), (x1, top), (x1, bottom)]
    for i in range(teeth):
        xr = x1 - i * tw
        pts += [(xr - tw / 2, bottom + 54), (xr - tw, bottom)]
    poly(d, pts, PAPER)

    # photo frames: fat ink frame with offset block, like the printed strips
    fw = width - 110
    fh = 170
    gap = 40
    y = bottom - 2 * fh - gap - 44
    for i in range(2):
        fx0 = cx - fw / 2
        d.rectangle((fx0 + 18, y + 18, fx0 + fw + 18, y + fh + 18), fill=INK)
        d.rectangle((fx0, y, fx0 + fw, y + fh), fill=INK)
        d.rectangle((fx0 + 24, y + 24, fx0 + fw - 24, y + fh - 24), fill=WHITE)
        # a little ink "selfie": head + shoulders, clipped to the frame
        hx = cx + (-40 if i == 0 else 40)
        ix0, iy0, ix1, iy1 = fx0 + 24, y + 24, fx0 + fw - 24, y + fh - 24
        sil = Image.new("L", layer.size, 0)
        sd = ImageDraw.Draw(sil)
        sd.ellipse((hx - 28, iy0 + 16, hx + 28, iy0 + 72), fill=255)
        sd.ellipse((hx - 62, iy0 + 80, hx + 62, iy0 + 190), fill=255)
        sd.rectangle((0, 0, S, iy0), fill=0)
        sd.rectangle((0, iy1, S, S), fill=0)
        layer.paste(INK + (255,), (0, 0), sil)
        y += fh + gap
    return layer


def camera_layer(cx, cy):
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    bw, bh = 940, 590
    x0, y0 = cx - bw / 2, cy - bh / 2
    x1, y1 = cx + bw / 2, cy + bh / 2

    # shutter button + viewfinder hump peek over the top (drawn first, behind)
    rrect(d, (x0 + 120, y0 - 90, x0 + 320, y0 + 40), 30, SUN)
    rrect(d, (cx - 190, y0 - 110, cx + 190, y0 + 60), 60, PINK)

    # body: pink top plate over tomato base
    rrect(d, (x0, y0, x1, y1), 120, TOMATO)
    d.rounded_rectangle((x0, y0, x1, y0 + 230), 120, fill=PINK)
    d.rectangle((x0, y0 + 120, x1, y0 + 230), fill=PINK)
    d.rectangle((x0, y0 + 230, x1, y0 + 230 + LINE), fill=INK)

    # flash window (top-right of the plate)
    rrect(d, (x1 - 250, y0 + 60, x1 - 90, y0 + 160), 26, WHITE, w=30)

    # big lens
    lc = (cx, cy - 8)
    circle(d, lc, 238, WHITE)
    circle(d, lc, 182, INK, w=0)
    circle(d, lc, 146, SKY, w=0)
    hx, hy = lc[0] - 52, lc[1] - 52
    d.ellipse((hx - 46, hy - 46, hx + 46, hy + 46), fill=WHITE)
    d.ellipse((lc[0] + 58 - 20, lc[1] + 58 - 20, lc[0] + 58 + 20, lc[1] + 58 + 20), fill=WHITE)

    # print slot on the bottom edge
    d.rounded_rectangle((cx - 250, y1 - 44, cx + 250, y1 - 10), 17, fill=INK)

    # flash burst bursting off the top-right corner
    burst_c = (x1 - 30, y0 - 60)
    poly(d, star(burst_c, 190, 92, 8, rot=0.18), SUN)
    circle(d, burst_c, 58, WHITE, w=0)
    return layer


def render():
    img = background()
    c = (S // 2, 980)
    img = Image.alpha_composite(img, sticker(c, 700))

    cam_cx, cam_cy = S // 2 - 30, 860
    strip_w = 420
    art = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    art = Image.alpha_composite(art, strip_layer(cam_cx, cam_cy + 200, 1660, strip_w))
    art = Image.alpha_composite(art, camera_layer(cam_cx, cam_cy))
    art = with_shadow(art, (38, 38))
    art = art.rotate(TILT, resample=Image.BICUBIC, center=(cam_cx, 1000))
    img = Image.alpha_composite(img, art)

    out = img.convert("RGB").resize((1024, 1024), Image.LANCZOS)
    return out


def homescreen(icon):
    """Rounded-corner mock on a wallpaper-ish background, at ~3x phone scale."""
    W, H = 900, 520
    bg = Image.new("RGB", (W, H))
    top, bot = (0x3A, 0x2C, 0x6B), (0xE0, 0x6B, 0x8E)
    d = ImageDraw.Draw(bg)
    for y in range(H):
        d.line((0, y, W, y), fill=mix(top, bot, y / H))
    sizes = [(180, 40, 60), (120, 300, 90), (60, 500, 120), (60 * 3, 620, 40)]
    for size, x, y in sizes:
        ic = icon.resize((size, size), Image.LANCZOS)
        mask = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, size * 4 - 1, size * 4 - 1), int(size * 4 * 0.2237), fill=255
        )
        mask = mask.resize((size, size), Image.LANCZOS)
        bg.paste(ic, (x, y), mask)
    # neighbouring generic "apps" for scale
    for i, col in enumerate([SKY, MINT, GRAPE]):
        x = 500 + i * 80
        d.rounded_rectangle((x, 260, x + 60, 320), 13, fill=col)
    return bg


def main():
    icon = render()
    ICON.parent.mkdir(parents=True, exist_ok=True)
    icon.save(ICON, optimize=True)
    PREVIEW.mkdir(parents=True, exist_ok=True)
    icon.save(PREVIEW / "icon-1024.png")
    icon.resize((120, 120), Image.LANCZOS).save(PREVIEW / "icon-120.png")
    icon.resize((60, 60), Image.LANCZOS).save(PREVIEW / "icon-60.png")
    homescreen(icon).save(PREVIEW / "homescreen.png")
    print(f"wrote {ICON} ({icon.size[0]}x{icon.size[1]} {icon.mode})")


if __name__ == "__main__":
    main()
