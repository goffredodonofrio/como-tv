#!/usr/bin/env python3
"""LE PANCHINE CON LE DATE (28/09/2026) -> allenatori-storia.json

Serve alla ricerca del MAM per gli allenatori (clip.js: panchine, allenatoriDi):
ESPN non dice chi siede in panchina, e allenatori.json sa solo chi c'e' oggi.
Si leggono le pagine di stagione di Wikipedia (tabella Personnel + Managerial
changes) dei campionati delle squadre dell'archivio e se ne ricavano i periodi
[allenatore, squadra ESPN, dal, al, adInterim, paese].

Si lancia dal Mac (serve pandas+lxml, che sulla VM non ci sono):
    python3 allenatori-storia.py
prende dalla VM le squadre dell'archivio, scarica le pagine in ./pagine/ (le
tiene: per rifarle da capo si cancella la cartella), scrive allenatori-storia.json
e dice quali squadre restano senza allenatore. Poi:
    scp allenatori-storia.json root@VM:/var/lib/comotv/  (e /var/lib/comotv-dev/)
    chown comotv:comotv ...   (il ponte lo rilegge da solo)
Una stagione nuova: aggiungere la pagina in P. Un nome che non torna: ALIAS,
"PAESE|nome Wikipedia" -> nome ESPN (null = scartare).
"""
import json, os, subprocess, time, urllib.parse, pandas as pd, io, re, warnings, unicodedata, datetime as dt
VM = os.environ.get("COMOTV_VM", "root@209.227.239.211")
# le squadre dell'archivio, con le competizioni in cui compaiono
ESPN = json.loads(subprocess.run(["ssh", VM, "cd /var/lib/comotv/clip && node -e \"const f=require('fs');const E=JSON.parse(f.readFileSync('espn.json','utf8')),A=JSON.parse(f.readFileSync('archivio.json','utf8')),T={};Object.keys(A).forEach(r=>{const e=E[r];if(!e||!e.squadre)return;e.squadre.forEach(s=>{const t=T[s]||(T[s]={});t[e.lega||'?']=(t[e.lega||'?']||0)+1;});});process.stdout.write(JSON.stringify(T))\""], capture_output=True, text=True, check=True).stdout)
ALIAS = {"ITA|Inter Milan": "Internazionale", "AUT|Austria Wien": "Austria Vienna", "AUT|Rapid Wien": "Rapid Vienna", "AUT|Red Bull Salzburg": "RB Salzburg",
 "GRE|Asteras Tripolis": "Asteras Tripoli", "GRE|OFI": ["OFI Crete", "OFI CRETE"], "GER|Hamburger SV": "Hamburg SV", "GER|1. FC Köln": "FC Cologne",
 "GER|Erzgebirge Aue": "FC Erzgebirge Aue", "BRA|Atlético Mineiro": "Atlético-MG", "ARG|Central Córdoba (SdE)": "Central Córdoba (Santiago del Estero)",
 "ARG|Estudiantes (LP)": "Estudiantes de La Plata", "ARG|Estudiantes (RC)": "Estudiantes de Río Cuarto", "ARG|San Martín (SJ)": "San Martín (San Juan)",
 "ARG|Sarmiento (J)": "Sarmiento (Junín)", "ARG|Talleres (C)": "Talleres (Córdoba)", "ARG|Unión": "Unión (Santa Fe)",
 "ARG|Gimnasia y Esgrima (LP)": "Gimnasia La Plata", "ARG|Gimnasia y Esgrima (M)": "Gimnasia (Mendoza)", "ECU|LDU Quito": "Liga de Quito",
 "ECU|Universidad Católica": "Universidad Católica (Quito)", "ECU|Libertad": "Libertad (Ecuador)", "PAR|Nacional": "Nacional Asunción",
 "COL|Santa Fe": "Independiente Santa Fe", "URU|Racing": "Racing (Montevideo)", "VEN|Universidad Central": "UCV FC", "FRA|Rennes": "Stade Rennais",
 "POR|Nacional": "C.D. Nacional", "CHI|Everton": "Everton CD", "NED|Eindhoven": None, "COL|Deportivo Cali": None}
