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


def isole_ferme(a, b, soglia):
    """Le isole di pixel fermi e disegnati, come riquadri (x, y, w, h, area)."""
    h, w = a.shape
    fermo = np.abs(a - b) < soglia
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
    fuori = []
    for x0, y0, x1, y1, area in componenti(piccolo):
        bw, bh = (x1 - x0) * r, (y1 - y0) * r
        if bw < w * 0.05 or bw > w * 0.55:
            continue            # troppo stretto per essere una grafica, o e' tutto lo stadio
        if bh < h * 0.08 or bh > h * 0.95:
            continue
        if area / float((x1 - x0) * (y1 - y0)) < 0.25:
            continue            # un riquadro deve essere pieno, non una ragnatela
        fuori.append((int(x0 * r), int(y0 * r), int(bw), int(bh), int(area * r * r)))
    return fuori


def righe_chiare(a, b):
    """Le righe di scritte chiare che non si muovono: una grafica e' anche
    questo, quando il fondo e' trasparente e la folla ci passa attraverso."""
    h, w = a.shape
    m = (a > 200) & (np.abs(a - b) < 40)
    img = Image.fromarray((m * 255).astype(np.uint8))
    img = img.filter(ImageFilter.MaxFilter(21)).filter(ImageFilter.MinFilter(7))
    m = np.asarray(img) > 0
    r = 2
    hh, ww = h // r, w // r
    piccolo = m[:hh * r, :ww * r].reshape(hh, r, ww, r).max(axis=(1, 3)) > 0
    fuori = []
    for x0, y0, x1, y1, area in componenti(piccolo):
        bw, bh = (x1 - x0) * r, (y1 - y0) * r
        if bw < w * 0.05 or bw > w * 0.55 or bh < 14 or bh > h * 0.6:
            continue
        if bw / float(bh) < 1.6 or bw / float(bh) > 14:
            continue
        fuori.append((int(x0 * r), int(y0 * r), int(bw), int(bh), int(area * r * r)))
    return fuori


def trova_grafica(a, b):
    """I riquadri (x, y, w, h) che potrebbero essere la grafica, dal piu' probabile.

    Non si sceglie qui: si prova a leggere in ciascuno, e vince quello in
    cui si legge un orario. Un cartellone fermo non ha un cronometro. Tre
    fonti: le isole ferme con soglia stretta, quelle con soglia larga (la
    grafica semitrasparente), le righe di scritte chiare."""
    h, w = a.shape
    candidati = []
    for fonte in (isole_ferme(a, b, 12), isole_ferme(a, b, 20), righe_chiare(a, b)):
        fonte.sort(key=lambda c: -c[4])
        for x, y, bw, bh, area in fonte[:4]:
            doppione = False
            for x2, y2, bw2, bh2 in candidati:
                ix = max(0, min(x + bw, x2 + bw2) - max(x, x2))
                iy = max(0, min(y + bh, y2 + bh2) - max(y, y2))
                if ix * iy > 0.6 * min(bw * bh, bw2 * bh2):
                    doppione = True
                    break
            if not doppione:
                candidati.append((x, y, bw, bh))
    fuori = []
    for x, y, bw, bh in candidati[:8]:
        # un po' d'aria attorno, che le cifre non tocchino il bordo
        aria = 6
        x0, y0 = max(0, x - aria), max(0, y - aria)
        fuori.append((x0, y0, min(w, x + bw + aria) - x0, min(h, y + bh + aria) - y0))
    return fuori


def trova_targhe(a, b, box):
    """Dentro la grafica, i rettangoli pieni su cui stanno scritte le cifre.

    Il cronometro sta quasi sempre su una targa: chiara con cifre scure, o
    scura con cifre chiare. Una targa e' un'isola di pixel tutti chiari (o
    tutti scuri), piena, larga da due a sei volte la sua altezza."""
    x, y, bw, bh = box
    r = a[y:y + bh, x:x + bw]
    # la targa e' ferma: la folla chiara dietro no, e cosi' non si attacca
    fermo = np.abs(r - b[y:y + bh, x:x + bw]) < 20
    fuori = []
    # tre modi di essere una targa: chiara e piena, scura e piena, oppure
    # solo una riga di scritte chiare su un fondo che lascia passare la folla
    prove = (((r > 205) & fermo, 7, 5), ((r < 55) & fermo, 7, 5), ((r > 200) & (np.abs(r - b[y:y + bh, x:x + bw]) < 40), 21, 7))
    for maschera, chiudi, apri in prove:
        img = Image.fromarray((maschera * 255).astype(np.uint8))
        # le cifre bucano la targa: si chiudono i buchi prima di contare
        img = img.filter(ImageFilter.MaxFilter(chiudi)).filter(ImageFilter.MinFilter(apri))
        m = np.asarray(img) > 0
        for x0, y0, x1, y1, area in componenti(m):
            tw, th = x1 - x0, y1 - y0
            if th < 12 or tw < 30:
                continue
            if tw / float(th) < 1.6 or tw / float(th) > 7:
                continue
            if area / float(tw * th) < 0.5:
                continue
            fuori.append((int(x + x0), int(y + y0), int(tw), int(th), int(area)))
    # prima le targhe piu' grandi: il cronometro e' la scritta piu' larga
    fuori.sort(key=lambda t: -t[4])
    return [t[:4] for t in fuori[:8]]


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


