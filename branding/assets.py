"""Builds the icon files Chromium's mac build bundles from icon-1024.png.

    node branding/render.mjs && python3 branding/assets.py
"""
import json
import os

from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
src = Image.open(os.path.join(here, 'icon-1024.png')).convert('RGBA')
theme = os.path.join(here, '../chromium/overlay/chrome/app/theme/chromium')
os.makedirs(os.path.join(theme, 'mac'), exist_ok=True)
src.save(os.path.join(theme, 'mac/app.icns'),
         sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])

# Product logos (About page, menus): the face without the canvas margin.
face = src.crop((100, 100, 924, 924))
for n in (16, 24, 48, 64, 128, 256):
    face.resize((n, n), Image.LANCZOS).save(os.path.join(theme, f'product_logo_{n}.png'), optimize=True)

# Asset catalog; scripts/sync-overlay.sh compiles it to Assets.car with actool.
iconset = os.path.join(here, 'Assets.xcassets/AppIcon.appiconset')
os.makedirs(iconset, exist_ok=True)
images = []
for pt in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        name = f'icon_{pt}x{pt}{"@2x" if scale == 2 else ""}.png'
        src.resize((pt * scale, pt * scale), Image.LANCZOS).save(os.path.join(iconset, name), optimize=True)
        images.append({'idiom': 'mac', 'size': f'{pt}x{pt}', 'scale': f'{scale}x', 'filename': name})
info = {'version': 1, 'author': 'xcode'}
with open(os.path.join(iconset, 'Contents.json'), 'w') as f:
    json.dump({'images': images, 'info': info}, f, indent=2)
with open(os.path.join(here, 'Assets.xcassets/Contents.json'), 'w') as f:
    json.dump({'info': info}, f, indent=2)
