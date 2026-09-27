#!/usr/bin/env python3
"""
TECNICA-1907 — durata, misura e formato di ogni video del FRAME.
(Goffredo, 27/09/2026: ricerche per montatori, social e redazione)

Per ogni video si legge solo la testa del file (ffprobe): durata, larghezza e
altezza (con la rotazione dei telefoni: un video girato in verticale e' spesso
"orizzontale ruotato"), codec, profondita' di colore, fotogrammi al secondo.
Serve a cercare "verticali sotto i 30 secondi", "4K", "clip lunghe".

Scrive una riga per file in /var/lib/comotv-1907/tecnica.jsonl
  {"v": percorso, "d": durata, "w": largh, "h": alt, "c": codec, "b": bit, "f": fps}
e riparte da dove era arrivato. Prima le stagioni piu' recenti. Due letture
alla volta, a priorita' minima, ferma durante le dirette. Legge soltanto.
"""
import json, os, subprocess, threading, time, urllib.request

CASA = "/var/lib/comotv-1907"
R = "/mnt/qnap100-frame"
OUT = os.path.join(CASA, "tecnica.jsonl")
VIDEO = (".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".webm")
LOCK = threading.Lock()


def in_diretta():
    try:
        req = urllib.request.Request("http://127.0.0.1:8080/api", data=json.dumps({"tipo": "clip-stato"}).encode(), headers={"Content-Type": "text/plain"})
        return any(r.get("stato") == "registra" and not r.get("guarda") for r in json.load(urllib.request.urlopen(req, timeout=8)).get("reg", []))
    except Exception:
        return False


def leggi(via):
    try:
        o = json.loads(subprocess.run(["nice", "-n", "19", "ionice", "-c3", "ffprobe", "-v", "error", "-select_streams", "v:0",
                                       "-show_entries", "stream=width,height,codec_name,pix_fmt,r_frame_rate:stream_tags=rotate:stream_side_data=rotation:format=duration",
                                       "-of", "json", os.path.join(R, via)], capture_output=True, text=True, timeout=90).stdout or "{}")
    except Exception:
        return {"v": via, "e": 1}
    s = (o.get("streams") or [{}])[0]
    w, h = int(s.get("width") or 0), int(s.get("height") or 0)
    rot = 0
    try: rot = int((s.get("tags") or {}).get("rotate") or 0)
    except ValueError: pass
    for sd in s.get("side_data_list") or []:
        try: rot = int(sd.get("rotation") or rot)
        except (TypeError, ValueError): pass
    if abs(rot) % 180 == 90: w, h = h, w
    pf = s.get("pix_fmt") or ""
    fps = 0
    try:
        a, b = (s.get("r_frame_rate") or "0/1").split("/"); fps = round(int(a) / max(1, int(b)), 2)
    except ValueError: pass
    return {"v": via, "d": round(float((o.get("format") or {}).get("duration") or 0), 2), "w": w, "h": h, "c": s.get("codec_name") or "",
            "b": 12 if "12" in pf else 10 if "10" in pf else 8 if pf else 0, "f": fps}


def main():
    fatti = set()
    try:
        for riga in open(OUT, encoding="utf-8"):
            try: fatti.add(json.loads(riga)["v"])
            except Exception: pass
    except OSError:
        pass
    # prima le cartelle piu' recenti (la data vera dall'indice), poi il resto
    try: data = {r[0]: r[1] or 0 for r in json.load(open(os.path.join(CASA, "pub", "indice.json")))["cartelle"]}
    except Exception: data = {}
    vie = []
    for riga in open(os.path.join(CASA, "elenco.tsv"), encoding="utf-8", errors="replace"):
        try: s, m, p = riga.rstrip("\n").split("\t", 2)
        except ValueError: continue
        n = p.rsplit("/", 1)[-1]
        if n.startswith(".") or not n.lower().endswith(VIDEO) or p in fatti: continue
        vie.append(p)
    vie.sort(key=lambda p: -data.get(p.rsplit("/", 1)[0], 0))
    print("da leggere:", len(vie), "gia' letti:", len(fatti), flush=True)
    coda = list(reversed(vie)); fatti_ora = [0]
    out = open(OUT, "a", encoding="utf-8")

    def lavora():
        while True:
            with LOCK:
                if not coda: return
                via = coda.pop()
            while in_diretta(): time.sleep(300)
            x = leggi(via)
            with LOCK:
                out.write(json.dumps(x, ensure_ascii=False) + "\n"); fatti_ora[0] += 1
                if fatti_ora[0] % 500 == 0:
                    out.flush(); print(fatti_ora[0], "/", len(vie), flush=True)

    t = [threading.Thread(target=lavora) for _ in range(2)]
    for x in t: x.start()
    for x in t: x.join()
    out.close()
    print("finito:", fatti_ora[0], flush=True)


if __name__ == "__main__":
    main()
