"""
METADATI 1907 — i criteri uguali per tutto il materiale del club.
(Goffredo, 27/09/2026: "dobbiamo riuscire a ricreare dei metadati che siano
criterio universale per le ricerche")

Per ogni cartella del FRAME, dal suo percorso e dai nomi dei suoi file:
  g  tipo di contenuto   Partita, Allenamento, Intervista, Conferenza stampa, Ritiro,
                         Nuovo acquisto, Tifosi, Evento, Lifestyle e territorio, Drone,
                         Backstage, Commerciale, Grafica, Documentario, Social
  q  squadra             Prima squadra, Como Women, Primavera, Under 17…, Academy
  c  competizione        Serie A, Serie B, Coppa Italia, Amichevole… (dal calendario o dal nome)
  a  avversario          dal calendario del Como o dal nome della partita
  p  persone             giocatori delle rose del Como (ESPN, dal 2019) e persone del club
Le parole chiave stanno qui sotto, in chiaro: se una cartella finisce nel posto
sbagliato si corregge la parola, non il codice.
"""
import json, os, re, subprocess, time, unicodedata

CASA = "/var/lib/comotv-1907"
ROSE_CACHE = os.path.join(CASA, "rose-como.json")
FOTO_MAPPA = "/var/lib/comotv/foto-intestazioni.json"
FOTO_DIR = "/var/lib/comotv/loghi"


def piatto(s):
    return unicodedata.normalize("NFD", str(s)).encode("ascii", "ignore").decode().lower()


# ── TIPO DI CONTENUTO ──────────────────────────────────────────────────
GENERI = [
    ("Partita", r"matchdays?|match ?day|full match|partita|giornata|\bg\d{1,2}\b|highlights?|\bvs?\b|warm ?up|riscaldamento|prematch|pre ?match|post ?match|tunnel|player arrival|broadcast camera"),
    ("Allenamento", r"training(?! camp)|allenament|mozzate|sessione"),
    ("Ritiro", r"training camp|pre-?season|preseason|ritiro|marbella|\btst\b"),
    ("Intervista", r"interviews?|\bitw\b|intervist|react"),
    ("Conferenza stampa", r"press conference|conferenza|sala stampa|presser"),
    ("Nuovo acquisto", r"signing|new player|presentazione|unveil|announcement|welcome"),
    ("Tifosi", r"\bfans?\b|tifosi|fan stor|curva|supporters|ultras|flares"),
    ("Evento", r"\bevents?\b|evento|gala|concert|party|cerimonia|award|cup\b|torneo|trofeo|parade"),
    ("Lifestyle e territorio", r"lifestyle|tourism|discover|villa\b|villas|lake|lago|bellagio|brunate|como city|centro como|taste of|cooking|restaurant|wedding"),
    ("Drone", r"drone"),
    ("Backstage", r"\bbts\b|behind the|backstage|dietro le quinte|making of"),
    ("Commerciale", r"\bstore\b|shop|\bkit\b|jersey|maglia|\badv\b|commercial|sponsor|partners?\b|merch|retail|adidas"),
    ("Grafica", r"\bgfx\b|lower third|graphic|grafica|thumbnail|\blogo"),
    ("Documentario", r"document|docu\b"),
    ("Social", r"tik ?tok|reels?\b|instagram|social|shorts?\b|stories"),
]
GENERI_RX = [(g, re.compile(rx, re.I)) for g, rx in GENERI]

SQUADRE = [
    ("Como Women", r"women|femminile|quelle ?del ?como|\bwfc\b|ladies"),
    ("Primavera", r"primavera|\bu ?20\b|under ?20"),
    ("Under 19", r"\bu ?19\b|under ?19"),
    ("Under 18", r"\bu ?18\b|under ?18"),
    ("Under 17", r"\bu ?17\b|under ?17"),
    ("Under 16", r"\bu ?16\b|under ?16"),
    ("Under 15 e più giovani", r"\bu ?1[0-5]\b|under ?1[0-5]|summer camp|scuola calcio"),
    ("Academy", r"academy"),
    ("Prima squadra", r"first team|prima squadra|men'?s? first|\bmen\b|serie a\b|matchday_serie"),
]
SQUADRE_RX = [(q, re.compile(rx, re.I)) for q, rx in SQUADRE]

