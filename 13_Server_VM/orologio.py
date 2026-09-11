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
PUNTI = re.compile(r"(?<!\d)(\d{1,2})\s*[-\u2013]\s*(\d{1,2})(?!\d)")
SOLO_PUNTI = re.compile(r"^(\d{1,2})[-\u2013](\d{1,2})$")


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


def leggi_testo(percorso, box, whitelist, psm):
    """Il testo grezzo di un ritaglio, ingrandito come piace al lettore."""
    x, y, bw, bh = box
    im = Image.open(percorso).convert("L")
    W, H = im.size
    x, y = max(0, x), max(0, y)
    bw, bh = min(bw, W - x), min(bh, H - y)
    if bw < 8 or bh < 8:
        return []
    base = im.crop((x, y, x + bw, y + bh))
    k = max(3, int(round(110.0 / max(1, bh))))
    base = base.resize((bw * k, bh * k), Image.LANCZOS)
    varianti = [base]
    if np.asarray(base).mean() < 128:
        varianti.insert(0, Image.eval(base, lambda v: 255 - v))
    fuori = []
    for img in varianti:
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        img.save(tmp.name)
        try:
            cmd = [TESSERACT, tmp.name, "stdout", "--psm", psm]
            if whitelist:
                cmd += ["-c", "tessedit_char_whitelist=" + whitelist]
            try:
                fuori.append(subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip())
            except Exception:
                pass
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
    return fuori


def scatole_punteggio(targa):
    """I riquadri dove puo' stare il punteggio, dal piu' stretto al piu' largo.

    Il tabellone e' una barra: cronometro, squadra, punteggio, squadra. Il
    punteggio sta subito dopo il cronometro, sulla stessa riga, e occupa
    poco piu' di un'altezza. Troppo stretto taglia una cifra, troppo largo
    si porta dentro la prima lettera della squadra — e una S lunga diventa
    un 5. Non si indovina: si provano, e vince quella che su tre fotogrammi
    diversi legge sempre la stessa cosa pulita.
    """
    x, y, bw, bh = targa
    # Il riquadro trovato per il cronometro a volte e' solo l'orologio, a
    # volte tutta la barra — dipende da com'e' disegnata la grafica. Nel
    # primo caso il risultato sta a destra, nel secondo sta DENTRO. Non si
    # sceglie: si scorre una finestra da sinistra del cronometro fino a
    # qualche altezza piu' in la', e si prova a leggere in ognuna.
    fuori = []
    passo = max(12, int(bh * 0.5))
    fine = x + bw + int(bh * 6)
    for larga in (1.0, 1.4, 2.0, 2.8):
        w = max(20, int(bh * larga))
        px = x
        while px + w <= fine:
            fuori.append((px, y, w, bh))
            px += passo
    return fuori


def punteggio_in(percorso, box):
    """Il punteggio dentro un riquadro preciso, o niente."""
    visti = set()
    for testo in leggi_testo(percorso, box, "0123456789-", "7"):
        m = SOLO_PUNTI.match(testo.replace(" ", "").strip())
        if m:
            visti.add("%d-%d" % (int(m.group(1)), int(m.group(2))))
    return visti.pop() if len(visti) == 1 else None


