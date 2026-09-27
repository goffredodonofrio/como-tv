#!/usr/bin/env python3
"""
COPIE-NOTTE-1907 — di notte, le copie leggere dei video che il browser non legge.
(Goffredo, 27/09/2026: "le copie leggere di notte, per priorita', che finiscano prima del mattino")

Meta' dei video del FRAME (H.264 4:2:2 10 bit, HEVC, ProRes) Chrome non li apre: di giorno la
pagina chiede la copia e si aspetta. Di notte si portano avanti le piu' probabili:
  1. i video delle raccolte 1907 (qualcuno li ha scelti: li guardera' e li montera')
  2. i servizi piu' recenti per data delle riprese, prima partite, interviste, conferenze,
     nuovi acquisti; un video alla volta, i lunghi (oltre 20 minuti) solo se in raccolta
Stessa copia che fa servizio-1907 (720p H.264, stessa chiave, stessa cartella): la pagina
la trova gia' pronta.

Si ferma all'ora data (--fino, default 05:15) o allo spazio (--spazio, GB delle copie fatte
di notte, default 12; e comunque se sul disco restano meno di 8 GB liberi): quando lo spazio finisce si tolgono le copie notturne meno utili (le
riprese piu' vecchie, mai quelle delle raccolte) per fare posto alle piu' recenti. Sono copie
rifacibili: l'originale resta sulla NAS. Mai durante una diretta. Legge soltanto la NAS.

  python3 copie-notte-1907.py --fino 05:15 --spazio 12
"""
import argparse, datetime, hashlib, json, os, shutil, subprocess, time, urllib.request