def somiglianza(a, b):
    """Quanto due ritagli si assomigliano, da -1 a 1 (correlazione normalizzata).

    Serve a sapere se la targa del cronometro c'e' o non c'e' senza doverla
    leggere: le cifre cambiano, ma la targa e' sempre lo stesso disegno. Il
    lettore di testo ogni tanto non legge anche quando la targa c'e' — e un
    "non letto" scambiato per "non c'e'" allungava il pezzo del gol dentro
    il gioco. Il disegno invece o c'e' o non c'e'.
    """
    if a.shape != b.shape:
        return -1.0
    x, y = a.astype(np.float64).ravel(), b.astype(np.float64).ravel()
    x -= x.mean(); y -= y.mean()
    dx, dy = np.sqrt((x * x).sum()), np.sqrt((y * y).sum())
    if dx < 1e-6 or dy < 1e-6:
        return -1.0
    return float((x * y).sum() / (dx * dy))


def ritaglio(percorso, box):
    im = Image.open(percorso).convert("L")
    x, y, bw, bh = box
    if bw <= 0 or bh <= 0:                 # zero = tutto il fotogramma
        return np.asarray(im, dtype=np.float32)
    return np.asarray(im.crop((x, y, x + bw, y + bh)), dtype=np.float32)


def main():
    # Modo "presente": c'e' la targa in questi fotogrammi? Si confronta il
    # disegno con quello di un fotogramma in cui la targa c'era di sicuro.
    if len(sys.argv) >= 5 and sys.argv[1] == "--presente":
        box = [int(v) for v in sys.argv[2].split(",")]
        rif = ritaglio(sys.argv[3], box)
        fuori = []
        for percorso in sys.argv[4:]:
            try:
                fuori.append(round(somiglianza(rif, ritaglio(percorso, box)), 3))
            except Exception:
                fuori.append(None)
        print(json.dumps({"somiglianze": fuori}))
        return 0
    # Modo "targa": un fotogramma solo e la scatola gia' nota. Serve a
    # sapere se in quel momento il cronometro c'e' o non c'e': durante un
    # replay la regia lo toglie, e quando torna vuol dire che si ricomincia.
    if len(sys.argv) >= 4 and sys.argv[1] == "--targa":
        box = [int(v) for v in sys.argv[2].split(",")]
        letture = []
        for percorso in sys.argv[3:]:
            try:
                n, _ = leggi(percorso, box)
            except Exception:
                n = None
            letture.append(n)
        print(json.dumps({"letture": letture}))
        return 0
    if len(sys.argv) < 3:
        print(json.dumps({"errore": "servono due fotogrammi"}))
        return 2
    fa, fb = sys.argv[1], sys.argv[2]
    a, b = grigio(fa), grigio(fb)
    if a.shape != b.shape:
        print(json.dumps({"errore": "i due fotogrammi non hanno la stessa misura"}))
        return 2
    scatole = trova_grafica(a, b)
    if not scatole:
        print(json.dumps({"letture": [None, None], "box": None, "perche": "nessuna grafica ferma"}))
        return 0
    c1 = c2 = None
    t1 = t2 = []
    cifre = None
    box = scatole[0]
    for box in scatole:
        for targa in trova_targhe(a, b, box):
            c1, t1 = leggi(fa, targa)
            if c1 is None:
                continue
            c2, t2 = leggi(fb, targa)
            if c2 is not None and abs((c2 - c1) - 20) <= 3:
                cifre = targa
                break
            c1 = c2 = None
        if cifre:
            break
    if cifre is None:
        # senza targhe si legge tutta la grafica, candidato per candidato
        for box in scatole:
            d1, u1 = leggi(fa, box)
            d2, u2 = leggi(fb, box)
            t1, t2 = t1 + u1, t2 + u2
            if d1 is not None and d2 is not None:
                c1, c2 = d1, d2
                break
    print(json.dumps({"letture": [c1, c2], "box": list(box), "cifre": list(cifre) if cifre else None,
                      "testo": [t1, t2]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
