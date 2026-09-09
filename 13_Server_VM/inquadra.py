#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Propone dove inquadrare, quando da un 16:9 si taglia un verticale.

  python3 inquadra.py partita.mp4 22 12 0.5625  ->  {"punti": [{"t":0,"x":0.42}, ...]}

Il quarto numero e' quanto e' largo il ritaglio rispetto al quadro intero
(un 9:16 dentro un 16:9 e' 0,3164; un 3:4 e' 0,4219).

COSA SEGUE, E PERCHE' NON LA PALLA. La palla e' piccola, va veloce e
sparisce dietro i giocatori: inseguirla fa tremare il quadro, e un
inseguimento nervoso e' peggio di un'inquadratura ferma. Nemmeno il
movimento va bene: misurato l'8 settembre 2026 su tre azioni, seguire il
movimento non migliora niente (32%->34%, e su una ripartenza peggiora)
perche' quando la camera panoramica si sposta si muove tutto il quadro.
Quello che funziona e' seguire i GIOCATORI, che sono una posizione e non
una differenza: macchie non verdi dentro il prato, spalti esclusi. Sulla
stessa azione da gol: 28% -> 42% di giocatori dentro l'inquadratura.

E SE SONO SPARSI NON SI INSEGUE. Quando la squadra e' schierata su tutto il
campo nessun verticale la contiene — e' geometria, non taratura: un 9:16
dentro un 16:9 e' il 31% della larghezza. In quel caso la proposta e' stare
fermi al centro, che e' la risposta onesta.
"""
import glob
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

FFMPEG = os.environ.get("COMOTV_FFMPEG", "ffmpeg")
# Tarati su fotogrammi da un quinto di secondo: la costante e' la stessa
# in secondi (circa uno), il passo massimo lo stesso in secondi (10%).
LENTO = 0.22          # quanto insegue: piu' alto, piu' nervoso
MAX_PASSO = 0.02      # e comunque non piu' di questo per fotogramma
# QUANTO FITTO SI GUARDA. La curva e' smorzata su piu' di un secondo:
# guardarla dodici volte al secondo era sprecato, e su un pezzo da cento
# secondi voleva dire milletrecento fotogrammi — minuti di attesa dentro
# un export. A cinque al secondo la curva e' identica e si aspetta un
# terzo. E si guarda piccolo: 240 di larghezza bastano per capire dove
# sono i giocatori.
FPS = 5.0
LARGO_LETTURA = 240


def giocatori(via, da, durata):
    """Le colonne dei giocatori e il loro baricentro, fotogramma per fotogramma."""
    d = tempfile.mkdtemp(prefix="inq-")
    try:
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
                        "-ss", str(da), "-t", str(durata), "-i", via,
                        "-vf", "fps=%g,scale=%d:-2" % (FPS, LARGO_LETTURA), "-y", os.path.join(d, "f%05d.png")],
                       check=True, timeout=900)
        fuori, colonne, ultimo = [], [], 0.5
        for f in sorted(glob.glob(os.path.join(d, "*.png"))):
            a = np.asarray(Image.open(f).convert("RGB")).astype(np.int16)
            a = a[int(a.shape[0] * 0.30):, :, :]          # via gli spalti
            R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
            prato = (G > R + 12) & (G > B + 12)
            gioc = (~prato) & (a.mean(axis=2) > 25) & (prato.mean(axis=0) > 0.25)
            c = gioc.sum(axis=0).astype(np.float64)
            if c.sum() > 40:
                ultimo = float((c * np.arange(len(c))).sum() / c.sum()) / len(c)
            colonne.append(c)
            fuori.append(ultimo)
        return fuori, colonne

    finally:
        for f in glob.glob(os.path.join(d, "*.png")):
            try: os.unlink(f)
            except OSError: pass
        try: os.rmdir(d)
        except OSError: pass


def quantoSparsi(c):
    """Quanto sono sparsi i giocatori, da 0 (tutti in un punto) a 1 (su tutto
    il campo). E' lo scarto quadratico medio delle loro posizioni."""
    tot = c.sum()
    if tot < 40: return 1.0
    n = len(c)
    p = np.arange(n) / n
    m = float((c * p).sum() / tot)
    var = float((c * (p - m) ** 2).sum() / tot)
    return min(1.0, (var ** 0.5) / 0.29)      # 0.29 = sparsi su tutta la larghezza


