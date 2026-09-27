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
  GET /provino/<k>.jpg?v=<percorso> il provino: 6 fotogrammi lungo la clip in una striscia,
                                   per l'anteprima che scorre col mouse sulla tessera
  GET /copia?v=<percorso>          stato della copia leggera; se non c'e', la mette in coda
  GET /code                        cosa c'e' in coda
  POST /premiere {nome, vie, radice} l'XML per Premiere (xmeml 4, come il MAM di Como TV): una
                                   sequenza con i file uno dopo l'altro, collegati agli
                                   originali sulla NAS montata sul Mac (radice)
  POST /volti {k: [ritagli], pid | nome [, ruolo] | scarta | togli}
                                   battezza un gruppo di volti sconosciuti (battesimi.json): li
                                   da' a una persona che c'e' gia', a una persona nuova, o li
                                   scarta (tifosi, passanti); "togli" annulla. Un minuto dopo
                                   l'ultimo battesimo si rifanno i gruppi e l'indice.
Le copie finiscono in /var/lib/comotv-1907/proxy/<k>.mp4 e le serve nginx.
<k> = sha1(percorso)[:16]: la chiave la calcola chi chiede e qui si ricontrolla.
"""
import hashlib, json, os, subprocess, threading, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from xml.sax.saxutils import escape as xesc
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

R = "/mnt/qnap100-frame"
CASA = "/var/lib/comotv-1907"
MINI = os.path.join(CASA, "mini")
PROVINI = os.path.join(CASA, "provini")
PROVINO_INSIEME = threading.BoundedSemaphore(2)
FOTOGRAMMI = 6
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


def fai_provino(pieno, dest):
    """6 fotogrammi (dal 5% al 95% della durata) affiancati in una striscia da 6x320 px.
    Solo fotogrammi chiave (-skip_frame nokey): su un 4K a 10 bit decodificare fino al
    secondo esatto costa il triplo, e per un'anteprima il fotogramma chiave vicino basta"""
    d = durata(pieno)
    if not d: return False
    tmp = dest + ".tmp"; os.makedirs(tmp, exist_ok=True)
    try:
        pezzi = []
        for i in range(FOTOGRAMMI):
            t = d * (0.05 + 0.9 * i / (FOTOGRAMMI - 1))
            f = os.path.join(tmp, "%d.jpg" % i)
            subprocess.run(["nice", "-n", "10", "ffmpeg", "-v", "error", "-nostdin", "-y", "-skip_frame", "nokey", "-ss", "%.2f" % t, "-i", pieno, "-frames:v", "1",
                            "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2", "-q:v", "6", f],
                           capture_output=True, timeout=90)
            if os.path.exists(f): pezzi.append(f)
        if not pezzi: return False
        while len(pezzi) < FOTOGRAMMI: pezzi.append(pezzi[-1])
        cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y"]
        for f in pezzi: cmd += ["-i", f]
        cmd += ["-filter_complex", "hstack=inputs=%d" % FOTOGRAMMI, "-q:v", "6", dest + ".tmp.jpg"]
        subprocess.run(cmd, capture_output=True, timeout=60)
        if os.path.exists(dest + ".tmp.jpg"): os.replace(dest + ".tmp.jpg", dest); return True
        return False
    finally:
        for f in os.listdir(tmp): os.remove(os.path.join(tmp, f))
        os.rmdir(tmp)


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


def scheda_file(pieno):
    """durata, fps, misura e canali audio: quello che serve a Premiere per agganciare il file"""
    try:
        o = json.loads(subprocess.run(["nice", "-n", "10", "ffprobe", "-v", "error", "-show_entries",
                                       "format=duration:stream=codec_type,width,height,r_frame_rate,channels", "-of", "json", pieno],
                                      capture_output=True, text=True, timeout=60).stdout or "{}")
    except Exception:
        return None
    st = o.get("streams") or []
    v = next((x for x in st if x.get("codec_type") == "video"), {})
    a = next((x for x in st if x.get("codec_type") == "audio"), {})
    fps = 25.0
    try:
        n_, d_ = (v.get("r_frame_rate") or "25/1").split("/"); fps = int(n_) / max(1, int(d_)) or 25.0
    except ValueError: pass
    if fps < 5 or fps > 240: fps = 25.0
    return {"d": float((o.get("format") or {}).get("duration") or 0), "fps": fps, "w": int(v.get("width") or 1920),
            "h": int(v.get("height") or 1080), "ch": int(a.get("channels") or 0)}


