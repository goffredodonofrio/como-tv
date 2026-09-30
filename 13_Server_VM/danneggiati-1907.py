#!/usr/bin/env python3
"""I VIDEO DANNEGGIATI DEL FRAME (30/09/2026)

Nel debug del MAM Como 1907 alcune miniature non si facevano: i file erano MP4/MOV troncati
("moov atom not found"), download da Frame non finiti. Nessun programma li apre cosi' come sono.

Qui si controllano tutti gli MP4/MOV/M4V dell'elenco (elenco.tsv) leggendo SOLO le intestazioni dei
blocchi (8-16 byte per blocco, con dei salti): niente decodifica, niente file letti per intero.
Un file e' danneggiato se un blocco dichiara di finire oltre la fine del file, o se manca il blocco
"moov" (l'indice del video). Uscita: pub/danneggiati.json {via: motivo}; lo usano l'indice (per non
sceglierli come copertina) e la pagina (per dirlo).

  nice -n 15 ionice -c3 python3 danneggiati-1907.py
"""
import json, os, struct, sys, time

R = "/mnt/qnap100-frame"
CASA = "/var/lib/comotv-1907"
ELENCO = os.path.join(CASA, "elenco.tsv")
USCITA = os.path.join(CASA, "pub", "danneggiati.json")
QT = (".mp4", ".mov", ".m4v")


def controlla(p, dim):
    """None se il file sta in piedi, altrimenti il motivo"""
    try:
        with open(p, "rb") as f:
            pos, visti = 0, set()
            while pos < dim:
                f.seek(pos)
                h = f.read(8)
                if len(h) < 8: return "intestazione tronca"
                size, tipo = struct.unpack(">I4s", h)
                if size == 1:
                    e = f.read(8)
                    if len(e) < 8: return "intestazione tronca"
                    size = struct.unpack(">Q", e)[0]
                elif size == 0:
                    size = dim - pos
                if size < 8: return "blocco non valido"
                visti.add(tipo)
                if pos + size > dim:
                    return "troncato" if tipo == b"mdat" and b"moov" not in visti else "blocco oltre la fine"
                pos += size
            if b"moov" not in visti: return "manca l'indice del video (moov)"
            return None
    except OSError as e:
        return "non si legge: %s" % (e.strerror or e)


def main():
    righe = []
    for r in open(ELENCO, encoding="utf-8", errors="surrogateescape"):
        t = r.rstrip("\n").split("\t", 2)
        if len(t) == 3 and t[2].lower().endswith(QT):
            try: righe.append((int(t[0]), t[2]))
            except ValueError: pass
    fuori, t0 = {}, time.time()
    for i, (dim, via) in enumerate(righe):
        if dim == 0: fuori[via] = "vuoto (0 byte)"; continue
        m = controlla(os.path.join(R, via), dim)
        if m: fuori[via] = m
        if i % 5000 == 0: print("%d/%d, danneggiati finora %d" % (i, len(righe), len(fuori)), flush=True)
    tmp = USCITA + ".tmp"
    json.dump({"aggiornato": int(time.time()), "controllati": len(righe), "danneggiati": fuori}, open(tmp, "w"), ensure_ascii=False)
    os.replace(tmp, USCITA)
    print("controllati %d video in %d s: danneggiati %d" % (len(righe), time.time() - t0, len(fuori)))


if __name__ == "__main__":
    sys.exit(main())