def smorza(grezzo):
    fuori, cur = [], (grezzo[0] if grezzo else 0.5)
    for g in grezzo:
        t = cur + (g - cur) * LENTO
        cur = max(cur - MAX_PASSO, min(cur + MAX_PASSO, t))
        fuori.append(cur)
    return fuori


def pochiPunti(curva, tolleranza=0.02):
    """Da una curva fitta a pochi keyframe: si tengono solo i punti che, tolti,
    sposterebbero l'inquadratura piu' della tolleranza (Douglas-Peucker)."""
    n = len(curva)
    if n < 3: return [0, n - 1] if n else []
    tieni = {0, n - 1}
    def giu(a, b):
        if b - a < 2: return
        peggio, dove = 0.0, a
        for i in range(a + 1, b):
            atteso = curva[a] + (curva[b] - curva[a]) * (i - a) / (b - a)
            e = abs(curva[i] - atteso)
            if e > peggio: peggio, dove = e, i
        if peggio > tolleranza:
            tieni.add(dove); giu(a, dove); giu(dove, b)
    giu(0, n - 1)
    return sorted(tieni)


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"errore": "uso: inquadra.py file da durata [larghezza]"})); return 1
    via, da, durata = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    largo = float(sys.argv[4]) if len(sys.argv) > 4 else (9 / 16) / (16 / 9)
    try:
        grezzo, colonne = giocatori(via, da, durata)
        if not grezzo:
            print(json.dumps({"punti": [], "perche": "non ho letto nessun fotogramma"})); return 0
        # DOVE SONO SPARSI, SI STA AL CENTRO. Non e' una decisione sola per
        # tutto il pezzo: dentro lo stesso gol c'e' l'azione (giocatori
        # stretti: si segue) e l'esultanza o il gioco fermo (sparsi: nessun
        # verticale li contiene, e inseguire peggiora). Quindi il punto da
        # inquadrare e' una via di mezzo fra il baricentro e il centro,
        # pesata su quanto sono larghi in quel momento.
        misto = []
        for c, g in zip(colonne, grezzo):
            # l'esponente e' tarato: a 2 la prudenza mangiava il guadagno
            # (28→32%), a 4 tiene tutto (28→36%) senza peggiorare le altre
            w = quantoSparsi(c) ** 4
            misto.append(g * (1 - w) + 0.5 * w)
        grezzo = misto
        curva = smorza(grezzo)

        # SI PROPONE DI SEGUIRE SOLO SE SEGUIRE SERVE. Misurato l'8 settembre:
        # quando i giocatori sono sparsi su tutto il campo l'inseguimento non
        # guadagna niente e ogni tanto peggiora, perche' nessun verticale
        # contiene una squadra schierata. Quindi si confronta: quanti
        # giocatori restano dentro stando fermi al centro, e quanti seguendo.
        def quanti_dentro(c, centro):
            tot = c.sum()
            if tot < 40: return None
            n = len(c)
            a = max(0.0, min(1.0 - largo, centro - largo / 2))
            i0, i1 = int(a * n), max(int(a * n) + 1, int((a + largo) * n))
            return float(c[i0:i1].sum() / tot)
        fermi = [q for q in (quanti_dentro(c, 0.5) for c in colonne) if q is not None]
        segue = [q for q in (quanti_dentro(c, x) for c, x in zip(colonne, curva)) if q is not None]
        m_fermi = float(np.mean(fermi)) if fermi else 0.0
        m_segue = float(np.mean(segue)) if segue else 0.0
        guadagno = m_segue - m_fermi
        larghezza = max(curva) - min(curva)
        vale = guadagno > 0.015 and larghezza > 0.02

        indici = pochiPunti(curva)
        punti = [{"t": round(i / FPS, 2), "x": round(curva[i], 4)} for i in indici]
        print(json.dumps({
            "punti": punti if vale else [],
            "fermo": not vale,
            "escursione": round(larghezza, 3),
            "dentroFermo": round(m_fermi, 3),
            "dentroSegue": round(m_segue, 3),
            "guadagno": round(guadagno, 3),
            "quanti": len(punti) if vale else 0,
            "perche": ("l'azione si sposta e seguendola resta dentro il %d%% del gioco invece del %d%%"
                       % (round(m_segue * 100), round(m_fermi * 100))) if vale else
                      ("i giocatori sono sparsi: nessun verticale li contiene, meglio fermi al centro"
                       if guadagno <= 0.05 else "l'azione sta ferma: nessun movimento da fare")
        }))
    except Exception as e:
        print(json.dumps({"errore": repr(e)[:300]})); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
