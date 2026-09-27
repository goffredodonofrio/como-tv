#!/usr/bin/env python3
"""
RITRATTI-1907 — le persone del club senza una foto premium, riconoscibili dal volto.
(Goffredo, 28/09/2026: la foto di Mirwan Suwarso)

Una foto in /var/lib/comotv-1907/ritratti/<id persona>.jpg (l'id e' quello dell'indice:
"mirwan-suwarso"). Qui si trova il volto piu' grande, si ritaglia (pub/ignoti/<k>.jpg, fa
da foto nella scheda) e se ne fa l'impronta: ritratti.json. volti-1907.py la mette nella
galleria accanto agli scontornati, cosi' quella persona si riconosce nei video.

  /opt/volti/bin/python ritratti-1907.py
"""
import hashlib, json, os, sys

import cv2
import numpy as np

CASA = "/var/lib/comotv-1907"
DIR = os.path.join(CASA, "ritratti")
OUT = os.path.join(CASA, "ritratti.json")
RITAGLI = os.path.join(CASA, "pub", "ignoti")
MODELLI = "/opt/volti/modelli"
sys.path.insert(0, "/opt/comotv")
import importlib.util
sp = importlib.util.spec_from_file_location("volti", "/opt/comotv/volti-1907.py"); V = importlib.util.module_from_spec(sp); sp.loader.exec_module(V)


def main():
    riv = cv2.FaceDetectorYN.create(MODELLI + "/yunet.onnx", "", (640, 640), 0.7, 0.3, 5000)
    trad = cv2.FaceRecognizerSF.create(MODELLI + "/sface.onnx", "")
    fuori = {}
    for nome in sorted(os.listdir(DIR)) if os.path.isdir(DIR) else []:
        pid, est = os.path.splitext(nome)
        if est.lower() not in (".jpg", ".jpeg", ".png", ".webp"): continue
        im = cv2.imread(os.path.join(DIR, nome))
        if im is None: print("non leggo", nome); continue
        h, w = im.shape[:2]
        if max(h, w) > 1600:
            r = 1600 / max(h, w); im = cv2.resize(im, (int(w * r), int(h * r))); h, w = im.shape[:2]
        riv.setInputSize((w, h)); _, f = riv.detect(im)
        if f is None or not len(f): print("nessun volto in", nome); continue
        f = max(f, key=lambda x: x[2] * x[3])
        rit = trad.alignCrop(im, f)
        e = trad.feature(rit).flatten().astype(np.float32); e /= np.linalg.norm(e)
        k = hashlib.sha1(("ritratto#" + pid).encode()).hexdigest()[:14]
        os.makedirs(RITAGLI, exist_ok=True); cv2.imwrite(os.path.join(RITAGLI, k + ".jpg"), rit, [cv2.IMWRITE_JPEG_QUALITY, 88])
        fuori[pid] = {"k": k, "e": V.impronta(e)}
        print("ritratto:", pid)
    tmp = OUT + ".tmp"; json.dump(fuori, open(tmp, "w")); os.replace(tmp, OUT)


if __name__ == "__main__":
    main()
