#!/usr/bin/env python3
"""
COPERTINE-1907 — una copertina per ogni collezione ed episodio del MAM Como 1907.
(Goffredo, 27/09/2026)

Invece di una miniatura per ciascuno dei ~279.000 file, una copertina verticale
(600x900, lo stile delle copertine Como TV) per ogni cartella di primo livello
(collezione) e di secondo livello (episodio):
 - se in "COMO TV - THUMBNAILS" c'e' la copertina ufficiale dell'episodio, si usa quella;
 - se no si estrae un fotogramma da un video dell'episodio: la copertina la
   compone poi la pagina modello (render fatto fuori, vedi copertine-render.js).
Scrive in /var/lib/comotv-1907/pub/copertine/: <chiave>.jpg (copertine pronte),
src/<chiave>.jpg (fotogrammi da comporre), copertine.json (l'elenco).
Legge SOLO dalla QNAP (sola lettura). Bassa priorita'.
"""
import hashlib, json, os, re, subprocess, time, urllib.request

R = "/mnt/qnap100-frame"
OUT = "/var/lib/comotv-1907/pub/copertine"
SRC = os.path.join(OUT, "src")
THUMBS = os.path.join(R, "COMO TV - THUMBNAILS")
VIDEO = (".mp4", ".mov", ".mxf", ".m4v", ".mts")

FORMATI = [  # (parola nella cartella, etichetta, prefisso da togliere dal titolo)
    ("discover como international", "Discover Como International", r"^discover como international\s*-\s*"),
    ("discover como", "Discover Como", r"^discover como\s*-\s*"),
    ("behind the team", "Behind The Team", r"^behind the team\s*-\s*"),
    ("taste of como", "Taste of Como", r"^taste of como\s*-\s*"),
    ("inside sinigaglia", "Inside Sinigaglia", r"^inside sinigaglia\s*-\s*"),
    ("como legends", "Como Legends", r"^como legends\s*-\s*"),
    ("tourism", "Tourism", r"^"),
    ("match day", "Match Day", r"^"),
    ("b roll", "B-roll", r"^"),
    ("fan stories", "Fan Stories", r"^"),
    ("hospitality", "Hospitality", r"^"),
    ("drone", "Drone", r"^"),
    ("academy", "Academy", r"^"),
    ("fabregas", "Documentary", r"^"),
    ("cesc", "Documentary", r"^"),
    ("season", "Season", r"^"),
    ("pre-season", "Pre-season", r"^"),
    ("como cup", "Como Cup", r"^"),
    ("summer camp", "Summer Camp", r"^"),
    ("ghana", "Behind The Team", r"^"),
]


def in_diretta():
    try:
        req = urllib.request.Request("http://127.0.0.1:8080/api", data=json.dumps({"tipo": "clip-stato"}).encode(), headers={"Content-Type": "text/plain"})
        return any(r.get("stato") == "registra" and not r.get("guarda") for r in json.load(urllib.request.urlopen(req, timeout=8)).get("reg", []))
    except Exception:
        return False


def chiave(p): return hashlib.sha1(p.encode()).hexdigest()[:16]
def norm(s): return re.sub(r"[^a-z0-9]", "", s.lower())


def formato(collezione, episodio=""):
    t = (collezione + " " + episodio).lower().replace("footgae", "footage")
    for parola, etichetta, _ in FORMATI:
        if parola in t: return etichetta
    return "Como 1907"


def titolo_di(nome, collezione):
    n = re.sub(r"^como tv\s*-?\s*", "", nome.strip(), flags=re.I)
    for _, _, pref in FORMATI:
        if pref != "^": n = re.sub(pref, "", n, flags=re.I)
    sotto = ""
    m = re.search(r"\s+with\s+(.+)$", n, flags=re.I)
    if m: sotto, n = "with " + m.group(1).strip(), n[:m.start()].strip()
    return n.strip(" -"), sotto


