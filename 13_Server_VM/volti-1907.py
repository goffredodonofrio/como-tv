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
  /opt/volti/bin/python volti-1907.py --minuti 30 --prima mirwan-suwarso   # prima i file che lo nominano

Scrive /var/lib/comotv-1907/volti.jsonl: {"v": percorso, "p": [[id, somiglianza, altezza], ...], "f": fotogrammi, "w": 2}
(altezza = quanto e' alto il volto, in frazione del fotogramma: sopra 0.25 e' un primo piano)

I VOLTI SCONOSCIUTI (28/09/2026): un volto grande e nitido che non somiglia a nessuno si
tiene lo stesso: il ritaglio (112x112, allineato) in pub/ignoti/<k>.jpg e l'impronta in
ignoti.jsonl. ignoti-1907.py li raggruppa per somiglianza, la pagina li fa battezzare
(battesimi.json) e da quel momento i volti battezzati entrano nella galleria: la notte
dopo quella persona si riconosce anche nei video nuovi.
"""
import argparse, base64, hashlib, importlib.util, json, os, random, re, subprocess, sys, time, urllib.request

import cv2
import numpy as np

CASA = "/var/lib/comotv-1907"
R = "/mnt/qnap100-frame"
VOLTI = "/var/lib/comotv/volti"
MODELLI = "/opt/volti/modelli"
OUT = os.path.join(CASA, "volti.jsonl")
IGNOTI = os.path.join(CASA, "ignoti.jsonl")
RITAGLI = os.path.join(CASA, "pub", "ignoti")
BATTESIMI = os.path.join(CASA, "battesimi.json")
VERSIONE = 2
LATO = 960
SOGLIA = 0.45          # coseno SFace: OpenCV indica 0.363 per "stessa persona"; qui si sta piu' stretti
STACCO = 0.08          # la seconda persona deve stare almeno cosi' sotto
MIN_ALTEZZA = 0.10     # il volto deve occupare almeno un decimo dell'altezza del fotogramma
PUNTI = (0.2, 0.45, 0.7)
IGNOTO_ALTEZZA = 0.15  # un volto sconosciuto si tiene solo se e' grande...
IGNOTO_NITIDO = 0.9    # ...e se il rivelatore e' sicuro che sia un volto
STESSO = 0.55          # due volti dello stesso file cosi' simili sono la stessa persona: se ne tiene uno
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
    """le impronte delle persone del Como con una foto premium, piu' i volti battezzati a mano:
    una riga per impronta, e accanto l'id della persona (una persona puo' averne piu' d'una)"""
    g = json.load(open(os.path.join(VOLTI, "galleria.json"))); vet = np.load(os.path.join(VOLTI, "galleria.npy"))
    per_file = {x["file"]: i for i, x in enumerate(g)}
    ids, righe = [], []
    for p in META.persone():
        i = per_file.get(p.get("foto") or "")
        if i is not None: ids.append(p["id"]); righe.append(vet[i].astype(np.float32))
    for pid, e in battezzati() + ritratti():
        ids.append(pid); righe.append(e)
    m = np.stack(righe).astype(np.float32)
    m /= np.linalg.norm(m, axis=1, keepdims=True)
    return ids, m


def impronta(e):
    return base64.b64encode(e.astype(np.float16).tobytes()).decode()


def da_impronta(t):
    return np.frombuffer(base64.b64decode(t), dtype=np.float16).astype(np.float32)


def ritratti():
    """[(id persona, impronta)] dalle foto messe a mano in ritratti/ (ritratti-1907.py)"""
    try: r = json.load(open(os.path.join(CASA, "ritratti.json")))
    except Exception: return []
    return [(pid, da_impronta(x["e"])) for pid, x in r.items()]


def battezzati():
    """[(id persona, impronta)] dei volti sconosciuti a cui qualcuno ha dato un nome"""
    try: nomi = json.load(open(BATTESIMI)).get("crop", {})
    except Exception: return []
    fuori = []
    if not nomi: return fuori
    try:
        for r in open(IGNOTI, encoding="utf-8"):
            try: x = json.loads(r)
            except Exception: continue
            pid = nomi.get(x.get("k"))
            if pid and pid != "-": fuori.append((pid, da_impronta(x["e"])))
    except OSError:
        pass
    return fuori


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


def chi_ce(ims, ids, gal, riv, trad, ignoti=None):
    """chi si riconosce: [[id, somiglianza, altezza]]; con ignoti=[] ci mette i volti grandi
    che non somigliano a nessuno: (altezza, impronta, ritaglio)"""
    trovati = {}
    for im in ims:
        h, w = im.shape[:2]
        riv.setInputSize((w, h))
        _, facce = riv.detect(im)
        for f in (facce if facce is not None else []):
            alt = float(f[3] / h)
            if alt < MIN_ALTEZZA: continue
            rit = trad.alignCrop(im, f)
            v = trad.feature(rit).flatten().astype(np.float32)
            v /= np.linalg.norm(v)
            s = gal @ v
            # il migliore per persona (una persona puo' avere piu' impronte)
            per = {}
            for i in np.argsort(-s)[:12]:
                if ids[i] not in per: per[ids[i]] = float(s[i])
            o = sorted(per.items(), key=lambda x: -x[1])
            if o and o[0][1] >= SOGLIA and (len(o) < 2 or o[0][1] - o[1][1] >= STACCO):
                pid, sim = o[0]
                v0 = trovati.get(pid, [0, 0])
                trovati[pid] = [max(v0[0], sim), max(v0[1], alt)]
            elif ignoti is not None and alt >= IGNOTO_ALTEZZA and float(f[14]) >= IGNOTO_NITIDO and frontale(f):
                # lo stesso volto su piu' fotogrammi del file: si tiene il piu' grande
                for j, (a2, e2, r2) in enumerate(ignoti):
                    if float(e2 @ v) >= STESSO:
                        if alt > a2: ignoti[j] = (alt, v, rit)
                        break
                else:
                    ignoti.append((alt, v, rit))
    return sorted(([k, round(x[0], 3), round(x[1], 3)] for k, x in trovati.items()), key=lambda x: -x[1])


def frontale(f):
    """un volto quasi di fronte: il naso sta tra gli occhi, e gli occhi sono ben distanti
    (di profilo l'impronta e' debole e i gruppi si mescolano)"""
    ex1, ex2, nx = float(f[4]), float(f[6]), float(f[8])
    if ex2 - ex1 < 0.25 * float(f[2]): return False
    r = (nx - ex1) / (ex2 - ex1)
    return 0.25 <= r <= 0.75


def salva_ignoti(via, ignoti, out):
    os.makedirs(RITAGLI, exist_ok=True)
    for n, (alt, v, rit) in enumerate(ignoti[:4]):
        k = hashlib.sha1(("%s#%d" % (via, n)).encode()).hexdigest()[:14]
        cv2.imwrite(os.path.join(RITAGLI, k + ".jpg"), rit, [cv2.IMWRITE_JPEG_QUALITY, 82])
        out.write(json.dumps({"k": k, "v": via, "h": round(alt, 3), "e": impronta(v)}) + "\n")
    return min(len(ignoti), 4)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--prova", type=int, default=0)
    a.add_argument("--minuti", type=int, default=0)
    a.add_argument("--prima", default="", help="id di una persona: prima i file che la nominano (dopo un ritratto nuovo)")
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
            nomi = [t[0] for t in trov]  # [id, somiglianza, altezza]
            if not nomi: vuoti += 1; esito = "nessuno"
            elif atteso[0] in nomi and len(nomi) == 1: giusti += 1; esito = "GIUSTO"
            elif atteso[0] in nomi: giusti += 1; esito = "giusto (+ altri)"
            else: sbagliati += 1; esito = "SBAGLIATO"
            print("%-16s atteso %-22s trovato %s | %s" % (esito, atteso[0], trov, v[-70:]), flush=True)
        n = giusti + sbagliati + vuoti
        print("\nsu %d file: %d giusti, %d sbagliati, %d senza volto riconosciuto (%.1f s a file)" % (n, giusti, sbagliati, vuoti, (time.time() - t0) / max(1, n)))
        return

    # fatti: le righe della versione 2 (le prime, senza altezza e senza sconosciuti, si rifanno)
    fatti = set()
    try:
        for r in open(OUT, encoding="utf-8"):
            try: riga = json.loads(r)
            except Exception: continue
            if riga.get("w") == VERSIONE: fatti.add(riga["v"])
    except OSError:
        pass
    # prima i file in cartelle senza nomi, dei tipi dove i volti sono grandi, dalle stagioni recenti
    md = {r[0]: r for r in ind["cartelle"]}
    def priorita(v):
        r = md.get(v.rsplit("/", 1)[0]); m = r[8] if r else {}
        g = set(m.get("g", []))
        if x.prima and (x.prima in m.get("p", []) or x.prima in m.get("pf", [])): return (-1, 0, -(r[1] if r else 0))
        return (0 if not m.get("p") else 1, 0 if g & {"Intervista", "Nuovo acquisto", "Conferenza stampa", "Backstage", "Allenamento"} else 1, -(r[1] if r else 0))
    coda = sorted((v for v in video if v not in fatti), key=priorita)
    fine = time.time() + x.minuti * 60 if x.minuti else None
    print("in coda:", len(coda), "- impronte in galleria:", len(ids), flush=True)
    with open(OUT, "a", encoding="utf-8") as out, open(IGNOTI, "a", encoding="utf-8") as ign:
        for i, v in enumerate(coda):
            if fine and time.time() > fine: break
            while in_diretta(): time.sleep(300)
            ims = fotogrammi(os.path.join(R, v))
            sconosciuti = []
            chi = chi_ce(ims, ids, gal, riv, trad, sconosciuti)
            n = salva_ignoti(v, sconosciuti, ign); ign.flush()
            out.write(json.dumps({"v": v, "p": chi, "f": len(ims), "i": n, "w": VERSIONE}, ensure_ascii=False) + "\n"); out.flush()
            if i % 100 == 99: print(i + 1, "file", flush=True)


if __name__ == "__main__":
    main()