UA = {"User-Agent": "ComoTV-MAM/1.0 (archivio interno Como TV)"}
EU = lambda nome, anni: [f"{a}–{str(a+1)[2:]} {nome}" for a in anni]
CAL = lambda fmt, anni: [fmt.format(a) for a in anni]
P = []
P += EU("Serie A", [2025, 2026]) + EU("Serie B", [2025, 2026])
P += EU("Saudi Pro League", [2025, 2026])
P += EU("Premier League", [2026]) + EU("EFL Championship", [2026]) + EU("EFL League One", [2026]) + EU("EFL League Two", [2026])
P += CAL("{} Argentine Primera División", [2025, 2026])
P += EU("Austrian Football Bundesliga", [2026])
P += EU("Bundesliga", [2026]) + EU("2. Bundesliga", [2026]) + EU("3. Liga", [2026])
P += EU("Eredivisie", [2024, 2025, 2026]) + EU("Eerste Divisie", [2024, 2025, 2026])
for n in ["Scottish Premiership", "Scottish Championship", "Scottish League One", "Scottish League Two"]: P += EU(n, [2024, 2025, 2026])
P += EU("Ligue 1", [2025]) + EU("Ligue 2", [2025]) + EU("Championnat National", [2025])
P += EU("Primeira Liga", [2024, 2025]) + EU("Liga Portugal 2", [2024, 2025])
P += EU("Super League Greece", [2024])
P += CAL("{} Campeonato Brasileiro Série A", [2025, 2026]) + CAL("{} Campeonato Brasileiro Série B", [2025, 2026])
P += CAL("{} Categoría Primera A season", [2025, 2026])
P += CAL("{} Chilean Primera División", [2025, 2026])
P += CAL("{} Ecuadorian Serie A", [2025, 2026])
P += CAL("{} Paraguayan Primera División season", [2025, 2026])
P += CAL("{} Uruguayan Primera División season", [2025, 2026])
P += CAL("{} Liga 1 (Peru)", [2025, 2026])
P += CAL("{} Bolivian Primera División season", [2025, 2026])
P += CAL("{} Venezuelan Primera División season", [2025, 2026])
P += ["2026 Liga de Primera", "2026 LigaPro Serie A", "2026 FBF División Profesional", "2026 Liga FUTVE", "2026 Liga AUF Uruguaya", "2026 Paraguayan Primera División", "2026 APF División de Honor", "2025 Liga de Primera"]
os.makedirs("pagine", exist_ok=True)
idx = {}
for t in P:
    f = "pagine/" + t.replace("/", "_") + ".html"
    if os.path.exists(f): idx[t] = f; continue
    u = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({"action": "parse", "page": t, "redirects": 1, "prop": "text", "format": "json", "formatversion": 2})
    try:
        import subprocess; j = json.loads(subprocess.run(["curl", "-s", "-m", "40", "-A", UA["User-Agent"], u], capture_output=True).stdout)
    except Exception as e:
        print("ERR", t, e); continue
    if "error" in j: print("MANCA", t, j["error"].get("info")); continue
    open(f, "w").write(j["parse"]["text"]); idx[t] = f
    print("ok", t, "->", j["parse"]["title"], len(j["parse"]["text"]))
    time.sleep(0.3)


# ── dalle pagine ai periodi ──
warnings.filterwarnings("ignore")
def piatto(s): return unicodedata.normalize("NFD", str(s)).encode("ascii", "ignore").decode().lower()
VUOTE = set("fc cf sc ac afc club de del la cd ca al sk fk if ssc us as calcio sv vfl vfb tsv fsv 1 04 05 07 09 1899 1900 1904 1907 1909 1911 1924 sd ud rc rcd cs ec se cr sa esporte clube futebol the".split())
def parole(s):
    return [w for w in re.split(r"[^a-z0-9]+", piatto(s).replace("al-", "al ")) if w and w not in VUOTE]
