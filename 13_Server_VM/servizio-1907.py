#!/usr/bin/env python3
"""
SERVIZIO-1907 — miniature e copie leggere del materiale Como 1907.
(Goffredo, 27/09/2026)

Il FRAME (/mnt/qnap100-frame, sola lettura) e' fatto di originali di camera:
meta' sono H.264 4:2:2 a 10 bit o HEVC 4:2:2, in 4K, che il browser non
legge. Per vederli nella pagina e montarli nell'Editing serve una copia
leggera (720p, H.264 8 bit, stereo): si fa A RICHIESTA, un file alla volta,
a bassa priorita', e mai durante una diretta. L'export del montaggio usa
sempre l'originale: la copia serve solo agli occhi.

Fuori dal ponte, dietro nginx su 127.0.0.1:8097:
  GET /mini/<k>.jpg?v=<percorso>   miniatura (fatta la prima volta che la si chiede)
  GET /copia?v=<percorso>          stato della copia leggera; se non c'e', la mette in coda
  GET /code                        cosa c'e' in coda
Le copie finiscono in /var/lib/comotv-1907/proxy/<k>.mp4 e le serve nginx.
<k> = sha1(percorso)[:16]: la chiave la calcola chi chiede e qui si ricontrolla.
"""
import hashlib, json, os, subprocess, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

R = "/mnt/qnap100-frame"
CASA = "/var/lib/comotv-1907"
MINI = os.path.join(CASA, "mini")
COPIE = os.path.join(CASA, "proxy")
VIDEO = (".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".webm")
FOTO = (".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff")
MINI_INSIEME = threading.BoundedSemaphore(2)
CODA, STATO, LOCK = [], {}, threading.Lock()


def chiave(p): return hashlib.sha1(p.encode()).hexdigest()[:16]


def dentro(v):
    v = "/".join(x for x in str(v or "").replace("\\", "/").split("/") if x and x not in (".", ".."))
    pieno = os.path.realpath(os.path.join(R, v))
    if not v or not pieno.startswith(R + "/") or os.path.basename(v).startswith((".", "@")): return None, None
    return v, pieno


def in_diretta():
    try:
        req = urllib.request.Request("http://127.0.0.1:8080/api", data=json.dumps({"tipo": "clip-stato"}).encode(), headers={"Content-Type": "text/plain"})
        return any(r.get("stato") == "registra" and not r.get("guarda") for r in json.load(urllib.request.urlopen(req, timeout=8)).get("reg", []))
    except Exception:
        return False


def durata(pieno):
    try:
        return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", pieno],
                                    capture_output=True, text=True, timeout=60).stdout.strip() or 0)
    except Exception:
        return 0


def fai_mini(v, pieno, dest):
    tmp = dest + ".tmp.jpg"
    if v.lower().endswith(VIDEO):
        d = durata(pieno)
        at = str(min(max(1.0, d * 0.2), 30.0)) if d else "1"
        cmd = ["nice", "-n", "10", "ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", at, "-i", pieno, "-frames:v", "1",
               "-vf", "scale=480:-2", "-q:v", "5", tmp]
    elif v.lower().endswith(FOTO):
        cmd = ["nice", "-n", "10", "ffmpeg", "-v", "error", "-nostdin", "-y", "-i", pieno, "-frames:v", "1",
               "-vf", "scale=480:-2", "-q:v", "5", tmp]
    else:
        return False
    subprocess.run(cmd, capture_output=True, timeout=120)
    if os.path.exists(tmp) and os.path.getsize(tmp) > 0:
        os.replace(tmp, dest); return True
    return False