def xml_premiere(nome, vie, radice):
    radice = (radice or "/Volumes/COMOTV - FRAME").rstrip("/")
    ok = []
    for v in vie:
        v2, pieno = dentro(v)
        if v2: ok.append((v2, pieno))
    with ThreadPoolExecutor(3) as ex:
        schede = list(ex.map(lambda x: scheda_file(x[1]), ok))
    voci = [(v, sc) for (v, _), sc in zip(ok, schede) if sc and sc["d"] > 0]
    if not voci: return None, 0
    # la sequenza prende la cadenza e la misura piu' comuni fra i file
    comune = max(set(round(sc["fps"], 3) for _, sc in voci), key=lambda f: sum(1 for _, sc in voci if round(sc["fps"], 3) == f))
    base = next(sc for _, sc in voci if round(sc["fps"], 3) == comune)
    def rate(f):
        ntsc = "TRUE" if any(abs(f - x) < 0.05 for x in (23.976, 29.97, 59.94)) else "FALSE"
        return "<rate><timebase>%d</timebase><ntsc>%s</ntsc></rate>" % (round(f), ntsc)
    tc = "<timecode>" + rate(comune) + "<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>"
    def url(v): return "file://localhost" + urllib.parse.quote(radice + "/" + v, safe="/")
    video, audio, marker, pos = "", "", "", 0
    for i, (v, sc) in enumerate(voci, 1):
        dur = max(1, round(sc["d"] * comune)); fdur = max(1, round(sc["d"] * sc["fps"]))
        n = xesc(os.path.basename(v))
        f = ('<file id="f%d"><name>%s</name><pathurl>%s</pathurl>%s<duration>%d</duration>%s<media><video><samplecharacteristics>'
             '<width>%d</width><height>%d</height></samplecharacteristics></video>%s</media></file>') % (
            i, n, xesc(url(v)), rate(sc["fps"]), fdur, tc, sc["w"], sc["h"], "<audio><channelcount>%d</channelcount></audio>" % sc["ch"] if sc["ch"] else "")
        link = ('<link><linkclipref>v%d</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>%d</clipindex></link>' % (i, i) +
                ('<link><linkclipref>a%d</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>%d</clipindex></link>' % (i, i) if sc["ch"] else ""))
        video += ('<clipitem id="v%d"><name>%s</name><duration>%d</duration>%s<start>%d</start><end>%d</end><in>0</in><out>%d</out>%s'
                  '<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>%s</clipitem>') % (i, n, dur, rate(comune), pos, pos + dur, dur, f, link)
        if sc["ch"]:
            audio += ('<clipitem id="a%d"><name>%s</name><duration>%d</duration>%s<start>%d</start><end>%d</end><in>0</in><out>%d</out><file id="f%d"/>'
                      '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>%s</clipitem>') % (i, n, dur, rate(comune), pos, pos + dur, dur, i, link)
        marker += "<marker><name>%s</name><comment>%s</comment><in>%d</in><out>-1</out></marker>" % (n, xesc(os.path.dirname(v)), pos)
        pos += dur
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n<sequence id="sequence-1"><name>%s</name><duration>%d</duration>%s%s\n'
           '<media><video><format><samplecharacteristics>%s<width>%d</width><height>%d</height></samplecharacteristics></format><track>%s</track></video>'
           '<audio><track>%s</track></audio></media>\n%s\n</sequence>\n</xmeml>\n') % (
        xesc(nome or "Como 1907"), pos, rate(comune), tc, rate(comune), base["w"], base["h"], video, audio, marker)
    return xml, len(voci)


# ── I BATTESIMI DEI VOLTI (28/09/2026) ──────────────────────────────────
BATTESIMI = os.path.join(CASA, "battesimi.json")
B_LOCK = threading.Lock()
RIFAI = {"quando": 0, "gira": False}


def _meta():
    import importlib.util
    sp = importlib.util.spec_from_file_location("meta", "/opt/comotv/metadati_1907.py")
    m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m


