#!/usr/bin/env python3
# Lo stato delle foto premium, squadra per squadra: per ogni giocatore delle
# rose ESPN (e delle rose di giovanili.js) si chiede al ponte la foto, come fa
# la pagina Formazioni Premium. Il risultato va in live/stato-foto.json e lo
# legge la pagina live/stato-foto.html del Magazzino.
#
# Gira ogni mattina dopo l'import Sky (comotv-sky.service). Si puo' lanciare
# a mano:  python3 stato-foto.py [--ponte URL] [--stato DIR] [--sito DIR] [--out FILE]
#
# Le rose ESPN comprendono anche ragazzi di Primavera/U23 e chi e' partito:
# i "mancanti" non vanno presi tutti come foto da cercare.
import json, os, re, sys, time, subprocess, unicodedata, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

def arg(nome, predef):
    return sys.argv[sys.argv.index("--" + nome) + 1] if "--" + nome in sys.argv else predef

PONTE = arg("ponte", "http://127.0.0.1:8080/api")
STATO = arg("stato", "/var/lib/comotv")
SITO = arg("sito", "/var/www/comotv")
OUT = arg("out", os.path.join(SITO, "live", "stato-foto.json"))

# Le competizioni seguite: quelle dove le foto sono state importate.
LEGHE = [("ita.1", "Serie A"), ("eng.1", "Premier League"), ("eng.2", "Championship"),
         ("esp.1", "LaLiga"), ("ger.1", "Bundesliga"), ("fra.1", "Ligue 1"), ("fra.2", "Ligue 2"),
         ("ned.1", "Eredivisie"), ("por.1", "Liga Portugal"), ("aut.1", "Bundesliga austriaca"),
         ("ksa.1", "Saudi Pro League")]
# In Libertadores e Sudamericana solo le squadre ancora in gara (settembre 2026).
CONMEBOL = {"conmebol.libertadores": ["Fluminense", "Palmeiras", "Estudiantes de La Plata", "Flamengo", "Independiente del Valle"],
            "conmebol.sudamericana": ["Vasco da Gama", "Boca Juniors", "Atlético-MG", "Cienciano del Cusco", "Montevideo City Torque"]}
GIOVANILI = [("giovanili.primavera1", "como-primavera"), ("giovanili.u18", "como-u18"), ("giovanili.u17", "como-u17")]

def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")

def leggi(url):
    errore = None
    for _ in range(3):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"}), timeout=30).read())
        except Exception as e:
            errore = e
            time.sleep(1)
    raise errore

def foto(q):
    return bool(leggi(PONTE + "?" + q).get("url"))

loghi = set(os.listdir(os.path.join(STATO, "loghi")))
try:
    allenatori = json.load(open(os.path.join(STATO, "allenatori.json")))["perId"]
except Exception:
    allenatori = {}

def coach_foto(nome):
    return ("foto-premium-coach-%s.png" % slug(nome)) in loghi

def presenze(a):
    st = (a.get("statistics") or {}).get("splits", {}).get("categories", [])
    for c in st:
        for x in c.get("stats", []):
            if x.get("name") == "appearances":
                return int(x.get("value") or 0)
    return 0

def giovane(a):
    # Le rose ESPN si portano dietro Primavera, U23 e riserve: senza numero,
    # oppure numero alto, 21 anni al massimo e nessuna presenza. Sono da
    # verificare, non da cercare per forza.
    num = a.get("jersey")
    if not num:
        return True
    try:
        return int(num) >= 40 and (a.get("age") or 99) <= 21 and presenze(a) == 0
    except ValueError:
        return False

# ── la scheda del giocatore ──────────────────────────────────────────
# Le rose ESPN si portano dietro anagrafica, fisico, nazionalita' e le
# statistiche della stagione: oggi ne usavamo solo il nome. Qui diventano una
# scheda per giocatore, che il ponte serve a TELECRONACA (?giocatore=<id>).
GIOCATORI = {}

def statistiche(a):
    v = {}
    for c in (a.get("statistics") or {}).get("splits", {}).get("categories", []):
        for x in c.get("stats", []):
            try: v[x.get("name")] = float(x.get("value") or 0)
            except (TypeError, ValueError): pass
    def n(k):
        return int(v.get(k, 0))
    s = {"presenze": n("appearances"), "titolare": n("appearances") - n("subIns"), "gol": n("totalGoals"),
         "assist": n("goalAssists"), "tiri": n("totalShots"), "tiri_porta": n("shotsOnTarget"),
         "gialli": n("yellowCards"), "rossi": n("redCards"), "falli_fatti": n("foulsCommitted"),
         "falli_subiti": n("foulsSuffered")}
    if v.get("saves") or v.get("shotsFaced"):
        s["parate"] = n("saves"); s["gol_subiti"] = n("goalsConceded")
    return s