def ufficiali():
    """copertine ufficiali: cartella in THUMBNAILS -> file verticale 600x900 (o il piu' simile)"""
    out = {}
    try: cartelle = os.listdir(THUMBS)
    except OSError: return out
    for c in cartelle:
        d = os.path.join(THUMBS, c)
        if not os.path.isdir(d): continue
        fs = [f for f in os.listdir(d) if f.lower().endswith((".png", ".jpg", ".jpeg"))]
        scelta = next((f for f in fs if "600x900" in f), None) or next((f for f in fs if "4-5" in f), None) or (fs[0] if fs else None)
        if scelta: out[norm(titolo_di(c.split("-", 1)[-1] if "-" in c else c, "")[0])] = os.path.join(d, scelta)
    return out


def un_video(cartella, quanti=30):
    trovati = []
    for d, ds, fs in os.walk(cartella):
        ds[:] = sorted(x for x in ds if not x.startswith((".", "@")))
        for f in sorted(fs):
            if f.lower().endswith(VIDEO) and not f.startswith("."):
                p = os.path.join(d, f)
                try:
                    if os.path.getsize(p) > 20e6: trovati.append(p)
                except OSError: pass
            if len(trovati) >= quanti: break
        if len(trovati) >= quanti: break
    return trovati[len(trovati) // 2] if trovati else None


def fotogramma(video, dest):
    try:
        d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                                 capture_output=True, text=True, timeout=60).stdout.strip() or 0)
    except Exception:
        d = 0
    at = str(max(1.0, d * 0.35))
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", at, "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", dest],
                   capture_output=True, timeout=120)
    return os.path.exists(dest)


def main():
    os.makedirs(SRC, exist_ok=True)
    uff = ufficiali()
    voci = []
    for c in sorted(os.listdir(R)):
        pc = os.path.join(R, c)
        if c.startswith((".", "@")) or not os.path.isdir(pc) or c == "COMO TV - THUMBNAILS": continue
        livelli = [(c, c, "", 1)]
        for e in sorted(os.listdir(pc)):
            if not e.startswith((".", "@")) and os.path.isdir(os.path.join(pc, e)):
                livelli.append((c + "/" + e, c, e, 2))
        for rel, coll, ep, liv in livelli:
            k = chiave(rel)
            t, sotto = titolo_di(ep or coll, coll)
            v = {"p": rel, "k": k, "liv": liv, "titolo": t, "sotto": sotto, "formato": formato(coll, ep)}
            fatto = os.path.join(OUT, k + ".jpg")
            if os.path.exists(fatto):
                v["pronta"] = 1
            else:
                o = uff.get(norm(t)) if liv == 2 else None
                if o:
                    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", o, "-vf", "scale=600:900:force_original_aspect_ratio=increase,crop=600:900", "-q:v", "3", fatto], capture_output=True, timeout=60)
                    if os.path.exists(fatto): v["pronta"] = 1; v["ufficiale"] = 1
                while in_diretta(): print("  diretta: pausa 5 minuti", flush=True); time.sleep(300)
                if not v.get("pronta") and not os.path.exists(os.path.join(SRC, k + ".jpg")):
                    vid = un_video(os.path.join(R, rel))
                    if vid: fotogramma(vid, os.path.join(SRC, k + ".jpg"))
                v["src"] = int(os.path.exists(os.path.join(SRC, k + ".jpg")))
            voci.append(v)
            print(("  ok " if v.get("pronta") else "  -- ") + rel + (" (ufficiale)" if v.get("ufficiale") else ""), flush=True)
    json.dump({"copertine": voci}, open(os.path.join(OUT, "copertine.json"), "w"), ensure_ascii=False)
    print("copertine: %d voci, %d pronte, %d da comporre" % (len(voci), sum(1 for v in voci if v.get("pronta")), sum(1 for v in voci if not v.get("pronta") and v.get("src"))))


if __name__ == "__main__":
    main()
