#!/usr/bin/env python3
"""
IGNOTI-1907 — i volti che nessuno ha ancora riconosciuto, raggruppati per somiglianza.
(Goffredo, 27/09/2026: "i volti sconosciuti da battezzare")

volti-1907.py tiene i volti grandi e nitidi che non somigliano a nessuna persona del Como
con una foto: ritaglio in pub/ignoti/<k>.jpg e impronta in ignoti.jsonl. Qui:
  1. si mettono da parte quelli gia' battezzati o scartati (battesimi.json)
  2. gli altri si raggruppano: un volto entra nel gruppo il cui volto medio gli somiglia
     almeno SOGLIA, se no apre un gruppo nuovo (prima i volti piu' grandi: fanno da capofila)
  3. per ogni gruppo si guarda se somiglia a qualcuno che conosciamo ("forse e' ...")
Scrive pub/ignoti.json: i gruppi dal piu' presente, per la pagina che li fa battezzare.

  /opt/volti/bin/python ignoti-1907.py
"""
import importlib.util, json, os, time

import numpy as np

CASA = "/var/lib/comotv-1907"
IGNOTI = os.path.join(CASA, "ignoti.jsonl")
BATTESIMI = os.path.join(CASA, "battesimi.json")
OUT = os.path.join(CASA, "pub", "ignoti.json")
SOGLIA = 0.50        # stessa persona (SFace dice 0.363: qui piu' stretti, meglio due gruppi che uno misto)
FORSE = 0.42         # "forse e' ...": somiglia a una persona conosciuta...
FORSE_STACCO = 0.06  # ...e parecchio meno alla seconda
MAX_SOLI = 400       # i gruppi di un file solo sono tanti: se ne mostrano i piu' grandi

spec = importlib.util.spec_from_file_location("volti", "/opt/comotv/volti-1907.py")
V = importlib.util.module_from_spec(spec); spec.loader.exec_module(V)


def main():
    try: nomi = json.load(open(BATTESIMI)).get("crop", {})
    except Exception: nomi = {}
    righe = {}
    try:
        for r in open(IGNOTI, encoding="utf-8"):
            try: x = json.loads(r)
            except Exception: continue
            righe[x["k"]] = x
    except OSError:
        pass
    liberi = [x for k, x in righe.items() if k not in nomi and os.path.exists(os.path.join(CASA, "pub", "ignoti", k + ".jpg"))]
    liberi.sort(key=lambda x: -x["h"])
    if not liberi:
        json.dump({"aggiornato": int(time.time()), "gruppi": [], "battezzati": len(nomi)}, open(OUT, "w")); print("nessun volto da battezzare"); return
    E = np.stack([V.da_impronta(x["e"]) for x in liberi]); E /= np.linalg.norm(E, axis=1, keepdims=True)
    somme = np.zeros((len(liberi), E.shape[1]), np.float32); cap = np.zeros((len(liberi), E.shape[1]), np.float32)
    membri = []
    for i in range(len(liberi)):
        m = len(membri)
        if m:
            s = cap[:m] @ E[i]; j = int(np.argmax(s))
            if s[j] >= SOGLIA:
                membri[j].append(i); somme[j] += E[i]; cap[j] = somme[j] / np.linalg.norm(somme[j]); continue
        membri.append([i]); somme[m] = E[i]; cap[m] = E[i]
    # chi conosciamo: la galleria del Como piu' i battezzati
    ids, gal = V.galleria_como()
    gruppi = []
    for j, mm in enumerate(membri):
        xs = [liberi[i] for i in mm]
        vie = sorted(set(x["v"] for x in xs))
        g = {"id": xs[0]["k"], "k": [x["k"] for x in xs], "vie": vie, "h": max(x["h"] for x in xs)}
        s = gal @ cap[j]; per = {}
        for i in np.argsort(-s)[:12]:
            if ids[i] not in per: per[ids[i]] = float(s[i])
        o = sorted(per.items(), key=lambda x: -x[1])
        if o and o[0][1] >= FORSE and (len(o) < 2 or o[0][1] - o[1][1] >= FORSE_STACCO): g["forse"] = [o[0][0], round(o[0][1], 3)]
        gruppi.append(g)
    gruppi.sort(key=lambda g: (-len(g["vie"]), -len(g["k"]), -g["h"]))
    tanti = [g for g in gruppi if len(g["vie"]) > 1]
    soli = [g for g in gruppi if len(g["vie"]) == 1][:MAX_SOLI]
    fuori = {"aggiornato": int(time.time()), "volti": len(liberi), "gruppi": tanti + soli, "altri": len(gruppi) - len(tanti) - len(soli),
             "battezzati": sum(1 for v in nomi.values() if v != "-")}
    tmp = OUT + ".tmp"; json.dump(fuori, open(tmp, "w"), ensure_ascii=False, separators=(",", ":")); os.replace(tmp, OUT)
    print("volti da battezzare: %d in %d gruppi (%d in piu' video)" % (len(liberi), len(gruppi), len(tanti)))


if __name__ == "__main__":
    main()
