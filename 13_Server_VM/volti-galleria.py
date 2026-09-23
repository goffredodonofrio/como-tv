#!/usr/bin/env python3
"""Trasforma gli scontornati in un ricordo di volti.

In /var/lib/comotv/loghi ci sono settemila ritratti scontornati, uno per
giocatore, gia' etichettati col cognome: e' la nostra galleria, costruita
per le formazioni premium. Qui la si legge una volta sola e la si riduce a
numeri: per ogni foto, centoventotto valori che descrivono il volto e non
la posa, la maglia o la stagione. Due foto della stessa persona danno
numeri vicini; e' tutto quello che serve per riconoscerla altrove.

Il risultato pesa pochi megabyte e non va piu' rifatto: da qui in poi
riconoscere un volto e' un confronto fra vettori, cioe' niente.

  YuNet trova il volto (MIT), SFace lo traduce in numeri (Apache 2.0):
  licenze commerciali pulite, entrambi girano su CPU.

    /opt/volti/bin/python volti-galleria.py            # tutta la galleria
    /opt/volti/bin/python volti-galleria.py --quanti 200   # una prova
"""
import argparse
import glob
import json
import os
import time
from multiprocessing import Pool

import cv2
import numpy as np

LOGHI = "/var/lib/comotv/loghi"
CASA = "/var/lib/comotv/volti"
MODELLI = "/opt/volti/modelli"
LATO = 640          # oltre non serve: in un ritratto il volto e' gia' grande
FIDUCIA = 0.6       # piu' bassa del solito: gli scontornati sono ritagli strani

_occhi = None


def strumenti():
    """Un rilevatore per processo: non si possono condividere fra i figli."""
    global _occhi
    if _occhi is None:
        os.environ.setdefault("OPENCV_LOG_LEVEL", "SILENT")
        _occhi = (
            cv2.FaceDetectorYN.create(MODELLI + "/yunet.onnx", "", (LATO, LATO),
                                      FIDUCIA, 0.3, 5000),
            cv2.FaceRecognizerSF.create(MODELLI + "/sface.onnx", ""),
        )
    return _occhi


def su_grigio(im):
    """Lo scontornato ha lo sfondo trasparente, e sotto la trasparenza spesso
    c'e' nero: il rilevatore ci vede un bordo netto che non esiste. Si
    appoggia la figura su un grigio neutro, come una foto vera."""
    if im.ndim == 3 and im.shape[2] == 4:
        a = im[:, :, 3:4].astype(np.float32) / 255.0
        sotto = np.full(im[:, :, :3].shape, 128, np.float32)
        return (im[:, :, :3].astype(np.float32) * a + sotto * (1 - a)).astype(np.uint8)
    return im[:, :, :3] if im.ndim == 3 else cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)


def chi_e(nome_file):
    """Dal nome del file a chi ritrae. `coach-milan` e' l'allenatore di quella
    squadra, `abu-taha-317847` porta in coda l'identificativo ESPN."""
    n = nome_file[len("foto-premium-"):].rsplit(".", 1)[0]
    if n.startswith("coach-"):
        return "allenatore", n[len("coach-"):], ""
    pezzi = n.rsplit("-", 1)
    if len(pezzi) == 2 and pezzi[1].isdigit():
        return "giocatore", pezzi[0], pezzi[1]
    return "giocatore", n, ""


def leggi(percorso):
    rilevatore, traduttore = strumenti()
    im = cv2.imread(percorso, cv2.IMREAD_UNCHANGED)
    if im is None:
        return {"file": os.path.basename(percorso), "esito": "illeggibile"}
    im = su_grigio(im)
    h, w = im.shape[:2]
    scala = LATO / max(h, w)
    if scala < 1:
        im = cv2.resize(im, (int(w * scala), int(h * scala)), interpolation=cv2.INTER_AREA)
        h, w = im.shape[:2]
    rilevatore.setInputSize((w, h))
    _, facce = rilevatore.detect(im)
    riga = {"file": os.path.basename(percorso)}
    if facce is None or len(facce) == 0:
        riga["esito"] = "nessun volto"
        return riga
    # in un ritratto il soggetto e' il volto piu' grande, non il primo trovato
    volto = max(facce, key=lambda f: f[2] * f[3])
    ritaglio = traduttore.alignCrop(im, volto)
    riga["esito"] = "ok"
    riga["vettore"] = traduttore.feature(ritaglio).flatten().astype(np.float32)
    riga["quota"] = round(float(volto[3]) / h, 3)   # quanto occupa in altezza
    riga["sicurezza"] = round(float(volto[-1]), 3)
    riga["volti"] = len(facce)
    return riga


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--quanti", type=int, default=0, help="solo le prime N foto, per provare")
    p.add_argument("--operai", type=int, default=2)
    a = p.parse_args()

    foto = sorted(glob.glob(LOGHI + "/foto-premium-*.png"))
    if a.quanti:
        foto = foto[:a.quanti]
    print("scontornati da leggere: %d" % len(foto), flush=True)

    os.nice(15)   # le dirette e le grafiche passano sempre davanti
    inizio = time.time()
    righe = []
    with Pool(a.operai) as piscina:
        for i, r in enumerate(piscina.imap_unordered(leggi, foto, chunksize=16), 1):
            righe.append(r)
            if i % 500 == 0:
                print("  %d/%d  (%.0f al secondo)" % (i, len(foto), i / (time.time() - inizio)), flush=True)

    trovati = [r for r in righe if r["esito"] == "ok"]
    os.makedirs(CASA, exist_ok=True)
    if not a.quanti:
        np.save(CASA + "/galleria.npy", np.stack([r["vettore"] for r in trovati]))
        elenco = []
        for r in trovati:
            ruolo, nome, espn = chi_e(r["file"])
            elenco.append({"file": r["file"], "ruolo": ruolo, "nome": nome, "espn": espn,
                           "quota": r["quota"], "sicurezza": r["sicurezza"]})
        json.dump(elenco, open(CASA + "/galleria.json", "w"), ensure_ascii=False)
        print("scritti %s/galleria.npy e galleria.json" % CASA)

    perche = {}
    for r in righe:
        perche[r["esito"]] = perche.get(r["esito"], 0) + 1
    print("\n--- esito su %d foto in %.0f s ---" % (len(righe), time.time() - inizio))
    for k, v in sorted(perche.items(), key=lambda x: -x[1]):
        print("  %-14s %5d  (%.1f%%)" % (k, v, 100.0 * v / len(righe)))
    ruoli = {}
    for r in trovati:
        ruoli[chi_e(r["file"])[0]] = ruoli.get(chi_e(r["file"])[0], 0) + 1
    print("  di cui:", ruoli)
    mancati = [r["file"] for r in righe if r["esito"] != "ok"]
    if mancati:
        print("  esempi non letti:", ", ".join(mancati[:8]))


if __name__ == "__main__":
    main()
