#!/usr/bin/env python3
"""I VOLTI NELL'ARCHIVIO (28/09/2026): dove si vede un volto in un file.
volti.py FILE DA DURATA FOTO [FOTO...] -> righe JSON {t, n, v:[[i_foto, sim, x, y, w, h], ...]}
(DA e DURATA a 0 = tutto il file). Legge solo i fotogrammi chiave (-skip_frame
nokey, uno al secondo nei nostri file): decodificare tutto costa dieci volte
tanto. Due ore di partita in circa 14 minuti di un core.

Lo lancia il ponte (clip.js, voltiAvanti) per trovare dove la regia inquadra
un allenatore. Installazione sulla VM (gratis, niente GPU):
    mkdir -p /opt/comotv-volti/modelli && cd /opt/comotv-volti
    python3 -m venv venv && ./venv/bin/pip install opencv-python-headless numpy
    curl -sL -o modelli/yunet.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
    curl -sL -o modelli/sface.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
    cp volti.py /opt/comotv-volti/
Soglie (nel ponte): somiglianza SFace >= 0,42, volto alto almeno 55 px su 540
(la fotina nella grafica della formazione e' 30 px)."""
import sys, json, subprocess, threading, re, numpy as np, cv2, os
M = os.path.join(os.path.dirname(os.path.abspath(__file__)), "modelli")
W, H = 960, 540
det = cv2.FaceDetectorYN.create(os.path.join(M, "yunet.onnx"), "", (W, H), 0.7, 0.3, 50)
rec = cv2.FaceRecognizerSF.create(os.path.join(M, "sface.onnx"), "")
def carica(foto):
    img = cv2.imread(foto, cv2.IMREAD_UNCHANGED)
    if img.ndim == 3 and img.shape[2] == 4:
        a = img[:, :, 3:] / 255.0; img = (img[:, :, :3] * a + 255 * (1 - a)).astype(np.uint8)
    det.setInputSize((img.shape[1], img.shape[0])); _, f = det.detect(img)
    if f is None: return None
    x = max(f, key=lambda z: z[2] * z[3]); return rec.feature(rec.alignCrop(img, x))
file, da, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
rif = [carica(f) for f in sys.argv[4:]]
cmd = ["ffmpeg", "-v", "info", "-nostats", "-skip_frame", "nokey"] + (["-ss", str(da)] if da > 0 else []) + ["-i", file] + (["-t", str(dur)] if dur > 0 else []) + \
      ["-vf", f"scale={W}:{H},showinfo", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
tempi = []
def leggi():
    for l in p.stderr:
        m = re.search(rb"pts_time:\s*([\d.]+)", l)
        if m: tempi.append(float(m.group(1)))
threading.Thread(target=leggi, daemon=True).start()
det.setInputSize((W, H)); i = 0
while True:
    b = p.stdout.read(W * H * 3)
    if len(b) < W * H * 3: break
    img = np.frombuffer(b, np.uint8).reshape(H, W, 3)
    _, f = det.detect(img); v = []
    for x in (f if f is not None else []):
        e = rec.feature(rec.alignCrop(img, x))
        for j, r in enumerate(rif):
            if r is None: continue
            s = float(rec.match(r, e, cv2.FaceRecognizerSF_FR_COSINE))
            if s > 0.3: v.append([j, round(s, 3)] + [int(z) for z in x[:4]])
    while len(tempi) <= i and p.poll() is None: pass
    t = tempi[i] if i < len(tempi) else None
    if t is not None and da > 0: t += da
    print(json.dumps({"t": None if t is None else round(t, 2), "n": 0 if f is None else len(f), "v": v}), flush=True)
    i += 1
# un file che non si apre (o si interrompe) non e' "nessun volto": e' un errore
p.wait()
if i == 0 or p.returncode != 0:
    print("volti.py: file illeggibile (ffmpeg " + str(p.returncode) + ", " + str(i) + " fotogrammi)", file=sys.stderr)
    sys.exit(3)
