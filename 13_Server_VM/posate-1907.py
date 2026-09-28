#!/usr/bin/env python3
"""
POSATE-1907 — le foto posate (scontornati premium, ritratti messi a mano) ridotte alla faccia.
(Goffredo, 28/09/2026: "qui mi metti le foto posate se le hai?")

Gli scontornati sono PNG a mezzo busto da ~1,4 MB: in un cerchio da 60 px la faccia sparisce e
trenta foto pesano 40 MB. Qui si trova il volto (YuNet) e si ritaglia un quadrato attorno alla
testa, su fondo scuro, 192 px: pub/posate/<id persona>.jpg, una decina di KB.
Si rifanno solo quelle nuove o cambiate. Le usa la pagina (parete dei volti, gettoni, schede).

  /opt/volti/bin/python posate-1907.py
"""
import glob, importlib.util, json, os, re

import cv2
import numpy as np

CASA = "/var/lib/comotv-1907"
OUT = os.path.join(CASA, "pub", "posate")
MODELLI = "/opt/volti/modelli"
LATO = 192
FONDO = (0x3a, 0x2f, 0x2c)   # #2c2f3a, lo stesso dei cerchi vuoti della pagina (BGR)

sp = importlib.util.spec_from_file_location("meta", "/opt/comotv/metadati_1907.py"); META = importlib.util.module_from_spec(sp); sp.loader.exec_module(META)


def carica(f):
    im = cv2.imread(f, cv2.IMREAD_UNCHANGED)
    if im is None: return None
    if im.ndim == 2: im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
    if im.shape[2] == 4:   # scontornato: si appoggia sul fondo scuro
        a = im[:, :, 3:4].astype(np.float32) / 255
        im = (im[:, :, :3].astype(np.float32) * a + np.array(FONDO, np.float32) * (1 - a)).astype(np.uint8)
    return im