def battezza(p, chi):
    import re
    ks = [str(k) for k in (p.get("k") or []) if re.fullmatch(r"[0-9a-f]{14}", str(k))][:5000]
    if not ks: return 400, {"ok": False, "errore": "nessun volto"}
    with B_LOCK:
        try: b = json.load(open(BATTESIMI))
        except Exception: b = {}
        crop = b.setdefault("crop", {}); pers = b.setdefault("persone", {}); storia = b.setdefault("storia", [])
        if p.get("togli"):
            for k in ks: crop.pop(k, None)
            pid = "togli"
        elif p.get("scarta"):
            pid = "-"
        else:
            M = _meta(); tutte = {x["id"]: x for x in M.persone()}
            pid = str(p.get("pid") or "")
            if pid and pid not in tutte: return 400, {"ok": False, "errore": "persona sconosciuta"}
            if not pid:
                nome = " ".join(str(p.get("nome") or "").split())[:60]
                if len(nome) < 3: return 400, {"ok": False, "errore": "scrivi il nome"}
                pid = M.slug(nome)
                if pid not in tutte: pers[pid] = {"nome": nome, "ruolo": str(p.get("ruolo") or "")[:40], "volto": ks[0]}
        if pid != "togli":
            for k in ks: crop[k] = pid
        # una persona nuova rimasta senza volti non serve piu'
        usati = set(crop.values())
        for q in [q for q in pers if q not in usati]: pers.pop(q)
        storia.append([int(time.time()), chi, pid, len(ks)]); del storia[:-500]
        tmp = BATTESIMI + ".tmp"; json.dump(b, open(tmp, "w"), ensure_ascii=False); os.replace(tmp, BATTESIMI)
    RIFAI["quando"] = time.time() + 60
    if not RIFAI["gira"]: threading.Thread(target=rifai, daemon=True).start()
    return 200, {"ok": True, "pid": pid, "quanti": len(ks)}


def rifai():
    """un minuto dopo l'ultimo battesimo: i gruppi dei volti e l'indice (se non c'e' una diretta)"""
    RIFAI["gira"] = True
    try:
        while time.time() < RIFAI["quando"] or in_diretta(): time.sleep(10)
        RIFAI["quando"] = 0
        subprocess.run(["nice", "-n", "10", "/opt/volti/bin/python", "/opt/comotv/ignoti-1907.py"], capture_output=True, timeout=1800)
        subprocess.run(["nice", "-n", "10", "python3", "/opt/comotv/indice-1907-da-elenco.py"], capture_output=True, timeout=3600)
    except Exception:
        pass
    finally:
        RIFAI["gira"] = False
        if RIFAI["quando"]: threading.Thread(target=rifai, daemon=True).start()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def rispondi(self, codice, corpo, tipo="application/json; charset=utf-8", extra=None):
        b = corpo if isinstance(corpo, bytes) else json.dumps(corpo, ensure_ascii=False).encode()
        self.send_response(codice); self.send_header("Content-Type", tipo); self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)

    def do_POST(self):
        via = urllib.parse.urlparse(self.path).path
        if via not in ("/premiere", "/volti"): return self.rispondi(404, {"ok": False})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            p = json.loads(self.rfile.read(min(n, 2_000_000)) or b"{}")
        except Exception:
            return self.rispondi(400, {"ok": False, "errore": "richiesta non valida"})
        if via == "/volti":
            cod, r = battezza(p, str(self.headers.get("X-Utente") or ""))
            return self.rispondi(cod, r)
        vie = [str(v) for v in (p.get("vie") or [])][:600]
        xml, quanti = xml_premiere(str(p.get("nome") or ""), vie, str(p.get("radice") or ""))
        if not xml: return self.rispondi(400, {"ok": False, "errore": "nessun video leggibile"})
        return self.rispondi(200, xml.encode("utf-8"), "application/xml; charset=utf-8", {"X-Quanti": str(quanti)})

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
        if u.path.startswith("/provino/"):
            k = u.path[9:].replace(".jpg", "")
            v, pieno = dentro((q.get("v") or [""])[0])
            if not v or chiave(v) != k or not v.lower().endswith(VIDEO): return self.rispondi(404, {"ok": False})
            dest = os.path.join(PROVINI, k + ".jpg")
            if not os.path.exists(dest):
                with PROVINO_INSIEME:
                    if not os.path.exists(dest) and not fai_provino(pieno, dest):
                        return self.rispondi(404, {"ok": False, "errore": "provino non riuscito"})
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
    os.makedirs(MINI, exist_ok=True); os.makedirs(COPIE, exist_ok=True); os.makedirs(PROVINI, exist_ok=True)
    threading.Thread(target=lavora, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 8097), H).serve_forever()
