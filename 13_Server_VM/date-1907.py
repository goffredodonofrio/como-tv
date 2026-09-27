#!/usr/bin/env python3
"""
DATE-1907 — la data delle riprese dall'orologio delle camere.
(Goffredo, 27/09/2026)

Sulla NAS i file hanno tutti la data della copia (estate 2026). Le camere
invece scrivono dentro il file quando hanno girato (creation_time): si legge
con ffprobe, che apre solo la testa del file. Una cartella di ripresa e'
quasi sempre una giornata: basta il primo e l'ultimo video (per nome) a dire
[prima, ultima]. Si fa solo per le cartelle che non hanno gia' la data nel
nome. Scrive /var/lib/comotv-1907/date-1907.json ogni 50 cartelle, riparte da
dove era arrivato, si ferma durante le dirette. Legge soltanto.
"""
import importlib.util, json, os, subprocess, time, urllib.request

CASA = "/var/lib/comotv-1907"
R = "/mnt/qnap100-frame"
OUT = os.path.join(CASA, "date-1907.json")
spec = importlib.util.spec_from_file_location("ind", "/opt/comotv/indice-1907-da-elenco.py")
ind = importlib.util.module_from_spec(spec); spec.loader.exec_module(ind)


def in_diretta():
    try:
        req = urllib.request.Request("http://127.0.0.1:8080/api", data=json.dumps({"tipo": "clip-stato"}).encode(), headers={"Content-Type": "text/plain"})
        return any(r.get("stato") == "registra" and not r.get("guarda") for r in json.load(urllib.request.urlopen(req, timeout=8)).get("reg", []))
    except Exception:
        return False


def quando(f):
    try:
        o = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags=creation_time:stream_tags=creation_time",
                                       "-of", "json", os.path.join(R, f)], capture_output=True, text=True, timeout=60).stdout or "{}")
    except Exception:
        return 0
    t = (o.get("format", {}).get("tags", {}) or {}).get("creation_time") or \
        next((s.get("tags", {}).get("creation_time") for s in o.get("streams", []) if s.get("tags", {}).get("creation_time")), "")
    if not t or t.startswith(("1970", "1904", "2000-01-01")): return 0
    try: return ind.valida(int(t[0:4]), int(t[5:7]), int(t[8:10]))
    except ValueError: return 0


def main():
    try: fatto = json.load(open(OUT))
    except Exception: fatto = {}
    per = {}
    for riga in open(os.path.join(CASA, "elenco.tsv"), encoding="utf-8", errors="replace"):
        try: s, m, p = riga.rstrip("\n").split("\t", 2)
        except ValueError: continue
        if not p.lower().endswith(ind.VIDEO) or p.startswith("COMO TV - THUMBNAILS/"): continue
        d, n = p.rsplit("/", 1) if "/" in p else ("", p)
        if n.startswith("."): continue
        per.setdefault(d, []).append(n)
    da_fare = [d for d in sorted(per) if d not in fatto and not any(ind.data_in(x) for x in d.split("/"))]
    print("cartelle da datare:", len(da_fare), "gia' fatte:", len(fatto), flush=True)
    for i, d in enumerate(da_fare):
        while in_diretta(): time.sleep(300)
        fs = sorted(per[d])
        a = quando(d + "/" + fs[0]); b = quando(d + "/" + fs[-1]) if len(fs) > 1 else a
        vv = sorted(x for x in (a, b) if x)
        fatto[d] = [vv[0], vv[-1]] if vv else [0, 0]
        if i % 50 == 49 or i == len(da_fare) - 1:
            json.dump(fatto, open(OUT + ".tmp", "w"), ensure_ascii=False, separators=(",", ":")); os.replace(OUT + ".tmp", OUT)
            print(i + 1, "/", len(da_fare), flush=True)
    json.dump(fatto, open(OUT + ".tmp", "w"), ensure_ascii=False, separators=(",", ":")); os.replace(OUT + ".tmp", OUT)


if __name__ == "__main__":
    main()
