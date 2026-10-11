"""Run: python scripts/make-maker-logos.py   (needs Pillow: pip install pillow)

Turn the maker logos in /visuals into single-colour masks: white shape, transparent background.
The site paints them with the surrounding text colour (CSS mask), so they come out grey like the UI."""
import json, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT.parent / 'visuals'   # the folder next to this repo
OUT = ROOT / 'buyer' / 'img' / 'makers'
OUT.mkdir(parents=True, exist_ok=True)
HEIGHT = 64   # shown at 14-20 px, so this is sharp on high-DPI phones too

BOLDER = {'dhc': 5}   # thin-lined logos: thicken strokes (px at original size) so they survive shrinking
# file, output name, optional crop as fractions of the original (left, top, right, bottom)
LOGOS = [
    ('airbus_logo.png', 'airbus', None),
    ('Boeing_logo.png', 'boeing', None),
    ('Bombardier_logo.png', 'bombardier', None),
    ('Embraer_logo.png', 'embraer', None),
    ('atr_logo.jpg', 'atr', None),
    ('comac_logo.png', 'comac', (0, 0, 1, 0.5)),            # the bird mark only, without the text below it
    ('dhc_logo.png', 'dhc', None),
    ('uac_logo.png', 'uac', (0.503, 0.32, 0.628, 0.56)),      # the round mark only
]

def ink(img):
    """How much each pixel differs from the background, 0..255 (the logo's shape, any colour)."""
    rgba = img.convert('RGBA')
    flat = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
    flat.alpha_composite(rgba)                               # transparent areas count as background
    r, g, b, _ = flat.split()
    w, h = flat.size
    lum = flat.convert('L')
    if sorted(lum.getpixel((x, y)) for x in (0, w - 1) for y in (0, h - 1))[1] < 110:
        v = lum                                              # light logo on a dark background (Airbus): brightness
    else:
        darkest = ImageChops.darker(ImageChops.darker(r, g), b)  # min channel: catches dark AND coloured ink
        v = ImageOps.invert(darkest)                         # 255 - min(r, g, b)
    corners = [v.getpixel((x, y)) for x in (0, w - 1) for y in (0, h - 1)]
    bg = sorted(corners)[1]                                  # background level (light grey for ATR)
    hist = v.histogram()
    total, acc, top = sum(hist), 0, 255
    for level in range(255, -1, -1):                         # strongest ink, ignoring a few stray pixels
        acc += hist[level]
        if acc > total * 0.002: top = level; break
    span = max(1, top - bg)
    return v.point(lambda p: 0 if p <= bg else min(255, round((p - bg) * 255 / span)))

sizes = {}
for file, name, crop in LOGOS:
    img = Image.open(SRC / file)
    if crop:
        w, h = img.size
        img = img.crop((round(crop[0] * w), round(crop[1] * h), round(crop[2] * w), round(crop[3] * h)))
    a = ink(img)
    if name in BOLDER: a = a.filter(ImageFilter.MaxFilter(BOLDER[name]))
    box = a.point(lambda p: 255 if p > 24 else 0).getbbox()
    a = a.crop(box)
    pad = round(max(a.size) * 0.04)
    framed = Image.new('L', (a.width + 2 * pad, a.height + 2 * pad), 0)
    framed.paste(a, (pad, pad))
    width = max(1, round(framed.width * HEIGHT / framed.height))
    mask = framed.resize((width, HEIGHT), Image.LANCZOS)
    out = Image.new('RGBA', mask.size, (255, 255, 255, 0))
    out.putalpha(mask)
    out.save(OUT / f'{name}.png', optimize=True)
    sizes[name] = round(width / HEIGHT, 3)
    print(name, mask.size, (OUT / f'{name}.png').stat().st_size, 'bytes')
print('ratios for MAKERS in buyer/js/app.js:', json.dumps(sizes))