def pulisci(s):
    s = re.sub(r"\[[^\]]*\]", "", str(s)); return re.sub(r"\s+", " ", s).strip()
def data(s):
    s = pulisci(s)
    for f in ("%d %B %Y", "%B %d, %Y", "%d %b %Y"):
        try: return dt.datetime.strptime(s, f).date()
        except Exception: pass
    m = re.search(r"(\d{1,2} [A-Z][a-z]+ \d{4})", s)
    if m: return data(m.group(1))
    return None
def nome(s):
    s = pulisci(s)
    if s.lower() in ("nan", "", "vacant", "—", "-"): return None, False
    ad = bool(re.search(r"caretaker|interim|\(c\)", s, re.I))
    s = re.sub(r"\((caretaker|interim|c)\)", "", s, flags=re.I).strip()
    return s, ad
def piatta(t):
    t = t.copy(); t.columns = [c[-1] if isinstance(c, tuple) else c for c in t.columns]; return t
def col(t, *ks, no=()):
    for c in t.columns:
        lc = str(c).lower()
        if any(k in lc for k in ks) and not any(n in lc for n in no): return c
def finestra(titolo):
    m = re.match(r"(\d{4})–(\d{2}) ", titolo)
    if m: a = int(m.group(1)); return dt.date(a, 7, 1), dt.date(a + 1, 6, 30)
    a = int(titolo[:4]); return dt.date(a, 1, 1), dt.date(a, 12, 31)
periodi, nonTrovate, fonti = [], {}, []
PAESI = [("Saudi", "KSA"), ("Premier League", "ENG"), ("EFL", "ENG"), ("Argentine", "ARG"), ("Austrian", "AUT"), ("Bundesliga", "GER"), ("3. Liga", "GER"),
  ("Eredivisie", "NED"), ("Eerste", "NED"), ("Scottish", "SCO"), ("Ligue ", "FRA"), ("National", "FRA"), ("Primeira Liga", "POR"), ("Liga Portugal", "POR"), ("Greece", "GRE"),
  ("Brasileiro", "BRA"), ("Categoría Primera", "COL"), ("Chilean", "CHI"), ("Liga de Primera", "CHI"), ("Ecuadorian", "ECU"), ("LigaPro", "ECU"), ("Paraguayan", "PAR"),
  ("Uruguayan", "URU"), ("AUF", "URU"), ("Liga 1 (Peru)", "PER"), ("Bolivian", "BOL"), ("FBF", "BOL"), ("Venezuelan", "VEN"), ("FUTVE", "VEN"), ("Serie ", "ITA")]
def paeseDi(t): return next(p for k, p in PAESI if k in t)
LEGA_PAESE = {"ita": "ITA", "ksa": "KSA", "eng": "ENG", "arg": "ARG", "aut": "AUT", "ger": "GER", "ned": "NED", "sco": "SCO", "fra": "FRA", "por": "POR", "gre": "GRE"}
SUDAM = {"ARG", "BRA", "COL", "CHI", "ECU", "PAR", "URU", "PER", "BOL", "VEN"}
def paesiEspn(e):
    s = set()
    for l in ESPN[e]:
        p = LEGA_PAESE.get(l.split(".")[0])
        if p: s.add(p)
        elif l.startswith("conmebol"): s.add("SUDAM")
    return s
def espnDi(wt, paese):
    k = paese + "|" + wt
    if k in ALIAS: v = ALIAS[k]; return None if v is None else (v if isinstance(v, list) else [v])
    pw = set(parole(wt))
    if not pw: return None
    dentro = [e for e in ESPN if paese in paesiEspn(e) or (paese in SUDAM and "SUDAM" in paesiEspn(e))]
    cand = [e for e in dentro if set(parole(e)) == pw]
    if not cand: cand = [e for e in dentro if pw <= set(parole(e))]
    return cand[:1] if len(cand) == 1 else None