def scheda(a, tid, squadra, lega, con_foto):
    # altezza e peso arrivano in pollici e libbre
    alt = a.get("height") or 0
    peso = a.get("weight") or 0
    inf = [i.get("type") or i.get("status") or "" for i in (a.get("injuries") or [])]
    return {
        "id": str(a["id"]), "nome": a.get("firstName") or "", "cognome": a.get("lastName") or "",
        "completo": a.get("displayName") or "", "num": a.get("jersey") or "",
        "ruolo": (a.get("position") or {}).get("displayName", ""), "ruolo_breve": (a.get("position") or {}).get("abbreviation", ""),
        "eta": a.get("age") or "", "nato": (a.get("dateOfBirth") or "")[:10],
        "altezza_cm": int(round(alt * 2.54)) if alt else "", "peso_kg": int(round(peso * 0.4536)) if peso else "",
        "paese": a.get("citizenship") or "", "bandiera": ((a.get("flag") or {}).get("href") or ""),
        "squadra": squadra, "squadra_id": str(tid), "lega": lega,
        "foto": con_foto, "infortunio": ", ".join([x for x in inf if x]),
        "stat": statistiche(a),
    }

def squadra_espn(lega, tid, nome):
    rosa = leggi("https://site.api.espn.com/apis/site/v2/sports/soccer/%s/teams/%s/roster" % (lega, tid)).get("athletes", [])
    senza = [a for a in rosa
             if not foto("foto=%s&id=%s&squadra=%s" % (urllib.parse.quote(a.get("lastName") or a["displayName"]), a["id"], tid))]
    ko = set(a["id"] for a in senza)
    for a in rosa:
        GIOCATORI[str(a["id"])] = scheda(a, tid, nome, lega, a["id"] not in ko)
    al = allenatori.get(str(tid)) or {}
    return {"squadra": nome, "totale": len(rosa), "con_foto": len(rosa) - len(senza),
            "mancano": [a["displayName"] for a in senza],
            "mancanti": [{"nome": a["displayName"], "num": a.get("jersey") or "", "ruolo": (a.get("position") or {}).get("abbreviation", ""),
                          "eta": a.get("age") or "", "giovane": giovane(a)} for a in senza],
            "allenatore": (al.get("nome", "") + " " + al.get("cognome", "")).strip(), "allenatore_foto": coach_foto(nome)}

lavori = []
for lega, nome_lega in LEGHE:
    for t in leggi("https://site.api.espn.com/apis/site/v2/sports/soccer/%s/teams" % lega)["sports"][0]["leagues"][0]["teams"]:
        lavori.append((nome_lega, lega, t["team"]["id"], t["team"]["displayName"]))
for lega, nomi in CONMEBOL.items():
    ids = {t["team"]["displayName"]: t["team"]["id"] for t in leggi("https://site.api.espn.com/apis/site/v2/sports/soccer/%s/teams" % lega)["sports"][0]["leagues"][0]["teams"]}
    for n in nomi:
        if n in ids:
            lavori.append(("Libertadores / Sudamericana", lega, ids[n], n))

def fai(j):
    try:
        return j[0], squadra_espn(j[1], j[2], j[3])
    except Exception as e:
        return j[0], {"squadra": j[3], "errore": str(e)}

comp = {}
with ThreadPoolExecutor(6) as ex:
    for c, r in ex.map(fai, lavori):
        comp.setdefault(c, []).append(r)

