#!/usr/bin/env python3
"""
VOLTI-1907 — chi si vede nel materiale del club. (Goffredo, 27/09/2026: "mi interessa moltissimo")

Tanti file del FRAME si chiamano C0001.MP4 in una cartella "Cam A": il nome non dice
chi c'e'. Qui si guarda il video: da qualche fotogramma si trovano i volti (YuNet) e
si confrontano (SFace) con la galleria degli scontornati premium, ma SOLO con le
persone del Como che hanno una foto (una trentina, non settemila: e' quello che lo
fa girare su due core, come per i primi piani del MAM di Como TV).

Un volto vale se e' abbastanza grande (un primo piano o quasi), se somiglia molto a
una persona e se la seconda e' parecchio piu' lontana. Meglio perdere un volto che
dare un nome sbagliato.

  /opt/volti/bin/python volti-1907.py --prova 60      # misura su file di cui il nome gia' dice chi c'e'
  /opt/volti/bin/python volti-1907.py --minuti 120    # lavora due ore (di notte), dai file senza nomi

Scrive /var/lib/comotv-1907/volti.jsonl: {"v": percorso, "p": [[id, somiglianza], ...], "f": fotogrammi}
"""
import argparse, importlib.util, json, os, random, re, subprocess, sys, time, urllib.request

import cv2
import numpy as np

CASA = "/var/lib/comotv-1907"
R = "/mnt/qnap100-frame"
VOLTI = "/var/lib/comotv/volti"
MODELLI = "/opt/volti/modelli"
OUT = os.path.join(CASA, "volti.jsonl")
LATO = 960
SOGLIA = 0.45          # coseno SFace: OpenCV indica 0.363 per "stessa persona"; qui si sta piu' stretti
STACCO = 0.08          # la seconda persona deve stare almeno cosi' sotto
MIN_ALTEZZA = 0.10     # il volto deve occupare almeno un decimo dell'altezza del fotogramma
PUNTI = (0.2, 0.45, 0.7)
# cartelle dove di solito c'e' un volto grande: per la prova
DA_PRIMO_PIANO = re.compile(r"interview|itw|intw|get to know|signing|new player|press|media day|soundbite|welcome|presentazione", re.I)

spec = importlib.util.spec_from_file_location("meta", "/opt/comotv/metadati_1907.py")
META = importlib.util.module_from_spec(spec); spec.loader.exec_module(META)


def in_diretta():
    try:
        req = urllib.request.Request("http://127.0.0.1:8080/api", data=json.dumps({"tipo": "clip-stato"}).encode(), headers={"Content-Type": "text/plain"})
        return any(r.get("stato") == "registra" and not r.get("guarda") for r in json.load(urllib.request.urlopen(req, timeout=8)).get("reg", []))
    except Exception:
        return False


def galleria_como():
    """le impronte delle persone del Como con una foto premium"""
    g = json.load(open(os.path.join(VOLTI, "galleria.json"))); vet = np.load(os.path.join(VOLTI, "galleria.npy"))
    per_file = {x["file"]: i for i, x in enumerate(g)}
    ids, righe = [], []
    for p in META.persone():
        i = per_file.get(p.get("foto") or "")
        if i is not None: ids.append(p["id"]); righe.append(vet[i])
    m = np.stack(righe).astype(np.float32)
    m /= np.linalg.norm(m, axis=1, keepdims=True)
    return ids, m


def fotogrammi(pieno):
    try:
        d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", pieno],
                                 capture_output=True, text=True, timeout=60).stdout.strip() or 0)
    except Exception:
        d = 0
    fuori = []
    for f in (PUNTI if d > 3 else (0.5,)):
        try:
            b = subprocess.run(["nice", "-n", "15", "ffmpeg", "-v", "error", "-nostdin", "-skip_frame", "nokey", "-ss", "%.2f" % (d * f), "-i", pieno,
                                "-frames:v", "1", "-vf", "scale=%d:-2" % LATO, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-"],
                               capture_output=True, timeout=90).stdout
            im = cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR) if b else None
            if im is not None: fuori.append(im)
        except Exception:
            pass
    return fuori


