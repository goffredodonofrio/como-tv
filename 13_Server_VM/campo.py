#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Guarda l'inquadratura e dice quando c'e' la telecamera larga del gioco.

  python3 campo.py partita.mp4 40 120 1  ->  {"campo": [{"s": 40, "prato": .., "alto": .., "moto": ..}, ...]}

Serve a capire dove finisce un replay sui feed che il cronometro non lo
tolgono mai (Groningen) — e su tutti gli altri, perche' non legge niente:
guarda solo com'e' fatta l'immagine.

Tre numeri per ogni secondo:

  prato  quanto verde c'e' in tutto il quadro
  alto   quanto verde c'e' nel quarto ALTO. E' quello che conta: nella
         camera larga in cima ci sono gli spalti (0,01-0,05), in un primo
         piano su un giocatore in mezzo al campo c'e' ancora prato
         (0,86-0,90). Senza questo, un primo piano sull'erba sembrava
         gioco.
  moto   quanto cambia il quadro rispetto al secondo prima. La camera
         larga sta ferma e i giocatori sono piccoli (7-25); esultanze e
         replay stanno sotto il naso alla gente e stanno sopra 30.

Misurato il 7 settembre 2026 su quattro gol di GRONINGEN-TWENTE.
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


def campo(via, da, durata, passo):
    fuori = tempfile.mkdtemp(prefix="campo-")
    try:
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error",
                        "-ss", str(da), "-t", str(durata), "-i", via,
                        "-vf", "fps=%g,scale=320:180" % (1.0 / passo),
                        "-y", os.path.join(fuori, "f%05d.png")],
                       check=True, timeout=900)
        esito, prec = [], None
        for i, f in enumerate(sorted(glob.glob(os.path.join(fuori, "*.png")))):
            q = np.asarray(Image.open(f).convert("RGB")).astype(np.int16)
            R, G, B = q[:, :, 0], q[:, :, 1], q[:, :, 2]
            verde = (G > R + 12) & (G > B + 12)
            grigio = q.mean(axis=2)
            moto = 0.0 if prec is None else float(np.abs(grigio - prec).mean())
            prec = grigio
            esito.append({"s": round(da + i * passo, 2),
                          "prato": round(float(verde.mean()), 3),
                          "alto": round(float(verde[:verde.shape[0] // 4].mean()), 3),
                          "moto": round(moto, 1)})
        return esito
    finally:
        for f in glob.glob(os.path.join(fuori, "*.png")):
            try:
                os.unlink(f)
            except OSError:
                pass
        try:
            os.rmdir(fuori)
        except OSError:
            pass


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"errore": "uso: campo.py file da [durata] [passo]"}))
        return 1
    via = sys.argv[1]
    da = float(sys.argv[2])
    durata = float(sys.argv[3]) if len(sys.argv) > 3 else 120.0
    passo = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    try:
        print(json.dumps({"campo": campo(via, da, durata, passo)}))
    except Exception as e:
        print(json.dumps({"errore": repr(e)[:300]}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
