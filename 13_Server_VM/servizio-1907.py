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
  POST /volti {k: [ritagli], pid | nome [, ruolo] | scarta | togli} oppure {proposta: id, si: true|false}
                                   battezza un gruppo di volti sconosciuti (battesimi.json): li
                                   da' a una persona che c'e' gia', a una persona nuova, o li
                                   scarta (tifosi, passanti); "togli" annulla. Un minuto dopo
                                   l'ultimo battesimo si rifanno i gruppi e l'indice.
Le copie finiscono in /var/lib/comotv-1907/proxy/<k>.mp4 e le serve nginx.
<k> = sha1(percorso)[:16]: la chiave la calcola chi chiede e qui si ricontrolla.
"""
import hashlib, json, os, re, secrets, subprocess, threading, time, urllib.parse, urllib.request
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


def proposta(p, chi):
    """la faccia proposta da ritratti-auto-1907 per una persona: si' (diventa il suo ritratto) o no"""
    pid = str(p.get("proposta") or "")
    with B_LOCK:
        prop = _leggi(os.path.join(CASA, "proposte.json"), {})
        x = prop.pop(pid, None)
        if not x: return 404, {"ok": False, "errore": "proposta non trovata"}
        if p.get("si"):
            r = _leggi(os.path.join(CASA, "ritratti.json"), {})
            r[pid] = {"k": x["k"], "e": x["e"], "fonte": "auto", "confermato": chi or "pagina", "quando": int(time.time())}
            _scrivi(os.path.join(CASA, "ritratti.json"), r)
        else:
            fa = _leggi(os.path.join(CASA, "ritratti-auto.json"), {})
            fa[pid] = dict(fa.get(pid) or {}, esito="rifiutata", chi=chi)
            _scrivi(os.path.join(CASA, "ritratti-auto.json"), fa)
        _scrivi(os.path.join(CASA, "proposte.json"), prop)
        b = _leggi(BATTESIMI, {}); b.setdefault("storia", []).append([int(time.time()), chi, ("si:" if p.get("si") else "no:") + pid, 1]); _scrivi(BATTESIMI, b)
    RIFAI["quando"] = time.time() + 60
    if not RIFAI["gira"]: threading.Thread(target=rifai, daemon=True).start()
    return 200, {"ok": True, "pid": pid}


def _leggi(f, d):
    try: return json.load(open(f))
    except Exception: return d


def _scrivi(f, x):
    tmp = f + ".tmp"; json.dump(x, open(tmp, "w"), ensure_ascii=False); os.replace(tmp, f)


def battezza(p, chi):
    import re
    if p.get("proposta"): return proposta(p, chi)
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


# ── I DOPPIONI SEGNATI (29/09/2026) ────────────────────────────────────
# La pagina Doppioni 1907 mostra le copie; il team del club segna quelle da cancellare. Qui si
# tiene solo il segno (chi, quando): il FRAME e' in sola lettura, nessun file si tocca.
SEGNATI = os.path.join(CASA, "doppioni-segnati.json")
S_LOCK = threading.Lock()


