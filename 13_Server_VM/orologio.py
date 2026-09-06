#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Legge il cronometro in sovrimpressione da due fotogrammi della stessa partita.

  python3 orologio.py fascia_t.png fascia_t+20.png  →  {"letture": [4241, 4261], "box": [x, y, w, h]}

I due fotogrammi sono la fascia alta dell'inquadratura (il quarto superiore,
a grandezza naturale), presi a venti secondi di distanza. Il lettore di
testo da solo si perde nella folla; qui prima si trova la grafica, poi si
legge solo quella.

Come si trova la grafica: e' l'unica cosa che fra due fotogrammi NON si
muove e ha dei bordi. La folla si muove, il cielo e' fermo ma liscio, la
grafica e' ferma e disegnata. Dentro la grafica, l'unica cosa che cambia
sono le cifre del cronometro — che e' proprio quello che si vuole leggere.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

TESSERACT = os.environ.get("COMOTV_TESSERACT", "tesseract")
ORA = re.compile(r"(\d{1,3}):(\d{2})")


def grigio(percorso):
    return np.asarray(Image.open(percorso).convert("L"), dtype=np.float32)


def componenti(maschera):
    """Le isole di una maschera booleana: lista di (x0, y0, x1, y1, area)."""
    h, w = maschera.shape
    visto = np.zeros_like(maschera, dtype=bool)
    fuori = []
    ys, xs = np.nonzero(maschera)
    for y0, x0 in zip(ys, xs):
        if visto[y0, x0]:
            continue
        pila = [(y0, x0)]
        visto[y0, x0] = True
        minx = maxx = x0
        miny = maxy = y0
        area = 0
        while pila:
            y, x = pila.pop()
            area += 1
            minx, maxx = min(minx, x), max(maxx, x)
            miny, maxy = min(miny, y), max(maxy, y)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and maschera[ny, nx] and not visto[ny, nx]:
                        visto[ny, nx] = True
                        pila.append((ny, nx))
        fuori.append((minx, miny, maxx + 1, maxy + 1, area))
    return fuori


def trova_grafica(a, b):
    """Il riquadro (x, y, w, h) della grafica ferma fra i due fotogrammi, o None."""
    h, w = a.shape
    fermo = np.abs(a - b) < 12
    # i bordi: dove l'immagine cambia da un pixel al vicino
    gy, gx = np.gradient(a)
    bordi = (np.abs(gx) + np.abs(gy)) > 18
    # fermo E disegnato; poi si riduce quattro volte per contare le isole in fretta
    m = (fermo & bordi)
    r = 4
    hh, ww = h // r, w // r
    piccolo = m[:hh * r, :ww * r].reshape(hh, r, ww, r).mean(axis=(1, 3)) > 0.08
    # si chiudono i buchi (le cifre che cambiano stanno dentro la grafica)
    img = Image.fromarray((piccolo * 255).astype(np.uint8))
    img = img.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(3))
    piccolo = np.asarray(img) > 0
    migliore = None
    for x0, y0, x1, y1, area in componenti(piccolo):
        bw, bh = (x1 - x0) * r, (y1 - y0) * r
        if bw < w * 0.05 or bw > w * 0.55:
            continue            # troppo stretto per essere una grafica, o e' tutto lo stadio
        if bh < h * 0.08 or bh > h * 0.95:
            continue
        pieno = area / float((x1 - x0) * (y1 - y0))
        if pieno < 0.35:
            continue            # un riquadro deve essere pieno, non una ragnatela
        punteggio = area
        if migliore is None or punteggio > migliore[0]:
            migliore = (punteggio, x0 * r, y0 * r, bw, bh)
    if migliore is None:
        return None
    _, x, y, bw, bh = [int(v) for v in migliore]
    # un po' d'aria attorno, che le cifre non tocchino il bordo
    aria = 6
    x0, y0 = max(0, x - aria), max(0, y - aria)
    return (x0, y0, min(w, x + bw + aria) - x0, min(h, y + bh + aria) - y0)