def lavora():
    while True:
        with LOCK:
            k = CODA[0] if CODA else None
        if not k:
            time.sleep(2); continue
        s = STATO[k]
        while in_diretta():
            s["stato"] = "in pausa: c'e' una diretta"; time.sleep(120)
        s["stato"] = "lavoro"; s["iniziata"] = time.time()
        dest = os.path.join(COPIE, k + ".mp4"); tmp = dest + ".tmp.mp4"
        d = durata(s["pieno"]); s["durata"] = d
        cmd = ["nice", "-n", "19", "ffmpeg", "-v", "error", "-nostdin", "-y", "-progress", "pipe:1", "-threads", "2", "-i", s["pieno"],
               "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:720:flags=fast_bilinear,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
               "-crf", "25", "-g", "25", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", tmp]
        try:
            pr = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for riga in pr.stdout:
                if riga.startswith("out_time_us=") and d:
                    try: s["avanzamento"] = min(0.99, int(riga.split("=")[1]) / 1e6 / d)
                    except ValueError: pass
            pr.wait()
            if pr.returncode == 0 and os.path.exists(tmp):
                os.replace(tmp, dest); s["stato"] = "pronta"; s["avanzamento"] = 1
            else:
                s["stato"] = "errore"; s["errore"] = (pr.stderr.read() or "")[-300:]
                try: os.remove(tmp)
                except OSError: pass
        except Exception as e:
            s["stato"] = "errore"; s["errore"] = str(e)[:300]
        with LOCK:
            if CODA and CODA[0] == k: CODA.pop(0)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def rispondi(self, codice, corpo, tipo="application/json; charset=utf-8", extra=None):
        b = corpo if isinstance(corpo, bytes) else json.dumps(corpo, ensure_ascii=False).encode()
        self.send_response(codice); self.send_header("Content-Type", tipo); self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path.startswith("/mini/"):
            k = u.path[6:].replace(".jpg", "")
            v, pieno = dentro((q.get("v") or [""])[0])
            if not v or chiave(v) != k: return self.rispondi(404, {"ok": False})
            dest = os.path.join(MINI, k + ".jpg")
            if not os.path.exists(dest):
                with MINI_INSIEME:
                    if not os.path.exists(dest) and not fai_mini(v, pieno, dest):
                        return self.rispondi(404, {"ok": False, "errore": "miniatura non riuscita"})
            with open(dest, "rb") as f:
                return self.rispondi(200, f.read(), "image/jpeg", {"Cache-Control": "public, max-age=2592000"})
        if u.path == "/copia":
            v, pieno = dentro((q.get("v") or [""])[0])
            if not v or not v.lower().endswith(VIDEO): return self.rispondi(400, {"ok": False, "errore": "non e' un video"})
            k = chiave(v)
            if os.path.exists(os.path.join(COPIE, k + ".mp4")):
                return self.rispondi(200, {"ok": True, "stato": "pronta", "k": k, "via": "/como-tv/mam-1907/copie/" + k + ".mp4"})
            with LOCK:
                s = STATO.get(k)
                # senza ?fai=1 si guarda soltanto: la copia costa, si fa solo se l'originale non si vede
                if not s and not (q.get("fai") or [""])[0]:
                    return self.rispondi(200, {"ok": True, "k": k, "stato": "assente"})
                if not s or s["stato"] == "errore" and (q.get("riprova") or [""])[0]:
                    s = STATO[k] = {"v": v, "pieno": pieno, "stato": "in coda", "avanzamento": 0, "messa": time.time()}
                    CODA.append(k)
                davanti = CODA.index(k) if k in CODA else 0
            return self.rispondi(200, {"ok": True, "k": k, "stato": s["stato"], "avanzamento": round(s.get("avanzamento", 0), 3),
                                       "davanti": davanti, "errore": s.get("errore", "")})
        if u.path == "/code":
            with LOCK:
                return self.rispondi(200, {"ok": True, "coda": [dict(STATO[k], pieno=None) for k in CODA]})
        return self.rispondi(404, {"ok": False})


if __name__ == "__main__":
    os.makedirs(MINI, exist_ok=True); os.makedirs(COPIE, exist_ok=True)
    threading.Thread(target=lavora, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 8097), H).serve_forever()