for titolo, f in idx.items():
    try: tabs = [piatta(t) for t in pd.read_html(io.StringIO(open(f).read()))]
    except Exception: continue
    w0, w1 = finestra(titolo)
    cambi = [t for t in tabs if col(t, "outgoing") is not None and (col(t, "incoming", "replaced") is not None)]
    pers = [t for t in tabs if col(t, "team", "club") is not None and col(t, "manager", "head coach", "coach", no=("month", "of the")) is not None and col(t, "outgoing") is None and col(t, "month") is None]
    ev = {}
    for t in cambi:
        cT, cO, cI = col(t, "team", "club"), col(t, "outgoing"), col(t, "incoming", "replaced")
        cV, cA = col(t, "vacancy"), col(t, "appointment")
        for _, r in t.iterrows():
            tm = pulisci(r[cT]); o, oad = nome(r[cO]); i, iad = nome(r[cI])
            dv = data(r[cV]) if cV is not None else None; da = data(r[cA]) if cA is not None else None
            if not tm or (not dv and not da): continue
            ev.setdefault(tm, []).append((dv or da, o, oad, i, iad, da or dv))
    attuali = {}
    for t in pers[:1]:
        cT, cM = col(t, "team", "club"), col(t, "manager", "head coach", "coach", no=("month", "of the"))
        for _, r in t.iterrows():
            n, ad = nome(r[cM]); tm = pulisci(r[cT])
            if n and tm: attuali[tm] = (n, ad)
    squadre = set(ev) | set(attuali)
    usate = 0; paese = paeseDi(titolo)
    for tm in squadre:
      for e in (espnDi(tm, paese) or [None]):
        if not e: nonTrovate.setdefault(tm, []).append(titolo); continue
        usate += 1
        lista = sorted(ev.get(tm, []), key=lambda x: x[0])
        if not lista:
            n, ad = attuali[tm]; periodi.append([n, e, str(w0), str(w1), ad, paese, titolo]); continue
        inizio = w0
        for dv, o, oad, i, iad, da in lista:
            if o and dv and dv > inizio: periodi.append([o, e, str(inizio), str(dv), oad, paese, titolo])
            inizio = da if da and da >= (dv or da) else (dv or da)
            ultimo = (i, iad)
        if ultimo[0]: periodi.append([ultimo[0], e, str(inizio), str(w1), ultimo[1], paese, titolo])
    fonti.append([titolo, usate])
# dedup e unisci periodi contigui dello stesso allenatore/squadra
periodi.sort(key=lambda p: (p[1], p[5], p[0], p[2]))
uniti = []
for p in periodi:
    u = uniti[-1] if uniti else None
    if u and u[0] == p[0] and u[1] == p[1] and u[5] == p[5] and p[2] <= str(dt.date.fromisoformat(u[3]) + dt.timedelta(days=62)):
        u[3] = max(u[3], p[3]); u[4] = u[4] and p[4]; continue
    uniti.append(p[:])
json.dump({"generato": str(dt.date.today()), "fonte": "Wikipedia (en), pagine di stagione: Personnel + Managerial changes", "pagine": fonti,
           "periodi": [p[:6] for p in uniti]}, open("allenatori-storia.json", "w"), ensure_ascii=False, indent=0)
print(len(uniti), "periodi")
rel = {k: v for k, v in nonTrovate.items()}
json.dump(rel, open("non-trovate.json", "w"), ensure_ascii=False, indent=1)
cop = set(p[1] for p in uniti); print("squadre ESPN coperte", len(cop), "su", len(ESPN))
print("senza:", sorted(set(ESPN) - cop))
