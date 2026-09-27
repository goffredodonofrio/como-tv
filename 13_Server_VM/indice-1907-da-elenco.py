#!/usr/bin/env python3
"""
Costruisce l'indice del MAM Como 1907 dall'elenco veloce (elenco-1907.sh).
(Goffredo, 27/09/2026)

Due file, perche' i file sono ~279.000:
 - pub/indice.json : collezioni, episodi e CARTELLE con data e stagione (si carica subito)
 - pub/file.json   : i file raggruppati per cartella [[cartella, [[nome, byte, mtime, data?], ...]], ...]
                     (si carica quando si cerca o si apre una cartella; nginx lo comprime)

LE DATE. Quella dei file sulla NAS NON e' la data delle riprese: e' il giorno
della copia (luglio-settembre 2026 per tutti). La data vera si prende, in
quest'ordine:
  1. dal nome della cartella, dalla piu' vicina alla piu' lontana
     ("2024-11-13", "TRAINING 12-12-2024", "05_March_2025", "Marbella_2025-03");
  2. dall'orologio della camera (date-1907.json, fatto da date-1907.py: la
     prima e l'ultima ripresa di ogni cartella), se non contraddice la stagione;
  3. dal nome dei file (DJI_20250603..., IMG_20241113...);
  4. se no resta la stagione, quando il percorso la dice ("2024-2025 Season",
     "Pre-season 26-27").
Una data e' AAAAMMGG; con GG=00 vale il mese intero.
"""
import json, os, re, sys, time, collections

