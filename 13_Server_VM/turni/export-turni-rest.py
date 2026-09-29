#!/usr/bin/env python3
"""Airtable "Como TV | Turni Redazione" -> modello nuovo (turni.json).

Il token non si scrive qui: si legge dalla memoria di progetto.
La tabella Airtable ha due colonne per ogni giorno (orario + attività) e
nessun anno nelle intestazioni: qui diventano turni con una data vera,
un'ora di inizio e una di fine.
"""
import json, os, re, sys, unicodedata, urllib.parse, urllib.request

MEM = os.path.expanduser("~/.claude/projects/-Users-goffredodonofrio-Desktop-Como-TV/memory/api_tokens.md")
BASE = "appwR5ffgs5PJlOqm"
T_TURNI, T_FERIE, T_STAFF = "tblWA6rbD22YmOflJ", "tblXhrv28fITkIFLT", "tblyb4S7RzdxSTf4k"
FUORI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "turni.json")
MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
        "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"]
LUOGHI = {"SEDE": "sede", "SMART": "smart", "ESTERNA": "esterna", "TRASFERTA": "esterna"}
# quello che in Airtable sta nella colonna orario ma orario non e'
NON_ORARIO = {"OFF": "off", "FERIE": "ferie", "RECUPERO OFF": "recupero", "RECUPERO": "recupero",
              "FESTIVO": "festivo", "N/A": "", "MALATTIA": "malattia"}


def token():
    with open(MEM, encoding="utf-8") as f:
        m = re.search(r"\*\*Token:\*\*\s*`(pat[A-Za-z0-9.]+)`", f.read())
    if not m:
        sys.exit("token Airtable non trovato nella memoria")
    return m.group(1)


TOK = token()


def records(tabella):
    out, offset = [], None
    while True:
        u = "https://api.airtable.com/v0/%s/%s?pageSize=100" % (BASE, tabella)
        if offset:
            u += "&offset=" + urllib.parse.quote(offset)
        # curl e non urllib: su questo Mac python non trova i certificati
        import subprocess
        # il token passa dallo standard input di curl, non dalla riga di comando
        got = subprocess.run(["curl", "-s", "-m", "60", "--config", "-", u],
                             input='header = "Authorization: Bearer %s"\n' % TOK,
                             capture_output=True, text=True)
        d = json.loads(got.stdout)
        out += d.get("records", [])
        offset = d.get("offset")
        if not offset:
            return out


def norm(s):
    return unicodedata.normalize("NFC", str(s or "")).replace(" ", " ").strip()


def data_da_intestazione(h):
    """"Sabato 15 Agosto" -> 2026-08-15. La tabella copre luglio-novembre 2026."""
    n = norm(h).lower()
    if n.startswith("attivit") or n == "persona":
        return None
    m = re.search(r"(\d{1,2})\s+([a-zà-ù]+)\s*$", n)
    if not m or m.group(2) not in MESI:
        return None
    mese = MESI.index(m.group(2)) + 1
    anno = 2026 if mese >= 7 else 2027
    return "%04d-%02d-%02d" % (anno, mese, int(m.group(1)))


def ore(v):
    """"10-19" -> 10:00 19:00 · "10,30-19,30" -> 10:30 19:30 · "15-00" -> 15:00 00:00"""
    t = norm(v).upper().replace(" ", "")
    m = re.match(r"^(\d{1,2})([.,](\d{2}))?-(\d{1,2})([.,](\d{2}))?$", t)
    if not m:
        return None
    return ("%02d:%s" % (int(m.group(1)), m.group(3) or "00"),
            "%02d:%s" % (int(m.group(4)), m.group(6) or "00"))


def nomi(v):
    if v is None:
        return []
    v = v if isinstance(v, list) else [v]
    return [norm(x.get("name") if isinstance(x, dict) else x) for x in v if x]


print("leggo Airtable…")
turni_rec, ferie_rec, staff_rec = records(T_TURNI), records(T_FERIE), records(T_STAFF)
print("  Turni %d · Ferie %d · Staff %d" % (len(turni_rec), len(ferie_rec), len(staff_rec)))

reparto_di = {}
for r in staff_rec:
    f = r.get("fields", {})
    if f.get("Name"):
        reparto_di[norm(f["Name"]).lower()] = nomi(f.get("Dipartimento"))[0] if f.get("Dipartimento") else ""