def punteggio(percorso, targa):
    """Il risultato scritto sul tabellone, come coppia di numeri.

    Il tabellone e' una barra sola: a sinistra il cronometro (la targa che
    conosciamo gia'), poi le squadre col punteggio in mezzo. Si guarda
    prima nel punto dove il punteggio sta quasi sempre — subito dopo il
    cronometro, sulla stessa riga — e li' si legge una cosa sola, "1-0",
    senza che nomi e loghi disturbino. Se li' non si legge niente si allarga
    a tutta la barra e si cerca la forma "cifra trattino cifra", buttando
    via il cronometro che ha la stessa forma ma i secondi a due cifre.
    """
    x, y, bw, bh = targa
    strette = [(x + bw, y, int(bh * 1.6), bh),
               (x + bw, y, int(bh * 2.6), bh),
               (x + bw - int(bh * 0.3), y, int(bh * 2.0), bh)]
    # Nel riquadro stretto ci deve stare SOLO il punteggio: se esce
    # dell'altro, quel riquadro e' storto. Le barrette che dividono le
    # squadre il lettore le scambia per degli "1" — "0-0|" diventa "0-01",
    # cioe' zero a uno — e un gol inventato al primo minuto manda tutta la
    # ricerca dietro a niente. Quindi qui si accetta solo la riga intera.
    # ...e se due letture dello stesso riquadro non dicono la stessa cosa,
    # non si sceglie la piu' simpatica: non si legge niente. Meglio un buco
    # che un gol inventato.
    for box in strette:
        visti = set()
        for testo in leggi_testo(percorso, box, "0123456789-", "7"):
            m = SOLO_PUNTI.match(testo.replace(" ", "").strip())
            if m:
                visti.add("%d-%d" % (int(m.group(1)), int(m.group(2))))
        if len(visti) == 1:
            return visti.pop(), list(box)
        if visti:
            return None, None
    # tutta la barra, lettere comprese: il trattino fra due cifre e' il
    # risultato, e i due punti con due secondi sono il cronometro
    largo = (max(0, x - int(bh * 0.4)), y, int(bh * 9), bh)
    for testo in leggi_testo(percorso, largo, "", "7"):
        pulito = ORA.sub(" ", testo)
        m = PUNTI.search(pulito)
        if m:
            return "%d-%d" % (int(m.group(1)), int(m.group(2))), list(largo)
    return None, None


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
    # Modo "punteggio": la targa del cronometro e uno o piu' fotogrammi.
    # Torna il risultato scritto sul tabellone in ognuno.
    if len(sys.argv) >= 4 and sys.argv[1] == "--punteggio":
        # con la scatola gia' scelta si legge solo li': e' la strada di tutti
        # i giorni, una lettura per fotogramma
        if sys.argv[2] == "--box":
            box = [int(v) for v in sys.argv[3].split(",")]
            letti = []
            for percorso in sys.argv[4:]:
                try:
                    letti.append(punteggio_in(percorso, box))
                except Exception:
                    letti.append(None)
            print(json.dumps({"punteggi": letti, "box": box}))
            return 0
        targa = [int(v) for v in sys.argv[2].split(",")]
        letti, dove = [], None
        for percorso in sys.argv[3:]:
            try:
                p, box = punteggio(percorso, targa)
            except Exception:
                p, box = None, None
            letti.append(p)
            if box and not dove:
                dove = box
        print(json.dumps({"punteggi": letti, "box": dove}))
        return 0
    # Modo "tabellone": la targa del cronometro e qualche fotogramma
    # dell'inizio partita. Si cerca il riquadro del punteggio e si tiene
    # quello che su tutti legge la stessa cosa.
    if len(sys.argv) >= 4 and sys.argv[1] == "--tabellone":
        targa = [int(v) for v in sys.argv[2].split(",")]
        frame = sys.argv[3:]
        # PRIMA SI SCREMA, POI SI CONFERMA. I riquadri da provare sono
        # quaranta: provarli tutti su tutti i fotogrammi vorrebbe dire
        # centocinquanta letture. Sul primo fotogramma sopravvivono in tre
        # o quattro, e solo quelli si controllano sugli altri.
        vivi = []
        for box in scatole_punteggio(targa):
            try:
                p = punteggio_in(frame[0], box)
            except Exception:
                p = None
            # una squadra non ha fatto venti gol al quarto d'ora: un numero
            # grosso e' una lettera letta male — la R di VER diventa un 2
            if p and all(int(v) <= 9 for v in p.split("-")):
                vivi.append((list(box), p))
        # il valore giusto e' quello che leggono in piu' riquadri: uno solo
        # puo' sbagliare, tre che dicono la stessa cosa no
        if vivi:
            conta = {}
            for _, p in vivi:
                conta[p] = conta.get(p, 0) + 1
            comune = sorted(conta.items(), key=lambda kv: -kv[1])[0][0]
            vivi = [(b, p) for b, p in vivi if p == comune]
        migliore = None
        for box, p0 in vivi:
            letti = [p0]
            for percorso in frame[1:]:
                try:
                    letti.append(punteggio_in(percorso, box))
                except Exception:
                    letti.append(None)
            buoni = [x for x in letti if x]
            if len(buoni) < max(2, len(frame) - 1):
                continue
            # non per forza lo stesso numero: fra un fotogramma e l'altro
            # puo' esserci un gol. Quello che non puo' succedere e' che il
            # risultato TORNI INDIETRO — quella e' una lettura sbagliata.
            def sale(v):
                for i in range(1, len(v)):
                    a0 = [int(z) for z in v[i - 1].split("-")]
                    a1 = [int(z) for z in v[i].split("-")]
                    if a1[0] < a0[0] or a1[1] < a0[1]:
                        return False
                return True
            if not sale(buoni):
                continue
            # a parita', il riquadro piu' stretto: meno roba dentro, meno errori
            if migliore is None or box[2] < migliore[0][2]:
                migliore = (list(box), buoni[0], len(buoni))
        if not migliore:
            print(json.dumps({"box": None, "perche": "nessun riquadro legge un punteggio stabile"}))
            return 0
        print(json.dumps({"box": migliore[0], "punteggio": migliore[1], "letti": migliore[2]}))
        return 0
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
