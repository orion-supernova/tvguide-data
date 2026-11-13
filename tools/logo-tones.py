#!/usr/bin/env python3
"""Logo background hints: adds "logoBg": "light" | "dark" to every channel in <out>/*/channels.json.

"logoBg" is the background a logo needs to be readable:
  - transparent logo that is mostly dark (black/dark wordmark)          -> "light"
  - transparent logo that is mostly light/white, or colourful mid-tone  -> "dark" (default)
  - opaque logo (its own solid background)                             -> matches its own edge colour

Results are cached in logos/tones.json keyed by logo path + sha1, so each file is analysed once.
The Node builds read that cache too, so logoBg is present even where Pillow is not installed.

Usage: python3 tools/logo-tones.py [out_dir]      (needs Pillow; exits quietly without it)
"""
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'logos', 'tones.json')
VERSION = 2  # bump to recompute everything when the rule changes


def lightness(r, g, b):
    # HSL lightness: saturated colours (pure red, blue) count as mid-tone, not dark
    return (max(r, g, b) + min(r, g, b)) / 510


def tone(path):
    from PIL import Image

    im = Image.open(path)
    im.load()
    im = im.convert('RGBA')
    im.thumbnail((160, 160))
    w, h = im.size
    px = list(im.getdata())

    transparent = sum(1 for p in px if p[3] < 32) / len(px)
    if transparent < 0.05:
        # opaque: use the outer ring of pixels (its own background)
        edge = [im.getpixel((x, y)) for x in range(w) for y in (0, h - 1)] + [im.getpixel((x, y)) for y in range(h) for x in (0, w - 1)]
        lum = sum(lightness(*p[:3]) for p in edge) / len(edge)
        return 'light' if lum > 0.6 else 'dark'

    # transparent: look at the visible pixels, weighted by alpha
    dark = light = total = 0.0
    for r, g, b, a in px:
        if a < 32:
            continue
        wgt = a / 255
        l = lightness(r, g, b)
        total += wgt
        if l < 0.28:
            dark += wgt
        elif l > 0.8:
            light += wgt
    if not total:
        return 'dark'
    return 'light' if dark / total > 0.5 else 'dark'


def sha1(path):
    with open(path, 'rb') as f:
        return hashlib.sha1(f.read()).hexdigest()


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'out')
    try:
        import PIL  # noqa: F401
    except ImportError:
        print('[tones] Pillow not installed; skipping logoBg')
        return
    try:
        with open(CACHE) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    cache = {k: v for k, v in cache.items() if v.get('v') == VERSION}

    stats = {}
    for cc in sorted(os.listdir(out)):
        chf = os.path.join(out, cc, 'channels.json')
        if not os.path.isfile(chf):
            continue
        with open(chf, encoding='utf-8') as f:
            data = json.load(f)
        for ch in data['channels']:
            logo = ch.get('logo')
            path = logo and os.path.join(out, logo)
            if not path or not os.path.isfile(path):
                ch.pop('logoBg', None)
                continue
            digest = sha1(path)
            hit = cache.get(logo)
            if not hit or hit['sha1'] != digest:
                try:
                    hit = {'sha1': digest, 'bg': tone(path), 'v': VERSION}
                    cache[logo] = hit
                except Exception as err:  # unreadable image: leave the hint out
                    print(f'[tones] {logo}: {err}')
                    continue
            ch['logoBg'] = hit['bg']
            s = stats.setdefault(cc, {'light': 0, 'dark': 0})
            s[hit['bg']] += 1
        with open(chf, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, 'w') as f:
        json.dump(dict(sorted(cache.items())), f, indent=0)
        f.write('\n')
    print('[tones] ' + ' '.join(f"{cc}: {s['light']} light/{s['dark']} dark" for cc, s in stats.items()))


if __name__ == '__main__':
    main()
