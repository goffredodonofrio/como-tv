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
BATTESIMI = "/var/lib/comotv-1907/battesimi.json"


def piatto(s):
    return unicodedata.normalize("NFD", str(s)).encode("ascii", "ignore").decode().lower()


# ── TIPO DI CONTENUTO ──────────────────────────────────────────────────
GENERI = [
    ("Partita", r"matchdays?|match ?day|full match|partita|giornata|\bg\d{1,2}\b|highlights?|\bvs?\b|warm ?up|riscaldamento|prematch|pre ?match|post ?match|tunnel|player arrival|broadcast camera"),
    ("Allenamento", r"training(?! camp)|allenament|mozzate|sessione"),
    ("Ritiro", r"training camp|pre-?season|preseason|ritiro|marbella|\btst\b"),
    ("Intervista", r"interviews?|\bitw\b|intervist|\bintw\b|soundbite"),
    ("Conferenza stampa", r"press conference|conferenza|sala stampa|presser"),
    ("Nuovo acquisto", r"signing|new player|presentazione|unveil|announcement|welcome"),
    ("Tifosi", r"\bfans?\b|tifosi|fan stor|curva (sud|nord)|supporters|ultras|flares|fans? reaction"),
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

# I RAMI DELL'ALBERO (Goffredo, 29/09/2026: "stagione > Prima squadra maschile > tutte le altre
# squadre > format > altro"; Academy = tutte le giovanili, Primavera compresa). Ogni cartella va in
# un ramo solo, nell'ordine: un FORMAT (prodotto editoriale, anche se ci sono giocatori), la
# SQUADRA, il CLUB (eventi, store, territorio...), l'ARCHIVIO STORICO (prima del 2023/24), e se
# niente torna DA SISTEMARE (un contatore che deve scendere). Si corregge la parola, non il codice.
FORMAT = [
    ("Discover Como", r"discover como"), ("Taste of Como", r"taste of como"), ("Behind the Team", r"behind the team"),
    ("Inside Sinigaglia", r"inside sinigaglia"), ("Como Legends", r"como legends|\blegends\b"), ("Tourism", r"como tv ?- ?tourism|\btourism\b"),
    ("Como Gaming Club", r"gaming"), ("Kings League", r"kings league|\bzeta\b"), ("Documentario Fàbregas", r"documentario fabregas|cesc documentary"),
    ("Documentario Mola", r"documentario mola"), ("Fan stories", r"fan stories"), ("Get to know you", r"get to know"),
]
FORMAT_RX = [(n, re.compile(rx, re.I)) for n, rx in FORMAT]
RAMO_PRIMA = re.compile(r"team playing|team goal|team warm ?up|marbella|training camp|celebration|\bmatch ?day|first team|men.?s first", re.I)
RAMO_CLUB = re.compile(r"hospitality|store|como cup|summer camp|commercial|commerciale|sponsor|event|gala|christmas|natale|ghana|drone|tifosi|fans|"
                       r"external media|other media|press|lifestyle|b[- ]?roll|territor|tour|celebrit|people|carnival|carnevale|sentiero|interior|exterior|"
                       r"stadio|indonesia|test cam|foundation|charity|scuola|school|anthem|castle|castello|villa|wine|vino|mountain|lake|lago", re.I)
RAMO_CLUB_GENERI = {"Evento", "Commerciale", "Tifosi", "Lifestyle e territorio", "Drone", "Social"}
RAMI = ["Prima squadra", "Women", "Academy", "Format", "Club", "Archivio storico", "Da sistemare"]


def ramo(percorso, md, stagione=""):
    """(ramo, format) di una cartella: vedi RAMI"""
    t = percorso or ""; q = (md or {}).get("q")
    for n, rx in FORMAT_RX:
        if rx.search(t): return "Format", n
    if not q and RAMO_PRIMA.search(t): q = "Prima squadra"
    if q == "Prima squadra": return "Prima squadra", ""
    if q == "Como Women": return "Women", ""
    if q: return "Academy", ""
    if RAMO_CLUB.search(t) or set((md or {}).get("g", [])) & RAMO_CLUB_GENERI: return "Club", ""
    if stagione and stagione < "2023/24": return "Archivio storico", ""
    return "Da sistemare", ""

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


_RITR = {}
def RITRATTI():
    if "x" not in _RITR:
        try: _RITR["x"] = json.load(open("/var/lib/comotv-1907/ritratti.json"))
        except Exception: _RITR["x"] = {}
    return _RITR["x"]


def battezzati():
    """le persone nuove battezzate dai volti sconosciuti (non nelle rose ESPN ne' in CLUB):
    staff, dirigenti, ospiti. Hanno come foto il loro volto ritagliato ("volto")."""
    try: b = json.load(open(BATTESIMI)).get("persone", {})
    except Exception: return []
    return [{"nome": v["nome"], "ruolo": v.get("ruolo", ""), "club": True, "volto": v.get("volto", "")} for v in b.values() if v.get("nome")]


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
    for p in CLUB + rose_espn() + battezzati():
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
        # un battezzato con una parola sola ("Pietro") non si cerca nei percorsi: troverebbe tutti i Pietro
        if p.get("volto") and len(parole) < 2: alias = set()
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
        # senza foto premium, ma con un ritratto messo a mano (ritratti-1907.py): il suo volto
        volto = p.get("volto", "") or ("" if foto else (RITRATTI().get(k) or {}).get("k", ""))
        tutte.append({"id": k, "nome": nome, "ruolo": p.get("ruolo", ""), "maglia": p.get("maglia", ""), "stagioni": sorted(p.get("stagioni", []), reverse=True),
                      "foto": foto, "alias": sorted(alias, key=len, reverse=True), "club": p in CLUB or bool(p.get("volto")), "volto": volto})
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


# ── CHI HA GIRATO (la camera o il videomaker, dalle cartelle) ───────────
R_CAM_NOME = re.compile(r"^(?:cam(?:era)?\s+(?P<a>[a-z]{3,}))$|^(?P<b>[a-z]{3,})(?:'s|s)?\s*(?:cam|camera)$", re.I)
CAM_FISSE = [
    ("Broadcast", r"broadcast camera|broadcast|raw cam serie a|live\s+ita|live\s+eng"),
    ("Telefono", r"phone cam|phone footage|phone|iphone|cellulare"),
    ("Drone", r"\bdrone\b"),
    ("GoPro", r"go ?pro"),
    ("Getty", r"\bgetty\b"),
    ("360°", r"\b360\b"),
]
CAM_FISSE_RX = [(c, re.compile(rx, re.I)) for c, rx in CAM_FISSE]
NON_CAM = {"the", "match", "main", "second", "first", "live", "raw", "phone", "broadcast", "promotion", "unit", "extra", "footage", "footages",
           "full", "new", "old", "cam", "camera", "video", "photo", "all", "tiki", "day", "offloads", "offload", "proxies", "proxy", "test",
           "truffle", "intw", "dumps", "dump", "admin", "cameras", "vip"}
# stessa persona scritta in modi diversi, o nomi di attrezzatura
CAM_ALIAS = {"dji": "Drone", "hudis": "Hudi", "rudi": "Rudy", "handy": "Handycam", "disposable": "Usa e getta", "player": "Camera dei giocatori"}


def camera(percorso):
    """la camera o chi ha girato: dalla cartella piu' vicina al file che ne parla"""
    for pezzo in reversed(percorso.split("/")):
        t = piatto(pezzo).replace("_", " ").strip()
        m = re.search(r"\bcam(?:era)?\s*([a-d1-9])\b", t)
        if m and not re.search(r"camera footages?", t): return "Camera " + m.group(1).upper()
        for c, rx in CAM_FISSE_RX:
            if rx.search(t): return c
        m = R_CAM_NOME.search(t)
        if m:
            n = (m.group("a") or m.group("b") or "").strip().replace("\u2019", "")
            if n and n not in NON_CAM: return CAM_ALIAS.get(n, n.capitalize())
        for rx in (r"\(([a-z]+)'?s cam\)", r"^([a-z]{3,})'?s?\s+cam(?:era)?\b", r"\bfootage\s+([a-z]{3,})$", r"\bcam\s+([a-z]{3,})$"):
            m = re.search(rx, t)
            if m and m.group(1) not in NON_CAM: return CAM_ALIAS.get(m.group(1), m.group(1).capitalize())
    return ""


# ── IL MOMENTO (di una partita o di un evento) ─────────────────────────
MOMENTI = [
    ("Arrivo", r"arrival|arrivo|\bbus\b|player arrival|arriving"),
    ("Pre-partita", r"pre ?match|prematch|pre-game|pre partita|before the match"),
    ("Tunnel", r"tunnel|walk ?out|line ?up|ingresso|entrata"),
    ("Riscaldamento", r"warm ?up|riscaldamento"),
    ("Partita", r"\bmatch footage\b|full match|1st half|2nd half|primo tempo|secondo tempo|\bpartita\b|\blive\b"),
    ("Gol", r"\bgol\b|\bgoals?\b"),
    ("Esultanza", r"celebration|esultanz|festa|champions!|we did it"),
    ("Intervallo", r"half ?time|intervallo"),
    ("Post-partita", r"post ?match|post partita|mixed zone|flash|after the match"),
    ("Spogliatoio", r"dressing|locker|spogliatoio"),
]
MOMENTI_RX = [(m, re.compile(rx, re.I)) for m, rx in MOMENTI]


def momenti(percorso):
    t = piatto(percorso).replace("_", " ")
    return [m for m, rx in MOMENTI_RX if rx.search(t)]


# ── IL LUOGO ───────────────────────────────────────────────────────────
LUOGHI = [
    ("Stadio Sinigaglia", r"sinigaglia"), ("Centro sportivo Mozzate", r"mozzate"), ("Bellagio", r"bellagio"),
    ("Villa Erba", r"villa erba"), ("Villa d'Este", r"villa d.?este"), ("Villa Carminati", r"carminati"), ("Villa Pliniana", r"pliniana"),
    ("Villa del Balbianello", r"balbianello"), ("Varenna", r"varenna"), ("Brunate", r"brunate"), ("Cernobbio", r"cernobbio"),
    ("Menaggio", r"menaggio"), ("Tremezzo", r"tremezzo"), ("Como città", r"centro como|como city|citta di como|downtown"),
    ("Lago di Como", r"lake como|lago di como|\bboat\b|barca|\blake\b"), ("Marbella", r"marbella"), ("Ghana", r"ghana|accra"),
    ("Londra", r"london|londra"), ("Indonesia", r"indonesia|jakarta|\bbali\b"), ("Milano", r"milano|milan store|store milano"),
]
LUOGHI_RX = [(l, re.compile(rx, re.I)) for l, rx in LUOGHI]


def luoghi(percorso):
    t = piatto(percorso).replace("_", " ")
    return [l for l, rx in LUOGHI_RX if rx.search(t)]