COMPETIZIONI = [
    ("Serie A", r"serie ?a\b"), ("Serie B", r"serie ?b\b"), ("Serie C", r"serie ?c\b|lega pro"),
    ("Coppa Italia", r"coppa italia|italian cup"), ("Champions League", r"champions"), ("Europa League", r"europa league"),
    ("Conference League", r"conference league"), ("Amichevole", r"friendly|amichevol|friendlies"), ("Como Cup", r"como cup"),
    ("Primavera 1", r"primavera 1\b"), ("Primavera 2", r"primavera 2\b"),
]
COMPETIZIONI_RX = [(c, re.compile(rx, re.I)) for c, rx in COMPETIZIONI]
LEGHE_ESPN = {"italian serie a": "Serie A", "italian serie b": "Serie B", "coppa italia": "Coppa Italia", "club friendly": "Amichevole",
              "uefa champions league": "Champions League", "uefa europa league": "Europa League", "uefa conference league": "Conference League"}


def lega(nome):
    n = piatto(nome)
    for k, v in LEGHE_ESPN.items():
        if k in n: return v
    return nome.strip()


# ── LE PERSONE ─────────────────────────────────────────────────────────
#  Le rose del Como da ESPN (Serie A e Serie B, dal 2019), piu' le persone
#  del club che nelle cartelle compaiono davvero (contate il 27/09/2026).
#  I cognomi che sono anche parole comuni si riconoscono solo col nome intero.
CLUB = [
    {"nome": "Cesc Fàbregas", "ruolo": "Allenatore", "alias": ["cesc", "fabregas", "cesc fabregas"], "foto": "foto-premium-coach-como.png"},
    {"nome": "Raphaël Varane", "ruolo": "Club", "alias": ["varane", "raphael varane"]},
    {"nome": "Thierry Henry", "ruolo": "Club", "alias": ["thierry henry"]},
    {"nome": "Dennis Wise", "ruolo": "Club", "alias": ["dennis wise"]},
    {"nome": "Osian Roberts", "ruolo": "Staff tecnico", "alias": ["osian roberts", "osian"]},
    {"nome": "Mirwan Suwarso", "ruolo": "Club", "alias": ["mirwan", "suwarso", "mirwan suwarso"]},
    {"nome": "Carlalberto Ludi", "ruolo": "Club", "alias": ["ludi", "carlalberto ludi"]},
    {"nome": "Veronica Boquete", "ruolo": "Como Women", "alias": ["boquete", "veronica boquete"]},
]
AMBIGUI = {"sala", "valle", "carlos", "roberto", "rodriguez", "moreno", "milla", "ramon", "alli", "cerri", "reina", "paz", "diao", "kuhn",
           "wise", "henry", "cabral", "costa", "silva", "leo", "ricci", "bruno", "franco", "rossi", "bianchi", "martini", "marchi", "conti"}
RUOLI = {"G": "Portiere", "D": "Difensore", "M": "Centrocampista", "F": "Attaccante"}


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", piatto(s)).strip("-")


def rose_espn():
    try:
        if time.time() - os.path.getmtime(ROSE_CACHE) < 7 * 86400: return json.load(open(ROSE_CACHE))
    except OSError:
        pass
    per = {}
    anno_oggi = int(time.strftime("%Y"))
    for lg, anni in (("ita.1", range(2021, anno_oggi + 1)), ("ita.2", range(2019, 2024))):
        for a in anni:
            try:
                u = "https://site.api.espn.com/apis/site/v2/sports/soccer/%s/teams/2572/roster?season=%d" % (lg, a)
                j = json.loads(subprocess.run(["curl", "-s", "--max-time", "20", u], capture_output=True, text=True, timeout=30).stdout or "{}")
            except Exception:
                continue
            for x in j.get("athletes", []):
                n = x.get("displayName") or ""
                if not n: continue
                p = per.setdefault(n, {"nome": n, "id_espn": str(x.get("id") or ""), "ruolo": RUOLI.get((x.get("position") or {}).get("abbreviation", ""), ""),
                                       "maglia": str(x.get("jersey") or ""), "stagioni": []})
                st = "%d/%02d" % (a, (a + 1) % 100)
                if st not in p["stagioni"]: p["stagioni"].append(st)
                if a >= max(int(s[:4]) for s in p["stagioni"]): p["maglia"] = str(x.get("jersey") or p["maglia"])
    fuori = sorted(per.values(), key=lambda p: p["nome"])
    if fuori:
        json.dump(fuori, open(ROSE_CACHE + ".tmp", "w"), ensure_ascii=False); os.replace(ROSE_CACHE + ".tmp", ROSE_CACHE)
        return fuori
    try: return json.load(open(ROSE_CACHE))
    except Exception: return []


