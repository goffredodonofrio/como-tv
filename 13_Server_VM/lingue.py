#!/usr/bin/env python3
# LE ALTRE LINGUE DI UNA PARTITA (30/09/2026). La nostra registrazione del
# Como e' il feed del club col commento italiano; lo stesso feed esiste col
# commento inglese e col solo suono internazionale ("AUDIO ONLY"), in file
# tagliati in modo diverso. Per sentire l'ENG o l'INT sotto un'azione bisogna
# sapere a che secondo di quel file corrisponde un secondo dell'ITA.
#
# Si confronta la FORMA D'ONDA: sotto i commenti c'e' lo stesso tappeto dello
# stadio, campione per campione (provato su Udinese-Como del 6/4/2026: gli
# inviluppi di energia non bastavano, l'onda grezza si').  Un tratto di pochi
# secondi dell'ITA si cerca in una finestra dell'altro file; si provano piu'
# tratti e valgono solo se sono d'accordo fra loro.
#
#   lingue.py allinea ITA T ALTRO DA DUR   -> {"t": secondo nell'altro file, "forza": x, "netto": x}
import json, subprocess, sys
import numpy as np

SR = 8000
PEZZO = 6.0        # secondi dell'ITA da ritrovare


def pcm(via, da, dur):
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-ss", str(max(0.0, da)), "-i", via, "-t", str(dur),
           "-vn", "-ac", "1", "-ar", str(SR), "-af", "highpass=f=120", "-f", "f32le", "-"]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).astype(np.float64)


def cerca(a, b):
    """dove sta a (corto) dentro b: indice del campione, correlazione normalizzata, secondo picco"""
    m, n = len(a), len(b)
    if m < SR or n < m:
        return None, 0.0, 0.0
    a = a - a.mean()
    na = np.sqrt((a * a).sum()) + 1e-12
    L = 1
    while L < n + m:
        L *= 2
    c = np.fft.irfft(np.fft.rfft(b, L) * np.fft.rfft(a[::-1], L), L)[m - 1: n]
    cs2 = np.concatenate([[0.0], np.cumsum(b * b)])
    cs = np.concatenate([[0.0], np.cumsum(b)])
    en = (cs2[m:] - cs2[:-m]) - (cs[m:] - cs[:-m]) ** 2 / m
    r = c / (na * np.sqrt(np.maximum(en, 1e-9)))
    i = int(np.argmax(r))
    picco = float(r[i])
    r2 = r.copy()
    r2[max(0, i - SR // 2): i + SR // 2] = -1       # il secondo migliore, a mezzo secondo almeno
    return i, picco, float(r2.max())


def allinea(ita, t, altro, da, dur):
    a = pcm(ita, t, PEZZO)
    b = pcm(altro, da, dur)
    i, picco, secondo = cerca(a, b)
    if i is None:
        return {"t": None, "forza": 0, "netto": 0}
    return {"t": round(max(0.0, da) + i / SR, 3), "forza": round(picco, 3), "netto": round(picco / max(secondo, 1e-3), 2)}


def main():
    if sys.argv[1] == "allinea":
        print(json.dumps(allinea(sys.argv[2], float(sys.argv[3]), sys.argv[4], float(sys.argv[5]), float(sys.argv[6]))))


if __name__ == "__main__":
    main()