# Giovanili del Como: le rose stanno in giovanili.js, niente id ESPN.
try:
    js = "global.window={}; require(%s); const G=window.GIOVANILI; const o=[];" % json.dumps(os.path.join(SITO, "live", "giovanili.js"))
    js += "for (const [c,id] of %s) { const s=G.squadre(c).find(x=>x.id===id); o.push({id:id, n:s.name, rosa:G.rosa(c,id), all:G.allenatore(c,id)}); } console.log(JSON.stringify(o));" % json.dumps(GIOVANILI)
    for t in json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=60).stdout):
        mancano = [p["nome"] + " " + p["cognome"] for p in t["rosa"]
                   if not foto("foto=%s&squadra=%s" % (urllib.parse.quote(p["cognome"]), t["id"]))]
        for p in t["rosa"]:
            gid = "como-giov-" + slug(p["cognome"])
            GIOCATORI[gid] = {"id": gid, "nome": p.get("nome", ""), "cognome": p.get("cognome", ""),
                              "completo": (p.get("nome", "") + " " + p.get("cognome", "")).strip(),
                              "num": p.get("num", ""), "ruolo": "", "ruolo_breve": p.get("ruolo", ""),
                              "eta": "", "nato": "", "altezza_cm": "", "peso_kg": "", "paese": "", "bandiera": "",
                              "squadra": t["n"], "squadra_id": t["id"], "lega": "giovanili",
                              "foto": (p["nome"] + " " + p["cognome"]) not in mancano, "infortunio": "", "stat": {}}
        al = t.get("all") or {}
        comp.setdefault("Como giovanili", []).append({"squadra": t["n"], "totale": len(t["rosa"]), "con_foto": len(t["rosa"]) - len(mancano),
                                                      "mancano": mancano, "mancanti": [{"nome": n, "giovane": False} for n in mancano], "allenatore": (al.get("nome", "") + " " + al.get("cognome", "")).strip(),
                                                      "allenatore_foto": coach_foto(t["n"])})
except Exception as e:
    comp.setdefault("Como giovanili", []).append({"squadra": "giovanili.js", "errore": str(e)})

ordine = ["Serie A", "Como giovanili"] + [n for _, n in LEGHE if n != "Serie A"] + ["Libertadores / Sudamericana"]
adesso = time.time()
def nuove(sec):
    d = os.path.join(STATO, "loghi")
    return sum(1 for f in loghi if f.startswith("foto-premium-") and not f.startswith("foto-premium-coach-")
               and adesso - os.path.getmtime(os.path.join(d, f)) < sec)

uscita = {
    "generato": time.strftime("%d/%m/%Y %H:%M"),
    "foto_giocatori_magazzino": sum(1 for f in loghi if f.startswith("foto-premium-") and not f.startswith("foto-premium-coach-")),
    "foto_allenatori_magazzino": sum(1 for f in loghi if f.startswith("foto-premium-coach-")),
    "nuove_24h": nuove(86400), "nuove_7g": nuove(7 * 86400),
    "allenatori_con_nome": len(allenatori),
    "competizioni": [{"nome": c, "squadre": sorted(comp[c], key=lambda r: r["squadra"])} for c in ordine if c in comp],
}
# L'archivio giocatori: un file per squadra dentro il sito (live/giocatori/),
# cosi' TELECRONACA lo legge da sola senza passare dal ponte — il ponte delle
# grafiche non si tocca. Il file intero resta accanto agli altri stati.
per_sq = {}
for g in GIOCATORI.values():
    per_sq.setdefault(g["squadra_id"], []).append(g["id"])
arch = {"generato": time.strftime("%d/%m/%Y %H:%M"), "perId": GIOCATORI,
        "perSq": {k: sorted(v, key=lambda i: (GIOCATORI[i]["cognome"], GIOCATORI[i]["nome"])) for k, v in per_sq.items()}}
gfile = os.path.join(STATO, "giocatori.json")
json.dump(arch, open(gfile + ".tmp", "w"), ensure_ascii=False)
os.replace(gfile + ".tmp", gfile)

# un file per squadra: poche decine di schede, si scarica in un attimo
gdir = os.path.join(SITO, "live", "giocatori")
os.makedirs(gdir, exist_ok=True)
for tid, ids in arch["perSq"].items():
    f = os.path.join(gdir, "%s.json" % re.sub(r"[^A-Za-z0-9_-]", "", str(tid)))
    json.dump({"generato": arch["generato"], "squadra": tid,
               "giocatori": [GIOCATORI[i] for i in ids]}, open(f + ".tmp", "w"), ensure_ascii=False)
    os.replace(f + ".tmp", f)

tmp = OUT + ".tmp"
json.dump(uscita, open(tmp, "w"), ensure_ascii=False)
os.replace(tmp, OUT)
tot = sum(r.get("totale", 0) for c in comp.values() for r in c)
con = sum(r.get("con_foto", 0) for c in comp.values() for r in c)
print("stato foto: %d/%d giocatori con foto, scritto %s" % (con, tot, OUT))
print("archivio giocatori: %d schede, %d squadre, scritto %s e %s" % (len(GIOCATORI), len(per_sq), gfile, gdir))