# nella vecchia sincronizzazione i reparti stavano dentro lo script: qui diventano dati
SOCIAL = ["Castiglione Francesco", "Crivellaro Irene", "Murdocca Tommaso", "Solario Simone", "Ugliono Roberto"]
GRAFICA = ["Ventura Alessandro"]


def chiave(nome):
    return " ".join(sorted(norm(nome).lower().split()))


def reparto(nome):
    k = chiave(nome)
    if k in [chiave(x) for x in SOCIAL]:
        return "social"
    if k in [chiave(x) for x in GRAFICA]:
        return "grafica"
    return "redazione"


persone, turni, saltati = [], {}, []
for r in turni_rec:
    f = r.get("fields", {})
    nome = norm(f.get("Persona"))
    if not nome:                      # righe rimaste vuote in Airtable
        continue
    pid = re.sub(r"[^a-z0-9]+", "-", chiave(nome)).strip("-")
    st = reparto_di.get(norm(nome).lower(), "")
    persone.append({"id": pid, "nome": nome, "reparto": reparto(nome), "staff": st, "attivo": True})
    attivita_per_data = {}
    for k, v in f.items():
        m = re.match(r"^attivit[àa]\s+(\d{1,2})/(\d{1,2})$", norm(k).lower())
        if m:
            g, ms = int(m.group(1)), int(m.group(2))
            anno = 2026 if ms >= 7 else 2027
            attivita_per_data["%04d-%02d-%02d" % (anno, ms, g)] = nomi(v)
    for k, v in f.items():
        data = data_da_intestazione(k)
        if not data:
            continue
        orario = norm(nomi(v)[0] if nomi(v) else "")
        if not orario:
            continue
        tags = attivita_per_data.get(data, [])
        luogo = ""
        att = []
        for t in tags:
            if t.upper() in LUOGHI and not luogo:
                luogo = LUOGHI[t.upper()]
            elif t.upper().startswith("SMART") and not luogo:
                luogo = "smart"
            else:
                att.append(t)
        o = ore(orario)
        su = orario.upper()
        if o:
            t = {"tipo": "lavoro", "inizio": o[0], "fine": o[1]}
        elif su in NON_ORARIO or "FERIE" in su or "RECUPERO" in su:
            tipo = NON_ORARIO.get(su) or ("ferie" if "FERIE" in su else "recupero")
            if not tipo:
                continue
            t = {"tipo": tipo}
        else:
            saltati.append(orario)
            t = {"tipo": "lavoro", "nota": orario}
        if luogo:
            t["luogo"] = luogo
        if att:
            t["attivita"] = att
        turni.setdefault(data, {})[pid] = t

# Ferie Estive: coppie inizio/fine per mese -> periodi di assenza
assenze = []
for r in ferie_rec:
    f = r.get("fields", {})
    nome = norm(f.get("Nomi"))
    if not nome:
        continue
    pid = re.sub(r"[^a-z0-9]+", "-", chiave(nome)).strip("-")
    for mese in ["Giugno 2026", "Luglio 2026", "Agosto 2026", "Settembre 2026"]:
        da, a = f.get("Inizio Ferie " + mese), f.get("Fine Ferie " + mese)
        if da:
            assenze.append({"id": "%s-%s" % (pid, str(da)), "persona": pid, "tipo": "ferie",
                            "da": str(da)[:10], "a": str(a or da)[:10]})

fuori = {"versione": 1, "origine": "Airtable %s (esportato una volta sola)" % BASE,
         "persone": sorted(persone, key=lambda p: (p["reparto"], p["nome"])),
         "turni": dict(sorted(turni.items())), "assenze": assenze, "storia": []}
with open(FUORI, "w", encoding="utf-8") as f:
    json.dump(fuori, f, ensure_ascii=False, indent=1)

giorni = sorted(turni)
print("persone %d · giorni %d (%s → %s) · celle %d · assenze %d"
      % (len(persone), len(giorni), giorni[0] if giorni else "-", giorni[-1] if giorni else "-",
         sum(len(v) for v in turni.values()), len(assenze)))
if saltati:
    print("orari non riconosciuti:", sorted(set(saltati)))
print("scritto", FUORI)