CASA = "/var/lib/comotv-1907"
PUB = os.path.join(CASA, "pub")
VIDEO = (".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".webm")
FOTO = (".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff", ".cr2", ".cr3", ".arw", ".nef", ".dng", ".psd")
SCARTA = (".log", ".ds_store", ".xml", ".xmp", ".bim", ".cpi", ".bdm", ".mpl", ".thm", ".ppn", ".ctg", ".lrv", ".ini", ".db")
NASCOSTE = {"COMO TV - THUMBNAILS"}
OGGI = int(time.strftime("%Y%m%d"))
MESI = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
MESI.update({"gen": 1, "mag": 5, "giu": 6, "lug": 7, "ago": 8, "set": 9, "ott": 10, "dic": 12})

R_YMD = re.compile(r"(?<!\d)(20[12]\d)[-_. ]?(0[1-9]|1[0-2])[-_. ]?(0[1-9]|[12]\d|3[01])")
R_YMD2 = re.compile(r"(?<!\d)(20[12]\d)[-_.](0?[1-9]|1[0-2])[-_.](0?[1-9]|[12]\d|3[01])(?!\d)")
R_DMY = re.compile(r"(?<!\d)(0?[1-9]|[12]\d|3[01])[-_. ](0?[1-9]|1[0-2])[-_. ](20[12]\d)(?!\d)")
R_DNY = re.compile(r"(?<!\d)(0?[1-9]|[12]\d|3[01])[-_ ]+([A-Za-z]{3,9})[-_ ,]+(20[12]\d)(?!\d)")
R_YM = re.compile(r"(?<!\d)(20[12]\d)[-_](0[1-9]|1[0-2])(?!\d)")
R_STAG = re.compile(r"(?<!\d)(20[12]\d)\s*[-/_ ]\s*(?:20)?(\d\d)(?!\d)")
R_STAG2 = re.compile(r"(?<!\d)([12]\d)\s*[-/]\s*([12]\d)(?!\d)")


def valida(a, m, g):
    d = a * 10000 + m * 100 + g
    return d if 20150000 < d <= OGGI else 0


def data_in(t):
    for x in R_YMD.finditer(t):
        d = valida(int(x.group(1)), int(x.group(2)), int(x.group(3)))
        if d: return d
    for x in R_YMD2.finditer(t):
        d = valida(int(x.group(1)), int(x.group(2)), int(x.group(3)))
        if d: return d
    for x in R_DMY.finditer(t):
        d = valida(int(x.group(3)), int(x.group(2)), int(x.group(1)))
        if d: return d
    for x in R_DNY.finditer(t):
        m = MESI.get(x.group(2)[:3].lower())
        if m:
            d = valida(int(x.group(3)), m, int(x.group(1)))
            if d: return d
    for x in R_YM.finditer(t):
        d = valida(int(x.group(1)), int(x.group(2)), 0)
        if d: return d
    return 0


def stagione_in(percorso):
    # la cartella piu' vicina vince: "Pre-season 26-27/.../COMO ALESSANDRIA 2020 21" e' 2020/21
    for pezzo in reversed(percorso.split("/")):
        for x in R_STAG.finditer(pezzo):
            a, b = int(x.group(1)), int(x.group(2))
            if b == (a + 1) % 100: return "%d/%02d" % (a, b)
        for x in R_STAG2.finditer(pezzo):
            a, b = int(x.group(1)), int(x.group(2))
            if b == a + 1: return "20%02d/%02d" % (a, b)
    return ""


def stagione_di(d):
    a, m = d // 10000, (d // 100) % 100
    if not m: return ""
    return "%d/%02d" % (a, (a + 1) % 100) if m >= 7 else "%d/%02d" % (a - 1, a % 100)


def tipo(n):
    n = n.lower()
    return "video" if n.endswith(VIDEO) else "foto" if n.endswith(FOTO) else "altro"


def main():
    cartelle = collections.defaultdict(list)
    conta = {}
    def somma(chiave, liv, s, m, t):
        c = conta.setdefault(chiave, {"p": chiave, "liv": liv, "file": 0, "peso": 0, "video": 0, "foto": 0, "ultima": 0})
        c["file"] += 1; c["peso"] += s; c["ultima"] = max(c["ultima"], m)
        if t in ("video", "foto"): c[t] += 1
    # con un argomento si legge un elenco parziale (quello ancora in scrittura): l'indice lo dice
    elenco = sys.argv[1] if len(sys.argv) > 1 else os.path.join(CASA, "elenco.tsv")
    for riga in open(elenco, encoding="utf-8", errors="replace"):
        try: s, m, p = riga.rstrip("\n").split("\t", 2)
        except ValueError: continue
        nome = p.rsplit("/", 1)[-1]
        if nome.lower().endswith(SCARTA) or nome.startswith("."): continue
        parti = p.split("/")
        if parti[0] in NASCOSTE: continue
        s, m = int(s), int(float(m))
        d = "/".join(parti[:-1])
        cartelle[d].append([nome, s, m, data_in(nome.rsplit(".", 1)[0])])
        t = tipo(nome)
        if len(parti) > 1: somma(parti[0], 1, s, m, t)
        if len(parti) > 2: somma(parti[0] + "/" + parti[1], 2, s, m, t)
    if len(sys.argv) > 1:
        # elenco a meta': le cartelle non ancora contate si vedono lo stesso, "in arrivo"
        R = "/mnt/qnap100-frame"
        for c in os.listdir(R):
            if c.startswith((".", "@")) or c in NASCOSTE or not os.path.isdir(os.path.join(R, c)): continue
            conta.setdefault(c, {"p": c, "liv": 1, "file": 0, "peso": 0, "video": 0, "foto": 0, "ultima": 0, "attesa": 1})
            try: eps = os.listdir(os.path.join(R, c))
            except OSError: eps = []
            for e in eps:
                if not e.startswith((".", "@")) and os.path.isdir(os.path.join(R, c, e)):
                    conta.setdefault(c + "/" + e, {"p": c + "/" + e, "liv": 2, "file": 0, "peso": 0, "video": 0, "foto": 0, "ultima": 0, "attesa": 1})
    # l'orologio delle camere (date-1907.py): [prima, ultima] per cartella
    try: cam = json.load(open(os.path.join(CASA, "date-1907.json")))
    except Exception: cam = {}
    righe = []
    for d, fs in sorted(cartelle.items()):
        stag = stagione_in(d)
        dn, fonte = 0, ""
        for pezzo in reversed(d.split("/")):          # dalla cartella piu' vicina alla collezione
            dn = data_in(pezzo)
            if dn: fonte = "nome"; break
        dc = cam.get(d) or []
        if not dn and dc and dc[0]:
            # l'orologio della camera vale se non esce dalla stagione del percorso
            # (G36 Verona-Como 2025/26 aveva clip datate agosto 2024: camera mai regolata)
            if not stag or stagione_di(dc[0]) == stag:
                dn, fonte = dc[0], "camera"
        dfile = sorted(f[3] for f in fs if f[3])
        if not dn and dfile and (not stag or stagione_di(dfile[0]) == stag): dn, fonte = dfile[0], "file"
        if not stag and dn: stag = stagione_di(dn)
        v = sum(1 for f in fs if tipo(f[0]) == "video"); fo = sum(1 for f in fs if tipo(f[0]) == "foto")
        righe.append([d, dn, stag, len(fs), v, fo, sum(f[1] for f in fs), fonte])
    colls = sorted((c for c in conta.values() if c["liv"] == 1), key=lambda c: -c["ultima"])
    eps = sorted((c for c in conta.values() if c["liv"] == 2), key=lambda c: c["p"].lower())
    # la data di collezioni ed episodi: la piu' recente delle loro cartelle
    per = {}
    for r in righe:
        if not r[1]: continue
        a = r[0].split("/")
        for k in (a[0], "/".join(a[:2])):
            per[k] = max(per.get(k, 0), r[1])
    for c in colls + eps:
        if per.get(c["p"]): c["data"] = per[c["p"]]
    tot_file = sum(len(v) for v in cartelle.values()); tot_peso = sum(f[1] for v in cartelle.values() for f in v)
    indice = {"aggiornato": int(time.time()), "file": tot_file, "peso": tot_peso, "collezioni": colls, "episodi": eps,
              "cartelle": righe, "conDataCamera": len(cam)}
    if len(sys.argv) > 1: indice["parziale"] = 1
    dati_file = [[d, [f[:3] + ([f[3]] if f[3] else []) for f in sorted(v)]] for d, v in sorted(cartelle.items())]
    for nomef, dati in (("indice.json", indice), ("file.json", dati_file)):
        tmp = os.path.join(PUB, nomef + ".tmp")
        json.dump(dati, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, os.path.join(PUB, nomef))
    datate = sum(1 for r in righe if r[1])
    print("indice: %d file, %d collezioni, %d episodi, %d cartelle (%d con data)" % (tot_file, len(colls), len(eps), len(righe), datate))


if __name__ == "__main__":
    main()
