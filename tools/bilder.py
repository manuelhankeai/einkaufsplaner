#!/usr/bin/env python3
"""Bilder für Tischlein aufbereiten.

Aufruf:  python3 tools/bilder.py scene-today=/pfad/bild.png dish-pasta=/pfad/pasta.jpg ...

- Kopf-Szenen (scene-*) werden auf höchstens 1200 px Breite, Tellerbilder (dish-*) auf 640 px verkleinert.
- Ausgabe als WebP nach img/<name>.webp.
- img/bilder.js wird aus allen vorhandenen img/*.webp neu erzeugt (Liste + Auflösung).
  Fehlt ein Bild, zeigt die App automatisch die Vektor-Illustration aus illus.js.

Quelle der Bilder: Canva-Ordner „Tischlein – App-Bilder“ (IDs siehe tools/bilder-quellen.json).
"""
import json, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, 'img')
MAXW = {'scene': 1200, 'dish': 640}


def convert(name, src):
    kind = name.split('-', 1)[0]
    if kind not in MAXW:
        sys.exit('Unbekannter Bildtyp: ' + name + ' (erlaubt: scene-*, dish-*)')
    im = Image.open(src).convert('RGB')
    if im.width > MAXW[kind]:
        im = im.resize((MAXW[kind], round(im.height * MAXW[kind] / im.width)), Image.LANCZOS)
    out = os.path.join(IMG, name + '.webp')
    im.save(out, 'WEBP', quality=82, method=6)
    print(f'{name}: {im.width}x{im.height}  {os.path.getsize(out)//1024} KB')


def manifest():
    entries = {}
    for f in sorted(os.listdir(IMG)):
        if not f.endswith('.webp'):
            continue
        with Image.open(os.path.join(IMG, f)) as im:
            w, h = im.size
        entries[f[:-5]] = {'src': 'img/' + f, 'w': w, 'h': h}
    js = ('/* Automatisch erzeugt von tools/bilder.py – nicht von Hand bearbeiten. */\n'
          'var BILDER = ' + json.dumps(entries, indent=1, ensure_ascii=False) + ';\n')
    open(os.path.join(IMG, 'bilder.js'), 'w').write(js)
    print('img/bilder.js:', len(entries), 'Bilder')


if __name__ == '__main__':
    os.makedirs(IMG, exist_ok=True)
    for arg in sys.argv[1:]:
        name, src = arg.split('=', 1)
        convert(name, src)
    manifest()
