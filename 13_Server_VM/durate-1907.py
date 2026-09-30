#!/usr/bin/env python3
"""LE DURATE DEI VIDEO DEL FRAME (Goffredo, 30/09/2026: "riesco a mettere un filtro 3 / 5 minuti di durata")

Per ogni video dell'elenco (elenco.tsv) la durata in secondi:
  - MP4/MOV/M4V: dall'intestazione (blocco moov > mvhd: durata / scala dei tempi), pochi byte letti;
  - gli altri (MXF, MTS, AVI, MKV...) e l'audio (WAV, MP3...): ffprobe, con un tempo massimo.
Si rimisura solo quello che e' nuovo o cambiato (cache durate.json: via -> [byte, mtime, secondi]).
Uscita: pub/durate.json {cartella: {nome: secondi}}; la pagina la usa per il filtro Durata.

  nice -n 15 ionice -c3 python3 durate-1907.py
"""
import json, os, struct, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

R = "/mnt/qnap100-frame"
CASA = "/var/lib/comotv-1907"
ELENCO = os.path.join(CASA, "elenco.tsv")
CACHE = os.path.join(CASA, "durate.json")
USCITA = os.path.join(CASA, "pub", "durate.json")
QT = (".mp4", ".mov", ".m4v")
LOCK = threading.Lock()   # i fili scrivono nella cache mentre ogni tanto la si salva
ALTRI = (".mxf", ".mts", ".m2ts", ".avi", ".mkv", ".webm", ".wav", ".mp3", ".m4a", ".aac", ".aif", ".aiff")


def durata_qt(p, dim):
    with open(p, "rb") as f:
        pos = 0
        while pos + 8 <= dim:
            f.seek(pos); h = f.read(8)
            if len(h) < 8: return None
            size, tipo = struct.unpack(">I4s", h); hl = 8
            if size == 1: size = struct.unpack(">Q", f.read(8))[0]; hl = 16
            elif size == 0: size = dim - pos
            if size < 8: return None
            if tipo == b"moov":
                q, fine = pos + hl, pos + size
                while q + 8 <= fine:
                    f.seek(q); h2 = f.read(8)
                    s2, t2 = struct.unpack(">I4s", h2)
                    if s2 < 8: return None
                    if t2 == b"mvhd":
                        b = f.read(32); ver = b[0]
                        if ver == 1: ts, du = struct.unpack(">IQ", b[20:32])
                        else: ts, du = struct.unpack(">II", b[12:20])
                        return round(du / ts, 2) if ts else None
                    q += s2
                return None
            pos += size
    return None


def durata_ff(p):
    try:
        o = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", p], capture_output=True, timeout=40)
        return round(float(o.stdout.decode().strip()), 2)
    except Exception:
        return None


def main():
    righe = []
    for r in open(ELENCO, encoding="utf-8", errors="surrogateescape"):
        t = r.rstrip("\n").split("\t", 2)
        if len(t) == 3 and t[2].lower().endswith(QT + ALTRI) and not t[2].rsplit("/", 1)[-1].startswith("."):
            try: righe.append((int(t[0]), int(float(t[1])), t[2]))
            except ValueError: pass
    try: cache = json.load(open(CACHE))
    except (OSError, ValueError): cache = {}
    da_fare = [x for x in righe if x[0] > 0 and (cache.get(x[2]) or [None, None])[:2] != [x[0], x[1]]]
    print("video e audio %d, da misurare %d" % (len(righe), len(da_fare)), flush=True)
    t0 = time.time()

    def uno(x):
        dim, mt, via = x; p = os.path.join(R, via)
        try: d = durata_qt(p, dim) if via.lower().endswith(QT) else durata_ff(p)
        except Exception: d = None
        if d is None and via.lower().endswith(QT): d = durata_ff(p)
        with LOCK: cache[via] = [dim, mt, d]

    with ThreadPoolExecutor(8) as ex:
        for i, _ in enumerate(ex.map(uno, da_fare)):
            if i and i % 5000 == 0:
                with LOCK: copia = dict(cache)
                json.dump(copia, open(CACHE + ".tmp", "w"), ensure_ascii=False); os.replace(CACHE + ".tmp", CACHE)
                print("%d/%d in %d s" % (i, len(da_fare), time.time() - t0), flush=True)
    vive = {x[2] for x in righe}
    cache = {k: v for k, v in cache.items() if k in vive}
    json.dump(cache, open(CACHE + ".tmp", "w"), ensure_ascii=False); os.replace(CACHE + ".tmp", CACHE)
    out = {}
    for via, (dim, mt, d) in cache.items():
        if d is None or d <= 0: continue
        c, n = via.rsplit("/", 1) if "/" in via else ("", via)
        out.setdefault(c, {})[n] = int(round(d))
    json.dump(out, open(USCITA + ".tmp", "w"), ensure_ascii=False, separators=(",", ":")); os.replace(USCITA + ".tmp", USCITA)
    subprocess.run(["gzip", "-kf", USCITA])
    print("durate: %d video misurati, %d senza durata, in %d s" % (sum(len(v) for v in out.values()), sum(1 for v in cache.values() if not v[2]), time.time() - t0), flush=True)


if __name__ == "__main__":
    sys.exit(main())