R = "/mnt/qnap100-frame"
CASA = "/var/lib/comotv-1907"
COPIE = os.path.join(CASA, "proxy")
NOTTE = os.path.join(CASA, "copie-notte.json")      # {chiave: {v, peso, data, racc}}: le copie fatte qui
LEGGIBILI = os.path.join(CASA, "leggibili.json")     # {percorso: 1 se il browser lo apre, 0 se no}
RACCOLTE = ["/var/lib/comotv/clip/raccolte-1907.json", "/var/lib/comotv-dev/clip/raccolte-1907.json"]
VIDEO = (".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".webm")
PRIMA = {"Partita": 0, "Intervista": 0, "Conferenza stampa": 0, "Nuovo acquisto": 0, "Backstage": 1, "Allenamento": 1, "Evento": 1}
LUNGO = 20 * 60
LIBERO = 8e9          # sul disco della VM (35 GB liberi il 28/09/2026) ci sono anche il MAM e gli export


def chiave(p): return hashlib.sha1(p.encode()).hexdigest()[:16]


def in_diretta():
    try:
        req = urllib.request.Request("http://127.0.0.1:8080/api", data=json.dumps({"tipo": "clip-stato"}).encode(), headers={"Content-Type": "text/plain"})
        return any(r.get("stato") == "registra" and not r.get("guarda") for r in json.load(urllib.request.urlopen(req, timeout=8)).get("reg", []))
    except Exception:
        return False


def leggi(f, d):
    try: return json.load(open(f))
    except Exception: return d


def scrivi(f, x):
    tmp = f + ".tmp"; json.dump(x, open(tmp, "w"), ensure_ascii=False); os.replace(tmp, f)


def sonda(pieno):
    """(il browser lo apre?, durata): lo stesso criterio del ponte (H.264 8 bit 4:2:0)"""
    try:
        o = json.loads(subprocess.run(["nice", "-n", "19", "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                       "stream=codec_name,pix_fmt:format=duration", "-of", "json", pieno], capture_output=True, text=True, timeout=60).stdout or "{}")
    except Exception:
        return None, 0
    s = (o.get("streams") or [{}])[0]
    d = float((o.get("format") or {}).get("duration") or 0)
    if not s.get("codec_name"): return None, d
    return (s.get("codec_name") == "h264" and s.get("pix_fmt") in ("yuv420p", "yuvj420p")), d


def candidati(file_per_cartella):
    """[(percorso, in raccolta, data)] in ordine di priorita'"""
    fuori, visti = [], set()
    def metti(v, racc, data):
        if v in visti or not v.lower().endswith(VIDEO) or "prox" in v.lower(): return
        visti.add(v); fuori.append((v, racc, data))
    for f in RACCOLTE:
        for r in leggi(f, {}).values():
            for x in r.get("file", []):
                v = x.get("via", "")
                if x.get("cartella"):
                    for d, fs in file_per_cartella.items():
                        if d == v or d.startswith(v + "/"):
                            for nome in fs[:200]: metti(d + "/" + nome, True, 0)
                else:
                    metti(v, True, 0)
    ind = leggi(os.path.join(CASA, "pub", "indice.json"), {})
    md = {r[0]: r for r in ind.get("cartelle", [])}
    cart = []
    for d, r in md.items():
        if not r[1] or not r[4]: continue            # senza data o senza video
        g = (r[8] or {}).get("g", [])
        cart.append((-(r[1]), min([PRIMA.get(x, 2) for x in g] or [2]), d))
    # per mese di ripresa, dal piu' recente; nello stesso mese prima i tipi che servono di piu'
    cart.sort(key=lambda x: (x[0] // 100, x[1], x[0]))
    for data, _, d in cart:
        for nome in file_per_cartella.get(d, []): metti(d + "/" + nome, False, -data)
    return fuori


def pulisci(notte, spazio, per_fare):
    """se le copie notturne superano lo spazio, via le meno utili (riprese piu' vecchie, mai in raccolta)"""
    tot = sum(x.get("peso", 0) for x in notte.values())
    if tot + per_fare <= spazio: return True
    for k, x in sorted(notte.items(), key=lambda kv: (kv[1].get("racc", False), kv[1].get("data", 0))):
        if tot + per_fare <= spazio: break
        if x.get("racc"): return False
        try: os.remove(os.path.join(COPIE, k + ".mp4"))
        except OSError: pass
        tot -= x.get("peso", 0); notte.pop(k)
    return tot + per_fare <= spazio


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--fino", default="05:15")
    a.add_argument("--spazio", type=float, default=12)
    a.add_argument("--quanti", type=int, default=0, help="al massimo tante copie (per provare)")
    x = a.parse_args()
    os.nice(15)
    hh, mm = map(int, x.fino.split(":"))
    ora = datetime.datetime.now(); fine = ora.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if fine <= ora: fine += datetime.timedelta(days=1)
    fine = fine.timestamp(); spazio = x.spazio * 1e9
    fpc = {}
    for d, fs in leggi(os.path.join(CASA, "pub", "file.json"), []):
        fpc[d] = [f[0] for f in fs if f[0].lower().endswith(VIDEO)]
    notte = leggi(NOTTE, {}); legg = leggi(LEGGIBILI, {})
    fatte = saltate = 0; t0 = time.time()
    for v, racc, data in candidati(fpc):
        if time.time() > fine or (x.quanti and fatte >= x.quanti): break
        k = chiave(v); dest = os.path.join(COPIE, k + ".mp4")
        if os.path.exists(dest):
            if k in notte and racc: notte[k]["racc"] = True
            continue
        if legg.get(v) == 1: continue
        while in_diretta(): time.sleep(300)
        pieno = os.path.join(R, v)
        ok, d = sonda(pieno)
        if ok is None: continue
        legg[v] = 1 if ok else 0
        if ok: continue
        if d > LUNGO and not racc: saltate += 1; continue
        # una copia 720p ultrafast pesa circa 0,6 MB al secondo; non si comincia se non finisce in tempo
        if time.time() + max(60, d * 2.5) > fine: saltate += 1; continue
        if not pulisci(notte, spazio, d * 0.6e6): print("spazio finito"); break
        if shutil.disk_usage(COPIE).free - d * 0.6e6 < LIBERO: print("disco quasi pieno: mi fermo"); break
        tmp = dest + ".notte.mp4"
        cmd = ["nice", "-n", "19", "ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "2", "-i", pieno,
               "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:720:flags=fast_bilinear,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
               "-crf", "25", "-g", "25", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", tmp]
        pr = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        while pr.poll() is None:
            time.sleep(5)
            if time.time() > fine + 600 or in_diretta(): pr.kill(); pr.wait(); break
        if pr.returncode == 0 and os.path.exists(tmp):
            os.replace(tmp, dest)
            notte[k] = {"v": v, "peso": os.path.getsize(dest), "data": data, "racc": racc, "fatta": int(time.time())}
            fatte += 1
            if fatte % 10 == 0: scrivi(NOTTE, notte); scrivi(LEGGIBILI, legg)
        else:
            try: os.remove(tmp)
            except OSError: pass
    scrivi(NOTTE, notte); scrivi(LEGGIBILI, legg)
    print("copie di notte: %d fatte in %d min, %d saltate (lunghe o fuori tempo), %.1f GB in tutto" %
          (fatte, (time.time() - t0) / 60, saltate, sum(x["peso"] for x in notte.values()) / 1e9))


if __name__ == "__main__":
    main()