def persone():
    """l'elenco delle persone con i loro modi di essere scritte"""
    try:
        fi = json.load(open(FOTO_MAPPA)); perSq = fi.get("perSq", {}); ambigui = set(fi.get("ambigui", []))
    except Exception:
        perSq, ambigui = {}, set()
    tutte = []
    viste = set()
    for p in CLUB + rose_espn():
        nome = p["nome"]; k = slug(nome)
        if k in viste: continue
        viste.add(k)
        parole = piatto(nome).replace("-", " ").split()
        alias = set(piatto(a) for a in p.get("alias", []))
        alias.add(" ".join(parole))
        if len(parole) > 1:
            cognome = parole[-1]
            # cognomi composti: Da Cunha, van der Brempt
            for i in range(1, len(parole)):
                if parole[i] in ("da", "de", "van", "di", "del", "della", "dos", "el"):
                    cognome = " ".join(parole[i:]); break
            if len(cognome) >= 4 and cognome not in AMBIGUI: alias.add(cognome)
        foto = p.get("foto", "")
        chiavi = ["-".join(slug(nome).split("-")[-2:]), slug(nome).split("-")[-1]]
        if not foto:
            # 1) cognome e squadra (il Como e' la 2572 per ESPN)
            for kk in chiavi:
                f = (perSq.get(kk) or {}).get("2572")
                if f and os.path.exists(os.path.join(FOTO_DIR, f)): foto = f; break
        if not foto and not p.get("club"):
            # 2) il Como e' coperto dall'archivio foto: un cognome non ambiguo e' lui
            for kk in chiavi:
                f = "foto-premium-" + kk + ".png"
                if kk not in ambigui and kk not in perSq and os.path.exists(os.path.join(FOTO_DIR, f)): foto = f; break
        tutte.append({"id": k, "nome": nome, "ruolo": p.get("ruolo", ""), "maglia": p.get("maglia", ""), "stagioni": sorted(p.get("stagioni", []), reverse=True),
                      "foto": foto, "alias": sorted(alias, key=len, reverse=True), "club": p in CLUB})
    return tutte


class Riconosci:
    """trova persone, tipi, squadra e competizione in un testo (percorso + nomi dei file)"""

    def __init__(self, pers):
        self.pers = pers
        alt = []
        self.chi = {}
        for p in pers:
            for a in p["alias"]:
                if a not in self.chi: self.chi[a] = p["id"]; alt.append(a)
        alt.sort(key=len, reverse=True)
        self.rx = re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(a).replace(r"\ ", r"[\s_.\-]*") for a in alt) + r")(?![a-z0-9])") if alt else None

    def persone(self, testo):
        if not self.rx: return []
        t = piatto(testo)
        trovati = []
        for m in self.rx.finditer(t):
            a = re.sub(r"[\s_.\-]+", " ", m.group(1))
            pid = self.chi.get(a) or self.chi.get(m.group(1))
            if pid and pid not in trovati: trovati.append(pid)
        return trovati

    @staticmethod
    def generi(percorso):
        t = piatto(percorso).replace("_", " ")
        return [g for g, rx in GENERI_RX if rx.search(t)]

    @staticmethod
    def squadra(percorso):
        t = piatto(percorso).replace("_", " ")
        for q, rx in SQUADRE_RX:
            if rx.search(t): return q
        return ""

    @staticmethod
    def competizione(percorso):
        t = piatto(percorso).replace("_", " ")
        for c, rx in COMPETIZIONI_RX:
            if rx.search(t): return c
        return ""
