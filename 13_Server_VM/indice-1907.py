#!/usr/bin/env python3
"""
INDICE-1907 — il materiale del club (QNAP "COMOTV - FRAME") per la pagina MAM Como 1907.
(Goffredo, 27/09/2026)

Non e' un archivio di partite: niente ESPN, niente azioni. Si elencano le
cartelle cosi' come sono, e per ogni file si ricava quello che serve a
guardarlo: durata, formato, se il browser lo sa leggere, una miniatura.

- Legge SOLO da /mnt/qnap100-frame (montata in sola lettura).
- Scrive in /var/lib/comotv-1907: cache.json (lavoro gia' fatto) e pub/
  (indice.json + miniature), servita da nginx su /como-tv/mam-1907/indice/.
- Gira con nice/ionice al minimo e si mette in pausa se la produzione sta
  registrando una diretta (clip-stato del ponte).
- Si puo' rilanciare quando si vuole: rifa' solo i file nuovi o cambiati.
"""
import hashlib, json, os, subprocess, sys, time, urllib.request

RADICE = "/mnt/qnap100-frame"
CASA = "/var/lib/comotv-1907"
PUB = os.path.join(CASA, "pub")
MINI = os.path.join(PUB, "mini")
CACHE = os.path.join(CASA, "cache.json")
PONTE = "http://127.0.0.1:8080/api"
VIDEO = {".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".webm"}
FOTO = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff", ".cr2", ".cr3", ".arw", ".nef", ".dng", ".psd"}
AUDIO = {".wav", ".mp3", ".aac", ".m4a"}
LIMITE_GIRO = int(os.environ.get("LIMITE", "0") or 0)   # quanti file nuovi elaborare in un giro (0 = tutti)
SOLO_ELENCO = os.environ.get("ELENCO") == "1"          # primo giro veloce: solo nomi, pesi e date


def tipo(ext):
    return "video" if ext in VIDEO else "foto" if ext in FOTO else "audio" if ext in AUDIO else "altro"


def in_diretta():
    try:
        req = urllib.request.Request(PONTE, data=json.dumps({"tipo": "clip-stato"}).encode(), headers={"Content-Type": "text/plain"})
        d = json.load(urllib.request.urlopen(req, timeout=8))
        return any(r.get("stato") == "registra" and not r.get("guarda") for r in d.get("reg", []))
    except Exception:
        return False


def aspetta_se_diretta():
    while in_diretta():
        print("  diretta in registrazione: pausa 5 minuti", flush=True)
        time.sleep(300)


def sonda(p):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                              "format=duration:stream=codec_type,codec_name,pix_fmt,width,height",
                              "-of", "json", p], capture_output=True, text=True, timeout=60).stdout
        j = json.loads(out or "{}")
    except Exception:
        return {}
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), {})
    a = any(s.get("codec_type") == "audio" for s in j.get("streams", []))
    dur = float((j.get("format") or {}).get("duration") or 0)
    codec, pix = v.get("codec_name", ""), v.get("pix_fmt", "")
    # il browser legge h264/hevc/vp9/av1 a 8 bit 4:2:0; le originali di camera (10 bit, 4:2:2) no
    leggibile = codec in ("h264", "hevc", "vp9", "av1") and pix in ("yuv420p", "yuvj420p")
    return {"d": round(dur, 1), "c": codec, "px": pix, "w": v.get("width"), "h": v.get("height"), "a": a, "ok": leggibile}


def miniatura(p, dest, t, dur):
    at = "0" if t == "foto" else str(min(3.0, max(0.0, dur * 0.1)))
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y"] + ([] if t == "foto" else ["-ss", at]) + \
          ["-i", p, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", dest]
    try:
        subprocess.run(cmd, capture_output=True, timeout=90)
    except Exception:
        pass
    return os.path.exists(dest)


def main():
    os.makedirs(MINI, exist_ok=True)
    cache = {}
    if os.path.exists(CACHE):
        try: cache = json.load(open(CACHE))
        except Exception: cache = {}
    voci, nuovi, fatti = [], 0, 0
    for d, ds, fs in os.walk(RADICE):
        ds[:] = sorted(x for x in ds if not x.startswith("@") and not x.startswith("."))
        rel_d = os.path.relpath(d, RADICE)
        for f in sorted(fs):
            if f.startswith(".") or f.lower().endswith((".log", ".ds_store", ".xml", ".xmp", ".bim", ".cpi", ".bdm", ".mpl", ".thm", ".ppn", ".ctg")):
                continue
            p = os.path.join(d, f)
            try: st = os.stat(p)
            except OSError: continue
            rel = f if rel_d == "." else os.path.join(rel_d, f)
            ext = os.path.splitext(f)[1].lower()
            t = tipo(ext)
            chiave = hashlib.sha1(rel.encode()).hexdigest()[:16]
            firma = "%d-%d" % (st.st_size, int(st.st_mtime))
            voce = {"p": rel, "s": st.st_size, "m": int(st.st_mtime), "t": t, "k": chiave}
            c = cache.get(rel)
            if c and c.get("firma") == firma:
                voce.update(c.get("info", {}))
            elif t in ("video", "foto") and not SOLO_ELENCO and (not LIMITE_GIRO or nuovi < LIMITE_GIRO):
                if fatti % 25 == 0: aspetta_se_diretta()
                info = sonda(p) if t == "video" else {}
                dest = os.path.join(MINI, chiave + ".jpg")
                if miniatura(p, dest, t, info.get("d", 0)): info["mi"] = 1
                cache[rel] = {"firma": firma, "info": info}
                voce.update(info); nuovi += 1; fatti += 1
                if fatti % 50 == 0:
                    json.dump(cache, open(CACHE, "w")); print("  %d file elaborati" % fatti, flush=True)
            voci.append(voce)
    json.dump(cache, open(CACHE, "w"))
    # le collezioni: le cartelle di primo livello
    coll = {}
    for v in voci:
        top = v["p"].split(os.sep)[0] if os.sep in v["p"] else "(senza cartella)"
        c = coll.setdefault(top, {"n": top, "file": 0, "peso": 0, "video": 0, "foto": 0, "durata": 0, "mini": None, "ultima": 0})
        c["file"] += 1; c["peso"] += v["s"]; c["ultima"] = max(c["ultima"], v["m"])
        if v["t"] in ("video", "foto"): c[v["t"]] += 1
        c["durata"] += v.get("d", 0) or 0
        if not c["mini"] and v.get("mi"): c["mini"] = v["k"]
    indice = {"aggiornato": int(time.time()), "file": len(voci), "peso": sum(v["s"] for v in voci),
              "collezioni": sorted(coll.values(), key=lambda c: -c["ultima"]), "voci": voci}
    tmp = os.path.join(PUB, "indice.json.tmp")
    json.dump(indice, open(tmp, "w"), separators=(",", ":"))
    os.replace(tmp, os.path.join(PUB, "indice.json"))
    print("indice: %d file, %d collezioni, %d elaborati in questo giro" % (len(voci), len(coll), fatti), flush=True)


if __name__ == "__main__":
    main()