def chi_ce(ims, ids, gal, riv, trad):
    trovati = {}
    for im in ims:
        h, w = im.shape[:2]
        riv.setInputSize((w, h))
        _, facce = riv.detect(im)
        for f in (facce if facce is not None else []):
            if f[3] / h < MIN_ALTEZZA: continue
            v = trad.feature(trad.alignCrop(im, f)).flatten().astype(np.float32)
            v /= np.linalg.norm(v)
            s = gal @ v
            o = np.argsort(-s)
            if s[o[0]] >= SOGLIA and (len(o) < 2 or s[o[0]] - s[o[1]] >= STACCO):
                pid = ids[o[0]]; trovati[pid] = max(trovati.get(pid, 0), float(s[o[0]]))
    return sorted(([k, round(v, 3)] for k, v in trovati.items()), key=lambda x: -x[1])


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--prova", type=int, default=0)
    a.add_argument("--minuti", type=int, default=0)
    x = a.parse_args()
    os.nice(15)
    ids, gal = galleria_como()
    print("persone del Como riconoscibili:", len(ids), flush=True)
    riv = cv2.FaceDetectorYN.create(MODELLI + "/yunet.onnx", "", (LATO, LATO), 0.7, 0.3, 5000)
    trad = cv2.FaceRecognizerSF.create(MODELLI + "/sface.onnx", "")
    ind = json.load(open(os.path.join(CASA, "pub", "indice.json")))
    video = []
    for riga in open(os.path.join(CASA, "elenco.tsv"), encoding="utf-8", errors="replace"):
        try: s, m, p = riga.rstrip("\n").split("\t", 2)
        except ValueError: continue
        if p.lower().endswith((".mp4", ".mov", ".mxf", ".m4v", ".mts")) and "prox" not in p.lower() and int(s) > 5e6: video.append(p)

    if x.prova:
        # file di cui il percorso gia' dice chi c'e', tra le persone riconoscibili, in cartelle da primo piano
        ric = META.Riconosci([p for p in META.persone() if p["id"] in ids])
        cand = [(v, ric.persone(v)) for v in video if DA_PRIMO_PIANO.search(v)]
        cand = [c for c in cand if len(c[1]) == 1]
        random.seed(7); random.shuffle(cand)
        giusti = sbagliati = vuoti = 0; t0 = time.time()
        for v, atteso in cand[:x.prova]:
            trov = chi_ce(fotogrammi(os.path.join(R, v)), ids, gal, riv, trad)
            nomi = [t[0] for t in trov]
            if not nomi: vuoti += 1; esito = "nessuno"
            elif atteso[0] in nomi and len(nomi) == 1: giusti += 1; esito = "GIUSTO"
            elif atteso[0] in nomi: giusti += 1; esito = "giusto (+ altri)"
            else: sbagliati += 1; esito = "SBAGLIATO"
            print("%-16s atteso %-22s trovato %s | %s" % (esito, atteso[0], trov, v[-70:]), flush=True)
        n = giusti + sbagliati + vuoti
        print("\nsu %d file: %d giusti, %d sbagliati, %d senza volto riconosciuto (%.1f s a file)" % (n, giusti, sbagliati, vuoti, (time.time() - t0) / max(1, n)))
        return

    fatti = set()
    try:
        for r in open(OUT, encoding="utf-8"): fatti.add(json.loads(r)["v"])
    except OSError:
        pass
    # prima i file in cartelle senza nomi, dei tipi dove i volti sono grandi, dalle stagioni recenti
    md = {r[0]: r for r in ind["cartelle"]}
    def priorita(v):
        r = md.get(v.rsplit("/", 1)[0]); m = r[8] if r else {}
        g = set(m.get("g", []))
        return (0 if not m.get("p") else 1, 0 if g & {"Intervista", "Nuovo acquisto", "Conferenza stampa", "Backstage", "Allenamento"} else 1, -(r[1] if r else 0))
    coda = sorted((v for v in video if v not in fatti), key=priorita)
    fine = time.time() + x.minuti * 60 if x.minuti else None
    print("in coda:", len(coda), flush=True)
    with open(OUT, "a", encoding="utf-8") as out:
        for i, v in enumerate(coda):
            if fine and time.time() > fine: break
            while in_diretta(): time.sleep(300)
            ims = fotogrammi(os.path.join(R, v))
            out.write(json.dumps({"v": v, "p": chi_ce(ims, ids, gal, riv, trad), "f": len(ims)}, ensure_ascii=False) + "\n"); out.flush()
            if i % 100 == 99: print(i + 1, "file", flush=True)


if __name__ == "__main__":
    main()
