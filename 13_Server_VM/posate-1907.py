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
import glob, importlib.util, json, os

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


def main():
    os.makedirs(OUT, exist_ok=True)
    riv = cv2.FaceDetectorYN.create(MODELLI + "/yunet.onnx", "", (640, 640), 0.6, 0.3, 50)
    fatte = saltate = 0
    for p in META.persone():
        src = os.path.join(META.FOTO_DIR, p["foto"]) if p.get("foto") else ""
        if not src or not os.path.exists(src):
            mani = glob.glob(os.path.join(CASA, "ritratti", p["id"] + ".*"))
            src = mani[0] if mani else ""
        if not src: continue
        dest = os.path.join(OUT, p["id"] + ".jpg")
        if os.path.exists(dest) and os.path.getmtime(dest) >= os.path.getmtime(src): continue
        im = carica(src)
        if im is None: saltate += 1; continue
        h, w = im.shape[:2]; r = min(1.0, 1200 / max(h, w))
        pic = cv2.resize(im, (int(w * r), int(h * r))) if r < 1 else im
        riv.setInputSize((pic.shape[1], pic.shape[0])); _, ff = riv.detect(pic)
        if ff is None or not len(ff): saltate += 1; continue
        f = max(ff, key=lambda x: x[2] * x[3]) / r
        cx, cy, lato = f[0] + f[2] / 2, f[1] + f[3] * 0.42, max(f[2], f[3]) * 2.0
        x0, y0 = int(cx - lato / 2), int(cy - lato / 2); x1, y1 = int(x0 + lato), int(y0 + lato)
        tela = np.full((y1 - y0, x1 - x0, 3), FONDO, np.uint8)
        ax0, ay0, ax1, ay1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
        tela[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = im[ay0:ay1, ax0:ax1]
        cv2.imwrite(dest, cv2.resize(tela, (LATO, LATO), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 86])
        fatte += 1
    print("foto posate: %d nuove, %d senza volto, %d in tutto" % (fatte, saltate, len(os.listdir(OUT))))


if __name__ == "__main__":
    main()
