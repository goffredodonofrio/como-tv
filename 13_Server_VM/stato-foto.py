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

def squadra_espn(lega, tid, nome):
    rosa = leggi("https://site.api.espn.com/apis/site/v2/sports/soccer/%s/teams/%s/roster" % (lega, tid)).get("athletes", [])
    mancano = [a["displayName"] for a in rosa
               if not foto("foto=%s&id=%s&squadra=%s" % (urllib.parse.quote(a.get("lastName") or a["displayName"]), a["id"], tid))]
    al = allenatori.get(str(tid)) or {}
    return {"squadra": nome, "totale": len(rosa), "con_foto": len(rosa) - len(mancano), "mancano": mancano,
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
        al = t.get("all") or {}
        comp.setdefault("Como giovanili", []).append({"squadra": t["n"], "totale": len(t["rosa"]), "con_foto": len(t["rosa"]) - len(mancano),
                                                      "mancano": mancano, "allenatore": (al.get("nome", "") + " " + al.get("cognome", "")).strip(),
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
tmp = OUT + ".tmp"
json.dump(uscita, open(tmp, "w"), ensure_ascii=False)
os.replace(tmp, OUT)
tot = sum(r.get("totale", 0) for c in comp.values() for r in c)
con = sum(r.get("con_foto", 0) for c in comp.values() for r in c)
print("stato foto: %d/%d giocatori con foto, scritto %s" % (con, tot, OUT))
