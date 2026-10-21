# Builds each site's icon set from the white Echo winglets (scripts/assets/echo-mark.png, 428x339):
# the winglets tinted in the site's colour on pure black, matching the Echo Alliances site icon.
#   buyer  (market.echoalliances.com): Echo violet #A855F7
#   seller (desk.echoalliances.com):   desk pink   #F472B6 (the Lead Ambassador pink)
# Output per app: favicon.ico (16/32/48), icons/icon-48|96|192|512.png, apple-touch-icon.png (180).
# Run: python scripts/make-favicons.py   (needs Pillow)
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MARK = Image.open(ROOT / 'scripts' / 'assets' / 'echo-mark.png').convert('RGBA')
COLOURS = {'buyer': '#A855F7', 'seller': '#F472B6'}


def icon(size, colour, padding):
    """Square black icon: winglets inside `padding` (fraction per side), nudged 1.5% right (the mark leans left)."""
    big = size * 4   # draw large, then scale down for clean edges
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 255))
    box = big * (1 - 2 * padding)
    scale = min(box / MARK.width, box / MARK.height)
    w, h = round(MARK.width * scale), round(MARK.height * scale)
    alpha = MARK.split()[3].resize((w, h), Image.LANCZOS)
    tint = Image.new('RGBA', (w, h), colour)
    tint.putalpha(alpha)
    x = round((big - w) / 2 + big * 0.015)
    y = round((big - h) / 2)
    canvas.alpha_composite(tint, (x, y))
    return canvas.resize((size, size), Image.LANCZOS).convert('RGB')


for app, colour in COLOURS.items():
    out = ROOT / app
    (out / 'icons').mkdir(exist_ok=True)
    for s in (48, 96, 192, 512):
        icon(s, colour, 0.20).save(out / 'icons' / f'icon-{s}.png', optimize=True)
    icon(180, colour, 0.18).save(out / 'apple-touch-icon.png', optimize=True)
    icon(48, colour, 0.20).save(out / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
    print(app, colour, 'done')