def trova_cifre(a, b, box):
    """Dentro la grafica, il riquadro stretto attorno al cronometro.

    In venti secondi, dentro una grafica ferma, cambiano solo le cifre dei
    secondi. Trovate quelle, il cronometro intero sta alla loro sinistra:
    "70:" prima di "41". Si allarga di conseguenza, con un po' d'aria."""
    x, y, bw, bh = box
    d = np.abs(a[y:y + bh, x:x + bw] - b[y:y + bh, x:x + bw]) > 40
    if d.sum() < 12:
        return None
    ys, xs = np.nonzero(d)
    # si scartano i puntini isolati: contano le righe e colonne con piu' pixel cambiati
    righe = np.bincount(ys, minlength=bh) >= 2
    colonne = np.bincount(xs, minlength=bw) >= 2
    if not righe.any() or not colonne.any():
        return None
    y0, y1 = int(np.argmax(righe)), int(bh - np.argmax(righe[::-1]))
    x0, x1 = int(np.argmax(colonne)), int(bw - np.argmax(colonne[::-1]))
    cw, ch = x1 - x0, y1 - y0
    if ch < 6 or cw < 4:
        return None
    # a sinistra ci sono i minuti e i due punti: due volte e mezzo la larghezza
    # dei secondi; sopra e sotto mezza altezza d'aria
    sx = max(0, x0 - int(cw * 2.6) - 4)
    dx = min(bw, x1 + int(cw * 0.4) + 4)
    su = max(0, y0 - int(ch * 0.5))
    giu = min(bh, y1 + int(ch * 0.5))
    return (x + sx, y + su, dx - sx, giu - su)


def trova_targhe(a, b, box):
    """Dentro la grafica, i rettangoli pieni su cui stanno scritte le cifre.

    Il cronometro sta quasi sempre su una targa: chiara con cifre scure, o
    scura con cifre chiare. Una targa e' un'isola di pixel tutti chiari (o
    tutti scuri), piena, larga da due a sei volte la sua altezza."""
    x, y, bw, bh = box
    r = a[y:y + bh, x:x + bw]
    # la targa e' ferma: la folla chiara dietro no, e cosi' non si attacca
    fermo = np.abs(r - b[y:y + bh, x:x + bw]) < 12
    fuori = []
    for maschera in ((r > 205) & fermo, (r < 55) & fermo):
        img = Image.fromarray((maschera * 255).astype(np.uint8))
        # le cifre bucano la targa: si chiudono i buchi prima di contare
        img = img.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(5))
        m = np.asarray(img) > 0
        for x0, y0, x1, y1, area in componenti(m):
            tw, th = x1 - x0, y1 - y0
            if th < 12 or tw < 30:
                continue
            if tw / float(th) < 1.6 or tw / float(th) > 7:
                continue
            if area / float(tw * th) < 0.6:
                continue
            fuori.append((int(x + x0), int(y + y0), int(tw), int(th), int(area)))
    # prima le targhe piu' grandi: il cronometro e' la scritta piu' larga
    fuori.sort(key=lambda t: -t[4])
    return [t[:4] for t in fuori[:6]]


def leggi(percorso, box):
    x, y, bw, bh = box
    base = Image.open(percorso).convert("L").crop((x, y, x + bw, y + bh))
    k = max(3, int(round(120.0 / max(1, bh))))          # le cifre alte circa cento pixel
    base = base.resize((bw * k, bh * k), Image.LANCZOS)
    varianti = [base]
    # il lettore preferisce il nero su bianco: se la grafica e' scura, si inverte
    if np.asarray(base).mean() < 128:
        varianti.insert(0, Image.eval(base, lambda v: 255 - v))
    testi = []
    for img in varianti:
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        img.save(tmp.name)
        try:
            for psm in ("7", "6", "11"):
                try:
                    out = subprocess.run([TESSERACT, tmp.name, "stdout", "--psm", psm,
                                          "-c", "tessedit_char_whitelist=0123456789:"],
                                         capture_output=True, text=True, timeout=30).stdout
                except Exception:
                    continue
                testi.append(out.strip())
                for m in ORA.finditer(out):
                    mm, ss = int(m.group(1)), int(m.group(2))
                    if ss < 60 and mm <= 130:
                        return mm * 60 + ss, testi
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
    return None, testi


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"errore": "servono due fotogrammi"}))
        return 2
    fa, fb = sys.argv[1], sys.argv[2]
    a, b = grigio(fa), grigio(fb)
    if a.shape != b.shape:
        print(json.dumps({"errore": "i due fotogrammi non hanno la stessa misura"}))
        return 2
    box = trova_grafica(a, b)
    if box is None:
        print(json.dumps({"letture": [None, None], "box": None, "perche": "nessuna grafica ferma"}))
        return 0
    c1 = c2 = None
    t1 = t2 = []
    cifre = None
    for targa in trova_targhe(a, b, box):
        c1, t1 = leggi(fa, targa)
        if c1 is None:
            continue
        c2, t2 = leggi(fb, targa)
        if c2 is not None:
            cifre = targa
            break
    if c1 is None or c2 is None:
        # senza le cifre strette si legge tutta la grafica
        d1, u1 = leggi(fa, box)
        d2, u2 = leggi(fb, box)
        c1, c2 = (c1 if c1 is not None else d1), (c2 if c2 is not None else d2)
        t1, t2 = t1 + u1, t2 + u2
    print(json.dumps({"letture": [c1, c2], "box": list(box), "cifre": list(cifre) if cifre else None,
                      "testo": [t1, t2]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
