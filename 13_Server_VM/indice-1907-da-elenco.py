#!/usr/bin/env python3
"""
Costruisce l'indice del MAM Como 1907 dall'elenco veloce (elenco-1907.sh).
(Goffredo, 27/09/2026)

Due file, perche' i file sono ~279.000:
 - pub/indice.json : collezioni ed episodi con i conti (piccolo, si carica subito)
 - pub/file.json   : i file raggruppati per cartella [[cartella, [[nome, byte, data], ...]], ...]
                     (si carica quando si cerca o si apre una cartella; nginx lo comprime)
"""
import json, os, sys, time, collections

CASA = "/var/lib/comotv-1907"
PUB = os.path.join(CASA, "pub")
VIDEO = (".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".webm")
FOTO = (".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff", ".cr2", ".cr3", ".arw", ".nef", ".dng", ".psd")
SCARTA = (".log", ".ds_store", ".xml", ".xmp", ".bim", ".cpi", ".bdm", ".mpl", ".thm", ".ppn", ".ctg", ".lrv", ".ini", ".db")
NASCOSTE = {"COMO TV - THUMBNAILS"}


def tipo(n):
    n = n.lower()
    return "video" if n.endswith(VIDEO) else "foto" if n.endswith(FOTO) else "altro"


def main():
    cartelle = collections.defaultdict(list)
    conta = {}
    def somma(chiave, liv, s, m, t):
        c = conta.setdefault(chiave, {"p": chiave, "liv": liv, "file": 0, "peso": 0, "video": 0, "foto": 0, "ultima": 0})
        c["file"] += 1; c["peso"] += s; c["ultima"] = max(c["ultima"], m)
        if t in ("video", "foto"): c[t] += 1
    # con un argomento si legge un elenco parziale (quello ancora in scrittura): l'indice lo dice
    elenco = sys.argv[1] if len(sys.argv) > 1 else os.path.join(CASA, "elenco.tsv")
    for riga in open(elenco, encoding="utf-8", errors="replace"):
        try: s, m, p = riga.rstrip("\n").split("\t", 2)
        except ValueError: continue
        nome = p.rsplit("/", 1)[-1]
        if nome.lower().endswith(SCARTA) or nome.startswith("."): continue
        parti = p.split("/")
        if parti[0] in NASCOSTE: continue
        s, m = int(s), int(float(m))
        d = "/".join(parti[:-1])
        cartelle[d].append([nome, s, m])
        t = tipo(nome)
        if len(parti) > 1: somma(parti[0], 1, s, m, t)
        if len(parti) > 2: somma(parti[0] + "/" + parti[1], 2, s, m, t)
    if len(sys.argv) > 1:
        # elenco a meta': le cartelle non ancora contate si vedono lo stesso, "in arrivo"
        R = "/mnt/qnap100-frame"
        for c in os.listdir(R):
            if c.startswith((".", "@")) or c in NASCOSTE or not os.path.isdir(os.path.join(R, c)): continue
            conta.setdefault(c, {"p": c, "liv": 1, "file": 0, "peso": 0, "video": 0, "foto": 0, "ultima": 0, "attesa": 1})
            try: eps = os.listdir(os.path.join(R, c))
            except OSError: eps = []
            for e in eps:
                if not e.startswith((".", "@")) and os.path.isdir(os.path.join(R, c, e)):
                    conta.setdefault(c + "/" + e, {"p": c + "/" + e, "liv": 2, "file": 0, "peso": 0, "video": 0, "foto": 0, "ultima": 0, "attesa": 1})
    colls = sorted((c for c in conta.values() if c["liv"] == 1), key=lambda c: -c["ultima"])
    eps = sorted((c for c in conta.values() if c["liv"] == 2), key=lambda c: c["p"].lower())
    tot_file = sum(len(v) for v in cartelle.values()); tot_peso = sum(f[1] for v in cartelle.values() for f in v)
    indice = {"aggiornato": int(time.time()), "file": tot_file, "peso": tot_peso, "collezioni": colls, "episodi": eps}
    if len(sys.argv) > 1: indice["parziale"] = 1
    for nomef, dati in (("indice.json", indice), ("file.json", [[d, sorted(v)] for d, v in sorted(cartelle.items())])):
        tmp = os.path.join(PUB, nomef + ".tmp")
        json.dump(dati, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, os.path.join(PUB, nomef))
    print("indice: %d file, %d collezioni, %d episodi" % (tot_file, len(colls), len(eps)))


if __name__ == "__main__":
    main()