def puo_segnare(email):
    """il club (@comofootball.com) e i super utenti di Como TV"""
    email = (email or "").lower()
    conf = {}
    try:
        for r in open("/etc/comotv/accesso.env"):
            if "=" in r and not r.lstrip().startswith("#"):
                k, v = r.split("=", 1); conf[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    admin = {x.strip().lower() for x in conf.get("ACCESSO_ADMIN", "goffredo.donofrio@sent.tv").split(",") if x.strip()}
    try: admin |= {k.lower() for k, v in json.load(open("/etc/comotv/accesso-locali.json")).items() if v.get("admin")}
    except Exception: pass
    club = [d.strip().lower() for d in conf.get("ACCESSO_SOLO_1907", "comofootball.com").split(",") if d.strip()]
    return bool(email) and (email in admin or email.rsplit("@", 1)[-1] in club)


def segna(p, chi):
    if not puo_segnare(chi): return 403, {"ok": False, "errore": "Solo il team del Como 1907 puo' segnare i doppioni."}
    voci = [v for v in (p.get("voci") or []) if isinstance(v, dict) and v.get("via")][:5000]
    if not voci: return 400, {"ok": False, "errore": "niente da segnare"}
    with S_LOCK:
        s = _leggi(SEGNATI, {"segnati": {}, "storia": []})
        for v in voci:
            via = str(v["via"])[:1000]
            if p.get("azione") == "togli": s["segnati"].pop(via, None)
            else: s["segnati"][via] = {"chi": chi, "quando": int(time.time()), "tipo": "cartella" if v.get("tipo") == "cartella" else "file", "peso": int(v.get("peso") or 0)}
        s["storia"].append([int(time.time()), chi, p.get("azione") or "segna", len(voci)]); del s["storia"][:-1000]
        _scrivi(SEGNATI, s)
    return 200, {"ok": True, "segnati": len(s["segnati"])}


# ELIMINA DAL MAM (Goffredo, 29/09/2026: "se si logga lui [Gionata Medeot] puo' cancellare, gli
# altri di comofootball si fanno la lista al massimo"; poi: "vorrei che si eliminasse direttamente
# ... 1 e ciao, si arrangiano"). Solo chi e' in CANCELLA (o in /etc/comotv/doppioni-cancella.txt,
# una mail per riga) e i super utenti. L'ELIMINAZIONE E' DEFINITIVA: via NFS il cestino di rete della
# QNAP non la raccoglie. Prima si ricontrolla che la copia che resta ci sia con tutti i file grandi;
# resta il registro (doppioni-eliminati.json: chi, quando, cosa, quale copia e' rimasta).
# Si scrive solo dal collegamento dedicato /mnt/qnap100-frame-cestino; il MAM legge sempre da quello
# in sola lettura.
import shutil
CANCELLA = {"gionata.medeot@comofootball.com"}
RW = "/mnt/qnap100-frame-cestino"
ELIMINATI = os.path.join(CASA, "doppioni-eliminati.json")


def puo_eliminare(email):
    email = (email or "").lower()
    chi = set(CANCELLA)
    try: chi |= {r.strip().lower() for r in open("/etc/comotv/doppioni-cancella.txt") if r.strip() and not r.startswith("#")}
    except OSError: pass
    # piu' i super utenti di Como TV (puo_segnare li ammette, e non sono del club)
    return bool(email) and (email in chi or (puo_segnare(email) and not email.endswith("@comofootball.com")))


def _grandi(radice):
    """{(nome minuscolo, dimensione)} dei file sopra 1 MB sotto una cartella"""
    fuori = set()
    for d, ds, fs in os.walk(radice):
        ds[:] = [x for x in ds if not x.startswith((".", "@"))]
        for f in fs:
            if f.startswith("."): continue
            try: s = os.path.getsize(os.path.join(d, f))
            except OSError: continue
            if s >= 1_000_000: fuori.add((f.lower(), s))
    return fuori


def _nas_pronta():
    """il collegamento in scrittura e' davvero la NAS? (29/09/2026: senza mount, le scritture
    finivano sul disco della VM e una prova sembrava riuscita)"""
    try:
        return len(os.listdir(RW)) > 3 and os.stat(RW).st_dev != os.stat(os.path.dirname(RW)).st_dev
    except OSError:
        return False


def _impronta(p):
    """primi e ultimi 256 KB + dimensione (come doppioni-1907.py)"""
    try:
        with open(p, "rb") as f:
            a = f.read(262144); f.seek(0, 2); n = f.tell(); f.seek(max(0, n - 262144)); b = f.read(262144)
        return hashlib.sha1(a + b + str(n).encode()).hexdigest()
    except OSError:
        return None


def _stesso_contenuto(src, keep, cartella):
    """al momento di eliminare, il contenuto si confronta di nuovo: un file, o i 5 piu' grandi di una cartella"""
    if not cartella:
        h = _impronta(src); return bool(h) and h == _impronta(keep)
    di_keep = {}
    for d, ds, fs in os.walk(keep):
        for f in fs:
            try: di_keep.setdefault((f.lower(), os.path.getsize(os.path.join(d, f))), os.path.join(d, f))
            except OSError: pass
    grandi = []
    for d, ds, fs in os.walk(src):
        for f in fs:
            try: grandi.append((os.path.getsize(os.path.join(d, f)), f, os.path.join(d, f)))
            except OSError: pass
    for size, f, pa in sorted(grandi, reverse=True)[:5]:
        pb = di_keep.get((f.lower(), size))
        if not pb: return False
        ha = _impronta(pa)
        if not ha or ha != _impronta(pb): return False
    return True


def _dentro_frame(p):
    """il percorso vero sta dentro il FRAME, e non e' il FRAME stesso"""
    v = os.path.realpath(p)
    return v.startswith(RW + "/") and v.rstrip("/") != RW


def elimina(p, chi):
    if not puo_eliminare(chi): return 403, {"ok": False, "errore": "Eliminare dal MAM puo' solo chi e' autorizzato (Gionata Medeot)."}
    if not _nas_pronta(): return 503, {"ok": False, "errore": "La NAS del club non e' collegata in scrittura in questo momento: non si elimina niente. Riprova tra poco."}
    tieni = _tenute(); esiti = []
    vie = ["/".join(x for x in str(v).split("/") if x and x not in (".", "..")) for v in (p.get("vie") or [])][:2000]
    via_set = set(vie)
    with S_LOCK:
        s = _leggi(SEGNATI, {"segnati": {}, "storia": []}); e_ = _leggi(ELIMINATI, {"voci": {}, "storia": []})
        for via in vie:
            if not via: continue
            b = tieni.get(via)
            if not b: esiti.append([via, "non e' nell'elenco dei doppioni"]); continue
            if any(b == x or b.startswith(x + "/") for x in via_set): esiti.append([via, "anche la copia che resta e' tra quelle da eliminare"]); continue
            src, keep = os.path.join(RW, via), os.path.join(RW, b)
            if not _dentro_frame(src) or not _dentro_frame(keep): esiti.append([via, "percorso non valido"]); continue
            if not os.path.exists(src): esiti.append([via, "non c'e' piu'"]); continue
            if not os.path.exists(keep): esiti.append([via, "la copia che resta non c'e' piu': non si elimina"]); continue
            # l'ultimo controllo: tutto quello che se ne va deve stare nella copia che resta
            cartella = os.path.isdir(src)
            if cartella:
                manca = _grandi(src) - _grandi(keep)
                if manca: esiti.append([via, "la copia che resta non ha %d dei suoi file: non si elimina" % len(manca)]); continue
            elif os.path.getsize(src) != os.path.getsize(keep): esiti.append([via, "la copia che resta ha un'altra dimensione: non si elimina"]); continue
            if not _stesso_contenuto(src, keep, cartella): esiti.append([via, "il contenuto della copia che resta e' diverso: non si elimina"]); continue
            errori, tenuti = [], []
            try:
                if cartella:
                    # (29/09/2026) file per file: se ne va solo quello che nella copia che resta c'e' uguale
                    # (stesso percorso dentro la cartella e stessa dimensione). Quello che non c'e' (sottotitoli,
                    # progetti Premiere, foto piccole) RESTA dov'e', con le sue cartelle: l'unica copia non si tocca.
                    # (29/09/2026, sera) la copia uguale si cerca OVUNQUE dentro la cartella che resta (le copie
                    # hanno spesso le sottocartelle in un altro ordine): stesso nome e stessa dimensione, e per i
                    # file grandi anche inizio e fine uguali. I "._nome" (metadati del Mac) seguono il loro file.
                    idx = {}
                    for r2, c2, f2 in os.walk(keep):
                        for f in f2:
                            try: idx.setdefault((f.lower(), os.path.getsize(os.path.join(r2, f))), []).append(os.path.join(r2, f))
                            except OSError: pass
                    for radice, cc, ff in os.walk(src, topdown=False):
                        andati = set()
                        for f in sorted(ff, key=lambda z: z.startswith("._")):
                            pf = os.path.join(radice, f)
                            try:
                                if f.startswith("._") and f[2:] in andati: os.remove(pf); continue
                                sz = os.path.getsize(pf)
                                cand = idx.get((f.lower(), sz)) or []
                                ip = _impronta(pf) if cand and sz >= 2_000_000 else ""
                                ok = bool(cand) and (sz < 2_000_000 or (ip is not None and ip == _impronta(cand[0])))
                                if ok: os.remove(pf); andati.add(f)
                                else: tenuti.append(os.path.relpath(pf, RW))
                            except OSError: errori.append(os.path.relpath(pf, RW))
                        try:
                            if not os.listdir(radice): os.rmdir(radice)
                        except OSError: pass
                else: os.remove(src)
            except OSError as ex:
                errori.append(str(ex.strerror or ex))
            k = next((k0 for k0, v0 in e_["voci"].items() if v0.get("via") == via), None) or hashlib.sha1((via + str(time.time())).encode()).hexdigest()[:12]
            e_["voci"][k] = {"via": via, "tieni": b, "chi": chi, "quando": int(time.time()), "cartella": cartella,
                             "segnato_da": (s["segnati"].get(via) or {}).get("chi", ""), "errori": errori[:20], "tenuti": tenuti[:50]}
            s["segnati"].pop(via, None)
            esiti.append([via, "eliminato in parte: %d elementi non si sono potuti togliere" % len(errori) if errori else
                          "ok, tenuti %d file che non avevano un'altra copia" % len(tenuti) if tenuti else "ok"])
        n = sum(1 for x in esiti if x[1].startswith("ok"))
        e_["storia"].append([int(time.time()), chi, "elimina", n]); del e_["storia"][:-1000]
        _scrivi(ELIMINATI, e_); _scrivi(SEGNATI, s)
    _CONTROLLO["t"] = 0
    ripara_indice([x[0] for x in esiti if x[1].startswith("ok") or x[1].startswith("eliminato")])
    return 200, {"ok": True, "eliminati": n, "esiti": esiti}


# ── LE CARTELLE DEL FRAME COME UN DISCO (Goffredo, 29/09/2026: "editabile in cartelle come un
# hard-disk"; possono tutti i @comofootball.com). Si guarda dal collegamento in sola lettura; si
# crea, rinomina e sposta SOLO da quello in scrittura (RW), dentro il FRAME, mai cancellando.
# Ogni spostamento resta in spostamenti.json (vecchio -> nuovo): il MAM ci ritrova le raccolte.
CARTELLE_REG = os.path.join(CASA, "cartelle-registro.json")
SPOSTAMENTI = os.path.join(CASA, "pub", "spostamenti.json")
VIDEO_FOTO = VIDEO + FOTO


def _rel(v):
    return "/".join(x for x in str(v or "").replace("\\", "/").split("/") if x and x not in (".", ".."))


def _nome_ok(nome):
    nome = " ".join(str(nome or "").split())
    if not nome or len(nome) > 200 or "/" in nome or nome.startswith((".", "@", "#")) or nome in (".", ".."): return ""
    return nome


def cartella(v):
    """il contenuto di una cartella del FRAME: cartelle e file, dal collegamento in sola lettura"""
    rel = _rel(v); pieno = os.path.join(R, rel) if rel else R
    if not os.path.realpath(pieno).startswith(R) or not os.path.isdir(pieno): return None
    cc, ff = [], []
    try:
        with os.scandir(pieno) as it:
            for e in it:
                if e.name.startswith((".", "@", "#")): continue
                try:
                    st = e.stat(follow_symlinks=False)
                    if e.is_dir(follow_symlinks=False): cc.append({"nome": e.name, "quando": int(st.st_mtime)})
                    else: ff.append({"nome": e.name, "peso": st.st_size, "quando": int(st.st_mtime)})
                except OSError:
                    pass
    except OSError:
        return None
    cc.sort(key=lambda x: x["nome"].lower()); ff.sort(key=lambda x: x["nome"].lower())
    return {"via": rel, "cartelle": cc, "file": ff}


def _registra(chi, azione, da, a):
    reg = _leggi(CARTELLE_REG, {"voci": []})
    reg["voci"].append([int(time.time()), chi, azione, da, a]); del reg["voci"][:-5000]
    _scrivi(CARTELLE_REG, reg)
    ripara_indice([da, a])
    if azione in ("rinomina", "sposta"): commenti_segui(da, a)
    if azione in ("rinomina", "sposta"):
        sp = _leggi(SPOSTAMENTI, {})
        # chi era gia' stato spostato dentro "da" segue il nuovo nome
        for k, v in list(sp.items()):
            if v == da or v.startswith(da + "/"): sp[k] = a + v[len(da):]
        sp[da] = a
        _scrivi(SPOSTAMENTI, sp)


def organizza(p, chi):
    if not puo_segnare(chi): return 403, {"ok": False, "errore": "Organizzare le cartelle puo' solo il team del Como 1907."}
    if not _nas_pronta(): return 503, {"ok": False, "errore": "La NAS del club non e' collegata in scrittura in questo momento. Riprova tra poco."}
    az = p.get("azione"); esiti = []
    with S_LOCK:
        if az == "nuova":
            dentro, nome = _rel(p.get("in")), _nome_ok(p.get("nome"))
            if not nome: return 400, {"ok": False, "errore": "Nome non valido."}
            dest = os.path.join(RW, dentro, nome)
            if not _dentro_frame(dest): return 400, {"ok": False, "errore": "Percorso non valido."}
            if os.path.exists(dest): return 409, {"ok": False, "errore": "C'e' gia' una cartella con questo nome."}
            try: os.makedirs(dest)
            except OSError as e: return 500, {"ok": False, "errore": "Non riuscito: %s" % (e.strerror or e)}
            _registra(chi, "nuova", "", _rel(os.path.join(dentro, nome)))
            return 200, {"ok": True, "via": _rel(os.path.join(dentro, nome))}
        if az == "rinomina":
            via, nome = _rel(p.get("via")), _nome_ok(p.get("nome"))
            if not via or not nome: return 400, {"ok": False, "errore": "Nome non valido."}
            src = os.path.join(RW, via); dest = os.path.join(os.path.dirname(src), nome)
            if not _dentro_frame(src) or not _dentro_frame(dest): return 400, {"ok": False, "errore": "Percorso non valido."}
            if not os.path.exists(src): return 404, {"ok": False, "errore": "Non c'e' piu'."}
            if os.path.exists(dest): return 409, {"ok": False, "errore": "C'e' gia' qualcosa con questo nome."}
            try: os.rename(src, dest)
            except OSError as e: return 500, {"ok": False, "errore": "Non riuscito: %s" % (e.strerror or e)}
            nuovo = _rel(os.path.relpath(dest, RW)); _registra(chi, "rinomina", via, nuovo)
            return 200, {"ok": True, "via": nuovo}
        if az == "sposta":
            dentro = _rel(p.get("in")); dd = os.path.join(RW, dentro) if dentro else RW
            if not os.path.isdir(dd) or not (dentro == "" or _dentro_frame(dd)): return 400, {"ok": False, "errore": "La cartella di arrivo non c'e'."}
            for via in [_rel(v) for v in (p.get("vie") or [])][:500]:
                if not via: continue
                src = os.path.join(RW, via); dest = os.path.join(dd, os.path.basename(via))
                if not _dentro_frame(src): esiti.append([via, "percorso non valido"]); continue
                if dentro == via or dentro.startswith(via + "/"): esiti.append([via, "non si sposta una cartella dentro se stessa"]); continue
                if os.path.dirname(via) == dentro: esiti.append([via, "e' gia' li'"]); continue
                if not os.path.exists(src): esiti.append([via, "non c'e' piu'"]); continue
                if os.path.exists(dest): esiti.append([via, "nella cartella di arrivo c'e' gia' qualcosa con questo nome"]); continue
                try: os.rename(src, dest)
                except OSError as e: esiti.append([via, "non riuscito: %s" % (e.strerror or e)]); continue
                nuovo = _rel(os.path.relpath(dest, RW)); _registra(chi, "sposta", via, nuovo); esiti.append([via, "ok"])
            return 200, {"ok": True, "spostati": sum(1 for x in esiti if x[1] == "ok"), "esiti": esiti}
    return 400, {"ok": False, "errore": "azione sconosciuta"}


# Qui si GUARDA anche, in sola lettura: un segnato che non c'e' piu' diventa "cancellato" (se
# qualcuno l'ha tolto dalla NAS a mano); se sparisce la copia che doveva restare, si avvisa.
_TIENI = {"t": 0, "m": {}}
_CONTROLLO = {"t": 0, "r": {}}


def _tenute():
    f = os.path.join(CASA, "pub", "doppioni.json")
    try: mt = os.path.getmtime(f)
    except OSError: return {}
    if mt != _TIENI["t"]:
        try:
            j = json.load(open(f))
            m = {r["cartella"]: r["tieni"] for r in j.get("cartelle", [])}; m.update({r["a"]: r["b"] for r in j.get("file", [])})
            _TIENI.update(t=mt, m=m)
        except Exception:
            pass
    return _TIENI["m"]


def controlla_segnati():
    """{via: {"cancellato": ts} | {"attenzione": "..."}} per i segnati, al massimo una volta al minuto"""
    if time.time() - _CONTROLLO["t"] < 60: return _CONTROLLO["r"]
    tieni = _tenute(); r = {}
    with S_LOCK:
        s = _leggi(SEGNATI, {"segnati": {}, "storia": []}); cambiato = False
        for via, x in s["segnati"].items():
            if not os.path.exists(os.path.join(R, via)):
                if not x.get("cancellato"): x["cancellato"] = int(time.time()); cambiato = True
                r[via] = {"cancellato": x["cancellato"]}
            elif x.get("cancellato"):
                x.pop("cancellato"); cambiato = True           # ricomparso (rimesso a posto dal cestino della QNAP)
            b = tieni.get(via)
            if b and not os.path.exists(os.path.join(R, b)):
                r.setdefault(via, {})["attenzione"] = "La copia che doveva restare non c'e' piu'"
        if cambiato: _scrivi(SEGNATI, s)
    _CONTROLLO.update(t=time.time(), r=r)
    return r


# ── L'INDICE SI RIALLINEA DA SOLO (29/09/2026, sera) ─────────────────────
# Dopo spostamenti, rinomine e cancellazioni l'indice restava quello della notte (cartelle che "non ci
# sono piu'", doppioni che si ripresentano). Un minuto e mezzo dopo l'ultima modifica si rileggono dalla
# NAS solo le cartelle di primo livello toccate, si aggiornano le loro righe nell'elenco e si rifa'
# l'indice (circa un minuto). Mai durante il giro di notte, che rilegge tutto.
RIPARA = {"tops": set(), "timer": None, "gira": False}
R_LOCK = threading.Lock()


def ripara_indice(vie):
    tops = {str(v).split("/")[0] for v in vie if v and not str(v).startswith(("_PROVA",))}
    if not tops: return
    with R_LOCK:
        RIPARA["tops"] |= tops
        if RIPARA["timer"]: RIPARA["timer"].cancel()
        RIPARA["timer"] = threading.Timer(90, _ripara); RIPARA["timer"].daemon = True; RIPARA["timer"].start()


def _ripara():
    if subprocess.run(["pgrep", "-f", "notte-1907.sh|elenco-1907.sh"], capture_output=True).returncode == 0:
        RIPARA["timer"] = threading.Timer(600, _ripara); RIPARA["timer"].daemon = True; RIPARA["timer"].start(); return
    with R_LOCK:
        RIPARA["timer"] = None
        if RIPARA["gira"]:
            RIPARA["timer"] = threading.Timer(120, _ripara); RIPARA["timer"].daemon = True; RIPARA["timer"].start(); return
        tops, RIPARA["tops"], RIPARA["gira"] = set(RIPARA["tops"]), set(), True
    try:
        el = os.path.join(CASA, "elenco.tsv")
        nuove = []
        for t in sorted(tops):
            if not os.path.isdir(os.path.join(R, t)): continue
            out = subprocess.run(["nice", "-n", "10", "ionice", "-c3", "find", t, "-mindepth", "1", "(", "-name", "@*", "-o", "-name", ".*", "-o", "-name", "_CESTINO COMO TV", ")",
                                  "-prune", "-o", "-type", "f", "-printf", "%s\t%T@\t%p\n"], cwd=R, capture_output=True, timeout=3600)
            nuove.append(out.stdout.decode("utf-8", "surrogateescape"))
        tmp = el + ".ripara.tmp"
        with open(el, "rb") as f, open(tmp, "wb") as g:
            pre = tuple((t + "/").encode("utf-8", "surrogateescape") for t in tops)
            for riga in f:
                parti = riga.split(b"\t", 2)
                if len(parti) == 3 and parti[2].startswith(pre): continue
                g.write(riga)
            for x in nuove: g.write(x.encode("utf-8", "surrogateescape"))
        os.replace(tmp, el)
        subprocess.run(["nice", "-n", "10", "python3", "/opt/comotv/indice-1907-da-elenco.py"], capture_output=True, timeout=1800)
    except Exception as e:
        print("[ripara] " + str(e), flush=True)
    finally:
        with R_LOCK:
            RIPARA["gira"] = False


# ── ELIMINARE UNA CLIP DALLA SUA ANTEPRIMA (Goffredo, 29/09/2026) ─────
# Solo chi puo' eliminare i doppioni (Gionata Medeot e i super utenti); un file alla volta, mai una
# cartella; definitivo (via NFS il cestino della QNAP non lo raccoglie). Registro in eliminati-a-mano.json.
ELIMINATI_MANO = os.path.join(CASA, "eliminati-a-mano.json")


def elimina_clip(p, chi):
    if not puo_eliminare(chi): return 403, {"ok": False, "errore": "Eliminare dalla NAS del club puo' solo chi e' autorizzato (Gionata Medeot)."}
    if not _nas_pronta(): return 503, {"ok": False, "errore": "La NAS del club non e' collegata in scrittura in questo momento. Riprova tra poco."}
    via = _rel(p.get("via")); pieno = os.path.join(RW, via)
    if not via or not _dentro_frame(pieno): return 400, {"ok": False, "errore": "Percorso non valido."}
    if not os.path.isfile(pieno): return 404, {"ok": False, "errore": "Il file non c'e' piu' (o e' una cartella: si eliminano solo i file)."}
    peso = os.path.getsize(pieno)
    try: os.remove(pieno)
    except OSError as e: return 500, {"ok": False, "errore": "Non riuscito: %s" % (e.strerror or e)}
    with S_LOCK:
        r = _leggi(ELIMINATI_MANO, {"voci": []})
        r["voci"].append({"via": via, "peso": peso, "chi": chi, "quando": int(time.time())}); del r["voci"][:-20000]
        _scrivi(ELIMINATI_MANO, r)
    ripara_indice([via])
    return 200, {"ok": True, "via": via, "peso": peso}


# ── I COMMENTI SUI VIDEO, COME SU FRAME.IO (Goffredo, 29/09/2026) ──────
# Un commento sta su un file (la via nel FRAME) a un secondo preciso, o su un tratto (t..fino).
# Ha le risposte, si risolve, e chi e' taggato (@nome@comofootball.com) lo ritrova in "Menzioni".
# Commenta chi apre il MAM 1907; modifica e cancella solo chi l'ha scritto (o un super utente).
# Se una cartella si sposta o si rinomina (Cartelle 1907), i commenti la seguono (_registra).
COMMENTI = os.path.join(CASA, "commenti.json")
C_LOCK = threading.Lock()
MENZ_RX = re.compile(r"@?([A-Za-z0-9._%+-]+@(?:comofootball\.com|sent\.tv))\b", re.I)


def _admin(email):
    email = (email or "").lower()
    try: return bool(json.load(open("/etc/comotv/accesso-locali.json")).get(email, {}).get("admin"))
    except Exception: return email == "goffredo.donofrio@sent.tv"


def _menzioni(testo):
    return sorted({m.lower() for m in MENZ_RX.findall(testo or "")})


def _persone_note():
    """chi si puo' taggare: chi e' gia' entrato (club e Como TV) e chi ha gia' commentato"""
    ee = set()
    try:
        for r in open("/var/lib/comotv-accesso/accessi.jsonl"):
            try: e = (json.loads(r).get("chi") or "").lower()
            except ValueError: continue
            if re.fullmatch(r"[a-z0-9._%+-]+@(comofootball\.com|sent\.tv)", e): ee.add(e)
    except OSError:
        pass
    c = _leggi(COMMENTI, {"per": {}})
    for lst in c.get("per", {}).values():
        for x in lst:
            ee.add(x.get("chi", "")); ee.update(x.get("menzioni", []))
            for y in x.get("risposte", []): ee.add(y.get("chi", "")); ee.update(y.get("menzioni", []))
    return sorted(e for e in ee if e and "@" in e)


# ── LO STATO DI REVISIONE E L'ASSEGNATO, COME SU FRAME.IO (30/09/2026) ─────
# Ogni clip (o cartella) ha uno stato (da rivedere, in lavorazione, approvata, da rifare) e, se serve, a chi
# tocca. Chi e' assegnato lo ritrova in Menzioni. Lo mette chiunque del club; resta chi e quando.
STATI = os.path.join(CASA, "stati.json")
STATI_OK = ("", "da-rivedere", "in-lavorazione", "approvata", "da-rifare")


def stati_leggi():
    return 200, {"ok": True, "stati": _leggi(STATI, {"per": {}}).get("per", {})}


def stati_scrivi(p, chi):
    chi = (chi or "").lower()
    if not chi: return 403, {"ok": False, "errore": "Per cambiare lo stato bisogna essere entrati con la propria mail."}
    via = _rel(p.get("via"))
    if not via or not os.path.realpath(os.path.join(R, via)).startswith(R + "/"): return 400, {"ok": False, "errore": "Percorso non valido."}
    with C_LOCK:
        c = _leggi(STATI, {"per": {}}); x = c.setdefault("per", {}).get(via, {})
        if "stato" in p:
            st = str(p.get("stato") or "")
            if st not in STATI_OK: return 400, {"ok": False, "errore": "Stato sconosciuto."}
            x["stato"] = st
        if "assegnato" in p:
            a = str(p.get("assegnato") or "").strip().lower()
            if a and not re.fullmatch(r"[a-z0-9._%+-]+@(comofootball\.com|sent\.tv)", a): return 400, {"ok": False, "errore": "Si assegna a un indirizzo @comofootball.com o @sent.tv."}
            if a != x.get("assegnato", ""): x["assegnato_quando"] = int(time.time()); x["assegnato_da"] = chi
            x["assegnato"] = a
        x.update(chi=chi, quando=int(time.time()))
        if not x.get("stato") and not x.get("assegnato"): c["per"].pop(via, None)
        else: c["per"][via] = x
        _scrivi(STATI, c)
    return 200, {"ok": True, "via": via, "stato": c["per"].get(via, {})}


def commenti_leggi(q, chi):
    chi = (chi or "").lower()
    c = _leggi(COMMENTI, {"per": {}, "lette": {}})
    per = c.get("per", {})
    if (q.get("conti") or [""])[0]:
        return 200, {"ok": True, "elimina": puo_eliminare(chi), "conti": {v: [len(l), sum(1 for x in l if not x.get("risolto"))] for v, l in per.items() if l}}
    if (q.get("menzioni") or [""])[0]:
        lette = set(c.get("lette", {}).get(chi, [])); fuori = []
        for v, lst in per.items():
            for x in lst:
                for y in [x] + x.get("risposte", []):
                    if chi and chi in y.get("menzioni", []):
                        fuori.append({"via": v, "id": x["id"], "rid": y["id"], "chi": y["chi"], "quando": y["quando"], "testo": y["testo"][:300],
                                      "t": x.get("t", 0), "letta": y["id"] in lette, "risolto": bool(x.get("risolto"))})
        for v, x in _leggi(STATI, {"per": {}}).get("per", {}).items():
            if chi and x.get("assegnato") == chi:
                rid = "a" + hashlib.sha1((v + str(x.get("assegnato_quando", 0))).encode()).hexdigest()[:10]
                fuori.append({"via": v, "id": "", "rid": rid, "chi": x.get("assegnato_da", ""), "quando": x.get("assegnato_quando", 0), "testo": "ti ha assegnato questa clip" + (" · stato: " + x["stato"].replace("-", " ") if x.get("stato") else ""),
                              "t": 0, "letta": rid in lette, "risolto": x.get("stato") == "approvata", "assegnata": True})
        fuori.sort(key=lambda z: -z["quando"])
        return 200, {"ok": True, "menzioni": fuori[:300], "nuove": sum(1 for z in fuori if not z["letta"])}
    v = _rel((q.get("v") or [""])[0])
    return 200, {"ok": True, "via": v, "commenti": per.get(v, []), "io": chi, "persone": _persone_note(), "admin": _admin(chi), "elimina": puo_eliminare(chi)}


def commenti_scrivi(p, chi):
    chi = (chi or "").lower()
    if not chi: return 403, {"ok": False, "errore": "Per commentare bisogna essere entrati con la propria mail."}
    az, via = p.get("azione"), _rel(p.get("via"))
    testo = str(p.get("testo") or "").strip()[:4000]
    ora = int(time.time())
    with C_LOCK:
        c = _leggi(COMMENTI, {"per": {}, "lette": {}})
        if az == "letta":
            ids = [str(x) for x in (p.get("ids") or [])][:500]
            l = c.setdefault("lette", {}).setdefault(chi, [])
            for i in ids:
                if i not in l: l.append(i)
            del l[:-3000]; _scrivi(COMMENTI, c)
            return 200, {"ok": True}
        if not via or not os.path.realpath(os.path.join(R, via)).startswith(R + "/"): return 400, {"ok": False, "errore": "File non valido."}
        lst = c.setdefault("per", {}).setdefault(via, [])
        x = next((k for k in lst if k["id"] == p.get("id")), None)
        if az == "nuovo":
            if not testo: return 400, {"ok": False, "errore": "Il commento e' vuoto."}
            try: t = max(0.0, round(float(p.get("t") or 0), 2))
            except (TypeError, ValueError): t = 0.0
            fino = p.get("fino")
            try: fino = round(float(fino), 2) if fino not in (None, "") else None
            except (TypeError, ValueError): fino = None
            if fino is not None and fino <= t: fino = None
            x = {"id": "c" + secrets.token_hex(5), "chi": chi, "quando": ora, "t": t, "fino": fino, "testo": testo,
                 "menzioni": _menzioni(testo), "risposte": [], "risolto": None}
            lst.append(x); lst.sort(key=lambda k: (k.get("t", 0), k["quando"]))
        elif not x:
            return 404, {"ok": False, "errore": "Il commento non c'e' piu'."}
        elif az == "risposta":
            if not testo: return 400, {"ok": False, "errore": "La risposta e' vuota."}
            x.setdefault("risposte", []).append({"id": "r" + secrets.token_hex(5), "chi": chi, "quando": ora, "testo": testo, "menzioni": _menzioni(testo)})
        elif az in ("risolvi", "riapri"):
            x["risolto"] = {"chi": chi, "quando": ora} if az == "risolvi" else None
        elif az in ("modifica", "cancella"):
            rid = p.get("rid"); y = next((k for k in x.get("risposte", []) if k["id"] == rid), None) if rid else x
            if not y: return 404, {"ok": False, "errore": "Non c'e' piu'."}
            if y["chi"] != chi and not _admin(chi): return 403, {"ok": False, "errore": "Si modifica e si cancella solo quello che si e' scritto."}
            if az == "modifica":
                if not testo: return 400, {"ok": False, "errore": "Il testo e' vuoto."}
                y.update(testo=testo, menzioni=_menzioni(testo), modificato=ora)
            elif rid: x["risposte"] = [k for k in x["risposte"] if k["id"] != rid]
            else: lst[:] = [k for k in lst if k["id"] != x["id"]]
        else:
            return 400, {"ok": False, "errore": "azione sconosciuta"}
        if not lst: c["per"].pop(via, None)
        _scrivi(COMMENTI, c)
        return 200, {"ok": True, "via": via, "commenti": c["per"].get(via, [])}


def commenti_segui(da, a):
    """una cartella o un file spostato: i commenti (e gli stati) vanno col nuovo percorso"""
    with C_LOCK:
        st = _leggi(STATI, {"per": {}}); ps = st.get("per", {}); cam = False
        for v in list(ps):
            if v == da or v.startswith(da + "/"): ps[a + v[len(da):]] = ps.pop(v); cam = True
        if cam: _scrivi(STATI, st)
        c = _leggi(COMMENTI, {"per": {}}); per = c.get("per", {}); cambiato = False
        for v in list(per):
            if v == da or v.startswith(da + "/"):
                per[a + v[len(da):]] = per.pop(v); cambiato = True
        if cambiato: _scrivi(COMMENTI, c)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def rispondi(self, codice, corpo, tipo="application/json; charset=utf-8", extra=None):
        b = corpo if isinstance(corpo, bytes) else json.dumps(corpo, ensure_ascii=False).encode()
        self.send_response(codice); self.send_header("Content-Type", tipo); self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)

    def do_POST(self):
        via = urllib.parse.urlparse(self.path).path
        if via not in ("/premiere", "/volti", "/doppioni", "/cartelle", "/commenti", "/elimina-clip", "/stati"): return self.rispondi(404, {"ok": False})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            p = json.loads(self.rfile.read(min(n, 2_000_000)) or b"{}")
        except Exception:
            return self.rispondi(400, {"ok": False, "errore": "richiesta non valida"})
        if via == "/volti":
            cod, r = battezza(p, str(self.headers.get("X-Utente") or ""))
            return self.rispondi(cod, r)
        if via == "/stati":
            cod, r = stati_scrivi(p, str(self.headers.get("X-Utente") or ""))
            return self.rispondi(cod, r)
        if via == "/elimina-clip":
            cod, r = elimina_clip(p, str(self.headers.get("X-Utente") or ""))
            return self.rispondi(cod, r)
        if via == "/commenti":
            cod, r = commenti_scrivi(p, str(self.headers.get("X-Utente") or ""))
            return self.rispondi(cod, r)
        if via == "/cartelle":
            cod, r = organizza(p, str(self.headers.get("X-Utente") or ""))
            return self.rispondi(cod, r)
        if via == "/doppioni":
            chi = str(self.headers.get("X-Utente") or "")
            if p.get("azione") == "elimina": cod, r = elimina(p, chi)
            else: cod, r = segna(p, chi)
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
        if u.path == "/cartelle":
            c = cartella((q.get("v") or [""])[0])
            if c is None: return self.rispondi(404, {"ok": False, "errore": "cartella non trovata"})
            c.update(ok=True, puoi=puo_segnare(self.headers.get("X-Utente") or ""))
            return self.rispondi(200, c, extra={"Cache-Control": "no-store"})
        if u.path == "/doppioni":
            s = _leggi(SEGNATI, {"segnati": {}})
            stato = controlla_segnati(); s = _leggi(SEGNATI, {"segnati": {}}); chi = self.headers.get("X-Utente") or ""
            c = _leggi(ELIMINATI, {"voci": {}})
            return self.rispondi(200, {"ok": True, "segnati": s.get("segnati", {}), "stato": stato, "eliminati": c.get("voci", {}),
                                       "puoi": puo_segnare(chi), "elimina": puo_eliminare(chi)}, extra={"Cache-Control": "no-store"})
        if u.path == "/stati":
            cod, r = stati_leggi()
            return self.rispondi(cod, r, extra={"Cache-Control": "no-store"})
        if u.path == "/commenti":
            cod, r = commenti_leggi(q, self.headers.get("X-Utente") or "")
            return self.rispondi(cod, r, extra={"Cache-Control": "no-store"})
        if u.path == "/code":
            with LOCK:
                return self.rispondi(200, {"ok": True, "coda": [dict(STATO[k], pieno=None) for k in CODA]})
        return self.rispondi(404, {"ok": False})


if __name__ == "__main__":
    os.makedirs(MINI, exist_ok=True); os.makedirs(COPIE, exist_ok=True); os.makedirs(PROVINI, exist_ok=True)
    threading.Thread(target=lavora, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 8097), H).serve_forever()
