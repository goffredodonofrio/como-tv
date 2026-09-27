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

TUTTO QUELLO CHE STA NEL FRAME ENTRA (Goffredo, 27/09/2026: "quello che e'
dentro frame va bene"). Se un giorno una cartella va tenuta fuori, la si
scrive a mano in escludi-1907.txt (un percorso per riga).

I SERVIZI. Le cartelle di una ripresa sono tecniche (CAM A, Warm Up, CLIPS…):
nella linea del tempo si mostrano raccolte in SERVIZI, cioe' le cartelle dello
stesso giorno dentro la stessa sezione (collezione/squadra/tipo), riunite
sotto il loro percorso comune: "G07 - COMO v JUVENTUS", "2025-03-05".
"""
import gzip, json, os, re, sys, time, collections

CASA = "/var/lib/comotv-1907"
PUB = os.path.join(CASA, "pub")
VIDEO = (".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".webm")
FOTO = (".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff", ".cr2", ".cr3", ".arw", ".nef", ".dng", ".psd")
SCARTA = (".log", ".ds_store", ".xml", ".xmp", ".bim", ".cpi", ".bdm", ".mpl", ".thm", ".ppn", ".ctg", ".lrv", ".ini", ".db")
NASCOSTE = {"COMO TV - THUMBNAILS"}
OGGI = int(time.strftime("%Y%m%d"))
MESI = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
MESI.update({"gen": 1, "mag": 5, "giu": 6, "lug": 7, "ago": 8, "set": 9, "ott": 10, "dic": 12})

# i mesi scritti in lettere, inglese e italiano (le prime tre lettere bastano)
MESE = r"(jan(?:uary)?|feb(?:ruary|braio)?|mar(?:ch|zo)?|apr(?:il|ile)?|may|mag(?:gio)?|jun(?:e)?|giu(?:gno)?|jul(?:y)?|lug(?:lio)?|aug(?:ust)?|ago(?:sto)?|sep(?:t(?:ember)?)?|set(?:tembre)?|oct(?:ober)?|ott(?:obre)?|nov(?:ember|embre)?|dec(?:ember)?|dic(?:embre)?|gen(?:naio)?)"
ORD = r"(?:st|nd|rd|th)?"
R_YMD = re.compile(r"(?<!\d)(20[12]\d)([-_. ]?)(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])")          # 2024-11-13, 20250603124508
R_YMD2 = re.compile(r"(?<!\d)(20[12]\d)[-_.](\d{1,2})[-_.](\d{1,2})(?!\d)")                          # 2026-5-5
R_DMY = re.compile(r"(?<!\d)(\d{1,2})[-_. /](\d{1,2})[-_. /](20[12]\d)(?!\d)")                      # 12-12-2024 (e 03-20-2024 all'americana)
R_8 = re.compile(r"(?<!\d)(\d{2})(\d{2})(20[12]\d)(?!\d)")                                             # 03202024
R_DNY = re.compile(r"(?<![\d])(\d{1,2})" + ORD + r"[-_ .]*" + MESE + r"[a-z]*[-_ .,]*(20[12]\d)(?!\d)", re.I)   # 05_March_2025, 8-MAY-2026
R_NDY = re.compile(MESE + r"[a-z]*[-_ .]*(\d{1,2})" + ORD + r"[-_ .,]+(20[12]\d)(?!\d)", re.I)                   # July 23, 2025
R_NY = re.compile(r"(?<![a-z])" + MESE + r"[a-z]*[-_ .]*(20[12]\d)(?!\d)", re.I)                                 # March 2025
R_YM = re.compile(r"(?<!\d)(20[12]\d)[-_](0[1-9]|1[0-2])(?![\d])")                                   # 2025-03, 2024_11_November
R_DN = re.compile(r"(?<![\d])(\d{1,2})" + ORD + r"[-_ .]*" + MESE + r"(?![a-z]{0,6}[-_ .,]*20[12]\d)", re.I)      # 23-July (anno dalla stagione)
R_ND = re.compile(r"(?<![a-z])" + MESE + r"[a-z]*[-_ .]*(\d{1,2})" + ORD + r"(?![\d])", re.I)                     # July 23
R_STAG = re.compile(r"(?<![\d])(20[12]\d)\s*[-/_ ]\s*(?:20)?(\d\d)(?![\d])")
R_STAG2 = re.compile(r"(?<![\d\-/_.])([12]\d)\s*[-/]\s*([12]\d)(?![\d\-/_.])")


def mese(x): return MESI.get(x[:3].lower(), 0)


def valida(a, m, g):
    if not (1 <= m <= 12) or not (0 <= g <= 31): return 0
    d = a * 10000 + m * 100 + g
    return d if 20150000 < d <= OGGI else 0


R_ANNO = re.compile(r"(?<![\d\-_./])(20[12]\d)(?![\d\-_./])")
R_NATALE = re.compile(r"(christmas|x-?mas|natale)\D{0,20}(20[12]\d)|(20[12]\d)\D{0,20}(christmas|x-?mas|natale)", re.I)


def anno_in(percorso):
    """un anno scritto da solo nel percorso ("Como CUP 2025"): serve alle date senza anno"""
    for pezzo in reversed(percorso.split("/")):
        m = R_ANNO.search(senza_date(pezzo))
        if m: return int(m.group(1))
    return 0


def data_in(t, stag="", anno=0):
    """la data scritta in un nome; con la stagione (o un anno nel percorso) si leggono
    anche quelle senza anno ("23-July", "27 July Final")"""
    for x in R_YMD.finditer(t):
        d = valida(int(x.group(1)), int(x.group(3)), int(x.group(4)))
        if d: return d
    for x in R_YMD2.finditer(t):
        d = valida(int(x.group(1)), int(x.group(2)), int(x.group(3)))
        if d: return d
    for x in R_DMY.finditer(t):
        a, b, y = int(x.group(1)), int(x.group(2)), int(x.group(3))
        # di norma giorno-mese; se il secondo non puo' essere un mese, era all'americana
        d = valida(y, b, a) if b <= 12 else valida(y, a, b)
        if d: return d
    for x in R_DNY.finditer(t):
        d = valida(int(x.group(3)), mese(x.group(2)), int(x.group(1)))
        if d: return d
    for x in R_NDY.finditer(t):
        d = valida(int(x.group(3)), mese(x.group(1)), int(x.group(2)))
        if d: return d
    for x in R_8.finditer(t):
        a, b, y = int(x.group(1)), int(x.group(2)), int(x.group(3))
        d = valida(y, a, b) if a <= 12 and b > 12 else valida(y, b, a) if b <= 12 else 0
        if not d and a <= 12: d = valida(y, a, b)
        if d: return d
    for x in R_YM.finditer(t):
        d = valida(int(x.group(1)), int(x.group(2)), 0)
        if d: return d
    for x in R_NY.finditer(t):
        d = valida(int(x.group(2)), mese(x.group(1)), 0)
        if d: return d
    m = R_NATALE.search(t)
    if m: return valida(int(m.group(2) or m.group(3)), 12, 0)
    if stag or anno:
        a1 = int(stag[:4]) if stag else 0
        for rx, gi, mi in ((R_DN, 1, 2), (R_ND, 2, 1)):
            for x in rx.finditer(t):
                m = mese(x.group(mi)); g = int(x.group(gi))
                y = (a1 if m >= 7 else a1 + 1) if a1 else anno
                d = valida(y, m, g) if 1 <= g <= 31 else 0
                if d: return d
    return 0


# ── IL CALENDARIO DEL COMO (dall'archivio partite del MAM, sola lettura) ──
#  "G07 - COMO v JUVENTUS" dentro "SEASON 2025-2026" e' Como-Juventus del
#  19/10/2025: il giorno giusto lo sa l'archivio partite, che ha data e nomi.
ARCHIVIO = "/var/lib/comotv/clip/archivio.json"
ALIAS = {"INTER MILAN": "INTER", "INTERNAZIONALE": "INTER", "COMO 1907": "COMO", "CALCIO COMO": "COMO", "AC MILAN": "MILAN", "HELLAS VERONA": "VERONA", "RB LEIPZIG": "LIPSIA",
         "LEIPZIG": "LIPSIA", "AS ROMA": "ROMA", "SS LAZIO": "LAZIO", "SSC NAPOLI": "NAPOLI", "ATALANTA BC": "ATALANTA",
         "JUVE": "JUVENTUS", "FIORENTINA ACF": "FIORENTINA", "US LECCE": "LECCE", "PISA SC": "PISA", "US SASSUOLO": "SASSUOLO",
         "BAYERN MUNICH": "BAYERN", "BAYERN MONACO": "BAYERN", "REAL MADRID CF": "REAL MADRID", "FC BARCELONA": "BARCELLONA", "BARCELONA": "BARCELLONA"}
R_GIOVANI = re.compile(r"women|femminile|primavera|academy|\bu ?1\d\b|\bu ?2\d\b|under", re.I)
CAL = None


def squadra(x):
    x = re.sub(r"\[.*?\]|\(.*?\)|\d+\s*-\s*\d+", " ", x.upper())
    x = re.sub(r"[^A-Z ]", " ", x); x = re.sub(r"\s+", " ", x).strip()
    return ALIAS.get(x, x)


ESPN_CAL = os.path.join(CASA, "calendario-espn2.json")   # [giorno, casa, ospite, lega]


def calendario_espn():
    """le partite del Como da ESPN (squadra 2572, tutte le competizioni), una stagione
    per volta dal 2018; si scarica di nuovo quando ha piu' di una settimana"""
    try:
        if time.time() - os.path.getmtime(ESPN_CAL) < 7 * 86400: return json.load(open(ESPN_CAL))
    except OSError:
        pass
    import subprocess
    fuori = []
    for anno in range(2018, int(str(OGGI)[:4]) + 1):
        try:
            # con curl: a urllib ESPN risponde 403
            u = "https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/2572/schedule?season=%d" % anno
            j = json.loads(subprocess.run(["curl", "-s", "--max-time", "20", u], capture_output=True, text=True, timeout=30).stdout or "{}")
        except Exception:
            continue
        for e in j.get("events", []):
            try:
                c = e["competitions"][0]["competitors"]
                casa = [x for x in c if x.get("homeAway") == "home"][0]["team"]["displayName"]
                ospite = [x for x in c if x.get("homeAway") == "away"][0]["team"]["displayName"]
                # l'ora e' UTC: una partita alle 20:45 italiane resta nel suo giorno
                g = time.strftime("%Y%m%d", time.localtime(time.mktime(time.strptime(e["date"][:16], "%Y-%m-%dT%H:%M")) - time.timezone))
                lg = (e.get("league") or {}).get("name") or (e.get("season") or {}).get("name") or ""
                fuori.append([int(g), casa, ospite, lg])
            except Exception:
                continue
    if fuori:
        json.dump(fuori, open(ESPN_CAL + ".tmp", "w")); os.replace(ESPN_CAL + ".tmp", ESPN_CAL)
        return fuori
    try: return json.load(open(ESPN_CAL))
    except Exception: return []


def calendario():
    """ESPN prima (e' il calendario vero); l'archivio del MAM solo per le stagioni che ESPN non copre"""
    global CAL
    if CAL is not None: return CAL
    CAL = []
    visti = set(); coperte = collections.Counter()
    for x in calendario_espn():
        g, casa, ospite = x[0], squadra(x[1]), squadra(x[2]); comp = META.lega(x[3]) if len(x) > 3 and x[3] else ""
        if "COMO" in (casa, ospite) and (g, casa, ospite) not in visti:
            visti.add((g, casa, ospite)); CAL.append((g, casa, ospite, comp)); coperte[stagione_di(g)] += 1
    try: a = json.load(open(ARCHIVIO))
    except Exception: return CAL
    for v in a.values():
        g = str(v.get("giorno") or ""); nome = str(v.get("partita") or "")
        if not re.match(r"^20\d{6}$", g) or "COMO" not in nome.upper() or R_GIOVANI.search(nome + " " + str(v.get("competizione") or "")): continue
        if coperte[stagione_di(int(g))] >= 30: continue
        nome = re.sub(r"\[.*?\].*$", "", nome).strip()
        if "-" not in nome: continue
        casa, fuori = [squadra(x) for x in nome.split("-", 1)]
        if "COMO" not in (casa, fuori): continue
        k = (int(g), casa, fuori)
        if k not in visti: visti.add(k); CAL.append(k + (str(v.get("competizione") or ""),))
    return CAL


NOMI = None


def squadre_in(nome):
    """le squadre scritte in un nome, col nome piu' lungo prima ("INTER MILAN" non e' anche "MILAN")"""
    global NOMI
    if NOMI is None:
        tutte = {x for c in calendario() for x in c[1:3]}
        NOMI = sorted({(x, x) for x in tutte} | {(k, v) for k, v in ALIAS.items() if v in tutte}, key=lambda x: -len(x[0]))
    t = " " + re.sub(r"[^A-Z0-9]+", " ", nome.upper()) + " "
    trovate = []
    for n, sq in NOMI:
        k = t.find(" " + n + " ")
        if k >= 0:
            trovate.append((k, sq)); t = t[:k + 1] + " " * len(n) + t[k + 1 + len(n):]
    return sorted(trovate)


def data_partita(nome, stag):
    x = partita_in(nome, stag)
    return x[0] if x else 0


def partita_in(nome, stag):
    """la partita del Como scritta nel nome di una cartella: (giorno, competizione, avversario);
    il giorno e' 0 se l'avversario c'e' ma la partita non si capisce quale sia"""
    sq = squadre_in(nome)
    if not any(x[1] == "COMO" for x in sq): return None
    altre = [x for x in sq if x[1] != "COMO"]
    if len(altre) != 1: return None
    pos_como = [x[0] for x in sq if x[1] == "COMO"][0]; pos_altra, altra = altre[0]
    cand = [c for c in calendario() if altra in c[1:3] and (not stag or stagione_di(c[0]) == stag)]
    if not cand: return (0, "", altra)
    # un mese scritto ("NOVEMBER 30 - COMO MONZA") restringe
    m = re.search(r"(?<![a-z])" + MESE + r"[a-z]*\s*(\d{1,2})?(?!\d)", nome, re.I)
    if m and len(cand) > 1:
        mm = mese(m.group(1)); gg = int(m.group(2)) if m.group(2) else 0
        c2 = [c for c in cand if c[0] // 100 % 100 == mm and (not gg or c[0] % 100 == gg)]
        if c2: cand = c2
    if len(cand) > 1:
        # l'ordine dice chi gioca in casa: "COMO v JUVENTUS" o "SASSUOLO v COMO"
        c2 = [c for c in cand if (c[1] == "COMO") == (pos_como < pos_altra)]
        if c2: cand = c2
    if len(set(c[0] for c in cand)) == 1: return (cand[0][0], cand[0][3] if len(cand[0]) > 3 else "", altra)
    return (0, "", altra)


def senza_date(t):
    for rx in (R_YMD, R_YMD2, R_DMY, R_8, R_DNY, R_NDY, R_YM, R_NY): t = rx.sub(" ", t)
    return t


def stagione_in(percorso):
    # COMANDA LA CARTELLA PIU' ALTA (Goffredo, 27/09/2026: "collocare bene i contenuti
    # nelle loro categorie e cartelle"): "SEASON 2025-2026/.../Preseason 2026-27" sta
    # nella 2025/26, dove l'ha messo chi ha archiviato.
    # Prima si tolgono le date: "2024-10-11" non e' la stagione 2010/11.
    for pezzo in percorso.split("/"):
        pezzo = senza_date(pezzo)
        for x in R_STAG.finditer(pezzo):
            a, b = int(x.group(1)), int(x.group(2))
            if b == (a + 1) % 100: return "%d/%02d" % (a, b)
        for x in R_STAG2.finditer(pezzo):
            a, b = int(x.group(1)), int(x.group(2))
            if b == a + 1 and 15 <= a <= int(str(OGGI)[2:4]): return "20%02d/%02d" % (a, b)
    return ""


def stagione_di(d):
    a, m = d // 10000, (d // 100) % 100
    if not m: return ""
    return "%d/%02d" % (a, (a + 1) % 100) if m >= 7 else "%d/%02d" % (a - 1, a % 100)


def in_stagione(d, stag):
    """una data e' credibile se cade nella stagione del percorso, o un mese prima/dopo"""
    if not stag or not d: return True
    a1 = int(stag[:4]); da = (a1 * 100 + 6); fino = ((a1 + 1) * 100 + 8)
    return da <= d // 100 <= fino


def escluse(dirs):
    """le cartelle da tenere fuori, scritte a mano in escludi-1907.txt"""
    fuori = set()
    try:
        for riga in open(os.path.join(CASA, "escludi-1907.txt"), encoding="utf-8"):
            riga = riga.strip().strip("/")
            if riga and not riga.startswith("#"): fuori.add(riga)
    except OSError:
        pass
    return fuori


def fuori_da(d, fuori):
    return any(d == f or d.startswith(f + "/") for f in fuori)


# nomi di cartella che non dicono che cosa c'e' dentro: per il titolo si sale
R_TECNICO = re.compile(r"^(exports?|shootings?|footages?|pics?|photos?|foto|videos?|raw|clips?|clip working folder|selects?|originals?|"
                       r"cam(era)?\s*[a-z0-9]?|camera footages?|go ?pro( footages?)?|phone( cam| footage)?|drone|audio|proxy|proxies|private|m4root|dcim|"
                       r"\d+[a-z]*|day\s*\d+|match|full match|materiale|project( files?)?|progetto|edit|montaggio|b[- ]?roll|extra|new folder|untitled folder|temp)$", re.I)


def pulito(via):
    """il titolo di un servizio: l'ultima cartella senza date e numeri di giornata;
    se resta vuota (una cartella che e' solo una data) si prende quella sopra"""
    parti = via.split("/")
    for nome in reversed(parti[1:] or parti):
        t = pulito1(nome)
        if re.search(r"[A-Za-z]{3}", t) and not R_TECNICO.match(t.strip()): return t
    return pulito1(parti[-1]) or parti[-1]


def pulito1(nome):
    t = re.sub(r"[_]+", " ", nome)
    t = senza_date(t)
    t = re.sub(r"^\s*G\d{1,2}\s*[-–]?\s*", "", t) if re.match(r"^\s*G\d{1,2}\s*[-– ]", t) else t
    return re.sub(r"\s{2,}", " ", t).strip(" -–·")


def tipo(n):
    n = n.lower()
    return "video" if n.endswith(VIDEO) else "foto" if n.endswith(FOTO) else "altro"


import importlib.util as _iu
_sp = _iu.spec_from_file_location("metadati_1907", os.path.join(os.path.dirname(os.path.abspath(__file__)), "metadati_1907.py"))
META = _iu.module_from_spec(_sp); _sp.loader.exec_module(META)
PERS = META.persone()
RIC = META.Riconosci(PERS)


PF = {}


def schede_persone(righe):
    """per ogni persona trovata: in quante cartelle, quanti video/foto, per stagione e per tipo"""
    conti = {}
    for r in righe:
        chi = [(pid, r[4], r[5]) for pid in r[9].get("p", [])] + [(pid, v, f) for pid, (v, f) in PF.get(r[0], {}).items()]
        for pid, nv, nfo in chi:
            c = conti.setdefault(pid, {"cartelle": 0, "video": 0, "foto": 0, "stagioni": {}, "generi": {}, "collezioni": {}, "competizioni": {}, "ultima": None})
            c["cartelle"] += 1; c["video"] += nv; c["foto"] += nfo
            if r[9].get("c"): c["competizioni"][r[9]["c"]] = c["competizioni"].get(r[9]["c"], 0) + nv + nfo
            # l'ultimo servizio in cui compare: giorno, titolo, cartella
            if r[1] and r[1] % 100 and (not c["ultima"] or r[1] > c["ultima"][0]):
                partita = next((pulito1(x) for x in r[0].split("/") if re.search(r"\bcomo\b", x, re.I) and squadre_in(x) and len(squadre_in(x)) >= 2), "")
                c["ultima"] = [r[1], partita or pulito(r[0]), r[0]]
            if r[2]: c["stagioni"][r[2]] = c["stagioni"].get(r[2], 0) + nv + nfo
            for g in r[9].get("g", []): c["generi"][g] = c["generi"].get(g, 0) + nv + nfo
            k = r[0].split("/")[0]; c["collezioni"][k] = c["collezioni"].get(k, 0) + nv + nfo
    fuori = []
    for p in PERS:
        c = conti.get(p["id"])
        if not c: continue
        fuori.append(dict({k: p[k] for k in ("id", "nome", "ruolo", "maglia", "stagioni", "foto", "alias")}, **{"conti": c}))
    return sorted(fuori, key=lambda p: -(p["conti"]["video"] + p["conti"]["foto"]))


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
    fuori = escluse(list(cartelle))
    tolti = 0
    for d in [d for d in cartelle if fuori_da(d, fuori)]:
        tolti += len(cartelle.pop(d))
    for k in [k for k in conta if fuori_da(k, fuori) or not any(c == k or c.startswith(k + "/") for c in cartelle) and not conta[k].get("attesa")]:
        del conta[k]
    # i conti di collezioni ed episodi senza i file tolti
    if tolti:
        for c in conta.values():
            if c.get("attesa"): continue
            c.update(file=0, peso=0, video=0, foto=0)
        for d, fs in cartelle.items():
            a = d.split("/")
            for k in (a[0], "/".join(a[:2]) if len(a) > 1 else None):
                c = conta.get(k)
                if not c or c.get("attesa"): continue
                for f in fs:
                    c["file"] += 1; c["peso"] += f[1]; t = tipo(f[0])
                    if t in ("video", "foto"): c[t] += 1
    # l'orologio delle camere (date-1907.py): [prima, ultima] per cartella
    try: cam = json.load(open(os.path.join(CASA, "date-1907.json")))
    except Exception: cam = {}
    righe = []
    global PF
    PF = {}
    for d, fs in sorted(cartelle.items()):
        stag_p = stagione_in(d); anno_p = 0 if stag_p else anno_in(d)
        dn, fonte = 0, ""
        for pezzo in reversed(d.split("/")):          # dalla cartella piu' vicina alla collezione
            dn = data_in(pezzo, stag_p, anno_p)
            if dn: fonte = "nome"; break
        if not dn and not R_GIOVANI.search(d):
            for pezzo in reversed(d.split("/")):
                dn = data_partita(pezzo, stag_p)
                if dn: fonte = "calendario"; break
        dc = cam.get(d) or []
        if not dn and dc and dc[0] and in_stagione(dc[0], stag_p):
            # l'orologio della camera vale se non esce dalla stagione del percorso
            # (G36 Verona-Como 2025/26 aveva clip datate agosto 2024: camera mai regolata)
            dn, fonte = dc[0], "camera"
        dfile = sorted(f[3] for f in fs if f[3] and in_stagione(f[3], stag_p))
        if not dn and dfile: dn, fonte = dfile[len(dfile) // 2], "file"
        # la stagione: quella della data, se c'e'; se no quella scritta nel percorso
        # la stagione scritta nel percorso comanda sempre; una data che la contraddice
        # si tiene solo se e' scritta nel nome o viene dal calendario
        if stag_p and dn and not in_stagione(dn, stag_p) and fonte not in ("nome", "calendario"): dn, fonte = 0, ""
        stag = stag_p or (stagione_di(dn) if dn and dn % 10000 // 100 else "")
        vid = sorted(f[0] for f in fs if tipo(f[0]) == "video")
        v = len(vid); fo = sum(1 for f in fs if tipo(f[0]) == "foto")
        # I METADATI: tipo, squadra, competizione, avversario, persone
        md = {}
        gg = RIC.generi(d)
        if gg: md["g"] = gg
        q = RIC.squadra(d)
        if q: md["q"] = q
        pt = None if R_GIOVANI.search(d) else next((x for x in (partita_in(pz, stag_p) for pz in reversed(d.split("/"))) if x), None)
        if pt:
            if pt[2]: md["a"] = pt[2].title()
            if pt[1]: md["c"] = pt[1]
            if "Partita" not in md.get("g", []): md["g"] = ["Partita"] + md.get("g", [])
        c = RIC.competizione(d)
        if c and "c" not in md: md["c"] = c
        # le persone: se il nome e' nel percorso vale per tutta la cartella ("p"); se e' solo
        # nei nomi di alcuni file vale solo per quelli ("pf": "INTV DIAO" accanto a
        # "INTV FABREGAS" non e' di Fabregas)
        pp = RIC.persone(d)
        if pp: md["p"] = pp
        pf = {}
        for f in fs:
            if tipo(f[0]) == "altro": continue
            for pid in RIC.persone(f[0].rsplit(".", 1)[0]):
                if pid not in pp: pf.setdefault(pid, [0, 0])[0 if tipo(f[0]) == "video" else 1] += 1
        if pf: md["pf"] = sorted(pf); PF[d] = pf
        righe.append([d, dn, stag, len(fs), v, fo, sum(f[1] for f in fs), fonte, (d + "/" + vid[len(vid) // 2]) if vid else "", md])
    # LE VICINE: una cartella senza data dentro una ripresa datata ("G07 - COMO v
    # JUVENTUS/match/HUDI'S CAM", camera sbagliata) prende il giorno delle sue
    # sorelle, se sotto lo stesso genitore c'e' un giorno solo.
    giorni = collections.defaultdict(set)
    for r in righe:
        if r[1]:
            a = r[0].split("/")
            for k in range(3, len(a) + 1): giorni["/".join(a[:k])].add(r[1])
    for r in righe:
        if r[1]: continue
        a = r[0].split("/")
        for k in range(len(a) - 1, 2, -1):
            g = giorni.get("/".join(a[:k]))
            if g:
                if len(g) == 1:
                    r[1] = next(iter(g)); r[7] = "vicine"
                    if r[1] % 10000 // 100 and not r[2]: r[2] = stagione_di(r[1])
                break
    # I SERVIZI: stesso giorno (o stesso mese), stessa sezione -> il loro percorso comune
    gruppi = collections.defaultdict(list)
    for r in righe:
        if not (r[4] or r[5]): continue
        a = r[0].split("/")
        gruppi[(r[1], r[2] if not r[1] else "", "/".join(a[:3]))].append(r)
    servizi = []
    for (dt, st, sez), rr in gruppi.items():
        pp = [r[0].split("/") for r in rr]
        comune = pp[0]
        for q in pp[1:]:
            i = 0
            while i < min(len(comune), len(q)) and comune[i] == q[i]: i += 1
            comune = comune[:i]
        via = "/".join(comune) or sez
        rappr = max(rr, key=lambda r: r[4])[8]
        fonte = rr[0][7]
        mu = {}
        for r in rr:
            for k, v in r[9].items():
                if isinstance(v, list):
                    l = mu.setdefault(k, [])
                    for x in v:
                        if x not in l: l.append(x)
                elif k not in mu: mu[k] = v
        servizi.append([via, dt, rr[0][2], sum(r[4] for r in rr), sum(r[5] for r in rr), sum(r[6] for r in rr), fonte, rappr, pulito(via), mu])
    servizi.sort(key=lambda x: (-x[1], x[0]))
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
              "cartelle": [r[:8] + [r[9]] for r in righe], "servizi": servizi, "persone": schede_persone(righe), "conDataCamera": len(cam), "esclusi": {"file": tolti, "cartelle": sorted(fuori)}}
    if len(sys.argv) > 1: indice["parziale"] = 1
    dati_file = [[d, [f[:3] + ([f[3]] if f[3] else []) for f in sorted(v)]] for d, v in sorted(cartelle.items())]
    for nomef, dati in (("indice.json", indice), ("file.json", dati_file)):
        tmp = os.path.join(PUB, nomef + ".tmp")
        json.dump(dati, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        # la versione compressa accanto (nginx gzip_static): 13 MB diventano 3, e nessuno li ricomprime a ogni visita
        with open(tmp, "rb") as f, gzip.open(tmp + ".gz", "wb", 9) as g: g.write(f.read())
        os.replace(tmp + ".gz", os.path.join(PUB, nomef + ".gz"))
        os.replace(tmp, os.path.join(PUB, nomef))
    datate = sum(1 for r in righe if r[1])
    print("indice: %d file, %d collezioni, %d episodi, %d cartelle (%d con data), %d servizi; %d file esclusi a mano" % (tot_file, len(colls), len(eps), len(righe), datate, len(servizi), tolti))


if __name__ == "__main__":
    main()