def inquadra(im, f, dest):
    """un quadrato attorno alla testa (il volto f), su fondo scuro, 192 px"""
    h, w = im.shape[:2]
    cx, cy, lato = f[0] + f[2] / 2, f[1] + f[3] * 0.42, max(f[2], f[3]) * 2.0
    x0, y0 = int(cx - lato / 2), int(cy - lato / 2); x1, y1 = int(x0 + lato), int(y0 + lato)
    tela = np.full((y1 - y0, x1 - x0, 3), FONDO, np.uint8)
    ax0, ay0, ax1, ay1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    tela[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = im[ay0:ay1, ax0:ax1]
    cv2.imwrite(dest, cv2.resize(tela, (LATO, LATO), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 86])


def suoi_video(pid):
    """i video dove si e' riconosciuto il suo volto (dal piu' grande) e quelli dei volti battezzati per lui"""
    ultime = {}
    try:
        for r in open(os.path.join(CASA, "volti.jsonl"), encoding="utf-8"):
            try: x = json.loads(r); ultime[x["v"]] = x
            except Exception: pass
    except OSError:
        pass
    vv = sorted(((p[2] if len(p) > 2 else 0, v) for v, x in ultime.items() for p in x.get("p", []) if p[0] == pid), reverse=True)
    try: nomi = json.load(open(os.path.join(CASA, "battesimi.json"))).get("crop", {})
    except Exception: nomi = {}
    try:
        for r in open(os.path.join(CASA, "ignoti.jsonl"), encoding="utf-8"):
            try: x = json.loads(r)
            except Exception: continue
            if nomi.get(x.get("k")) == pid: vv.append((x.get("h", 0), x["v"]))
    except OSError:
        pass
    vv.sort(reverse=True)
    fuori = []
    for _, v in vv:
        if v not in fuori: fuori.append(v)
    # piu' i video che lo nominano da solo (cartella o nome del file), prima interviste e discorsi:
    # il confronto col suo volto dice poi se c'e' davvero
    try:
        ind = json.load(open(os.path.join(CASA, "pub", "indice.json")))
        fpc = {d: [f[0] for f in fs] for d, fs in json.load(open(os.path.join(CASA, "pub", "file.json")))}
        nominati = []
        for r in ind["cartelle"]:
            md = r[8] or {}
            if pid in md.get("p", []) and len(md["p"]) == 1 or pid in md.get("pf", []):
                nominati += [r[0] + "/" + f for f in fpc.get(r[0], []) if f.lower().endswith((".mp4", ".mov", ".mxf", ".m4v", ".mts")) and "prox" not in f.lower()]
        nominati.sort(key=lambda v: (0 if re.search(r"interv|itw|speech|discorso|conferenz|press|soundbite", v, re.I) else 1, v))
        for v in nominati:
            if v not in fuori: fuori.append(v)
    except Exception:
        pass
    return fuori[:10]


def dai_video(p, V, ids, gal, riv, trad, dest):
    """chi non ha una foto posata: il fotogramma dei nostri video dove il suo volto e' piu' grande
    e di fronte, verificato con le sue impronte (galleria, ritratti, volti battezzati)"""
    righe = [i for i, x in enumerate(ids) if x == p["id"]]
    if not righe: return False
    rif = gal[righe]
    best = None
    for v in suoi_video(p["id"]):
        for im in V.fotogrammi(os.path.join(V.R, v)):
            h, w = im.shape[:2]; riv.setInputSize((w, h)); _, ff = riv.detect(im)
            tutte = ff if ff is not None else []
            for i, f in enumerate(tutte):
                if f[3] / h < 0.12 or not V.frontale(f): continue
                # nessun'altra faccia dentro il riquadro della testa: la miniatura e' di uno solo
                lato = max(f[2], f[3]) * 2.0; cx, cy = f[0] + f[2] / 2, f[1] + f[3] * 0.42
                if any(j != i and abs(g[0] + g[2] / 2 - cx) < lato / 2 and abs(g[1] + g[3] / 2 - cy) < lato / 2 for j, g in enumerate(tutte)): continue
                e = trad.feature(trad.alignCrop(im, f)).flatten().astype(np.float32); e /= np.linalg.norm(e)
                if float((rif @ e).max()) < 0.5: continue
                if not best or f[3] > best[1][3]: best = (im, f)
    if not best: return False
    inquadra(best[0], best[1], dest)
    return True


def main():
    os.makedirs(OUT, exist_ok=True)
    riv = cv2.FaceDetectorYN.create(MODELLI + "/yunet.onnx", "", (640, 640), 0.6, 0.3, 50)
    fatte = saltate = dv = 0
    senza = []
    for p in META.persone():
        src = os.path.join(META.FOTO_DIR, p["foto"]) if p.get("foto") else ""
        if not src or not os.path.exists(src):
            mani = glob.glob(os.path.join(CASA, "ritratti", p["id"] + ".*"))
            src = mani[0] if mani else ""
        dest = os.path.join(OUT, p["id"] + ".jpg")
        if not src:
            if not os.path.exists(dest): senza.append(p)
            continue
        if os.path.exists(dest) and os.path.getmtime(dest) >= os.path.getmtime(src): continue
        im = carica(src)
        if im is None: saltate += 1; continue
        h, w = im.shape[:2]; r = min(1.0, 1200 / max(h, w))
        pic = cv2.resize(im, (int(w * r), int(h * r))) if r < 1 else im
        riv.setInputSize((pic.shape[1], pic.shape[0])); _, ff = riv.detect(pic)
        if ff is None or not len(ff): saltate += 1; continue
        inquadra(im, max(ff, key=lambda x: x[2] * x[3]) / r, dest)
        fatte += 1
    # chi non ha foto: dal fotogramma migliore dei nostri video (una volta sola)
    if senza:
        sp2 = importlib.util.spec_from_file_location("volti", "/opt/comotv/volti-1907.py"); V = importlib.util.module_from_spec(sp2); sp2.loader.exec_module(V)
        ids, gal = V.galleria_como()
        rv = cv2.FaceDetectorYN.create(MODELLI + "/yunet.onnx", "", (V.LATO, V.LATO), 0.7, 0.3, 5000)
        trad = cv2.FaceRecognizerSF.create(MODELLI + "/sface.onnx", "")
        for p in senza:
            if p["id"] in ids and dai_video(p, V, ids, gal, rv, trad, os.path.join(OUT, p["id"] + ".jpg")): dv += 1
    print("foto posate: %d nuove, %d dai nostri video, %d senza volto, %d in tutto" % (fatte, dv, saltate, len(os.listdir(OUT))))


if __name__ == "__main__":
    main()
