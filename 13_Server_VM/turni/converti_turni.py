#!/usr/bin/env python3
"""Converte l'export Airtable 'Como TV | Turni Redazione' in turni-airtable.json."""
import json, re, sys, os, collections

BASE = "/Users/goffredodonofrio/.claude/projects/-Users-goffredodonofrio-Desktop-Como-TV-2--Analisi---Strategy-Digital-Strategy--claude-worktrees-wizardly-hodgkin-d4f79f/f5664d48-1974-44d3-9fab-872f10da4cdd/tool-results"
FILES = [
    os.path.join(BASE, "mcp-7a9ae141-8e3d-4270-910e-cbad364e19af-list_records_for_table-1790685361474.txt"),  # 15-31 ago
    os.path.join(BASE, "mcp-7a9ae141-8e3d-4270-910e-cbad364e19af-list_records_for_table-1790685423777.txt"),  # settembre
    os.path.join(BASE, "mcp-7a9ae141-8e3d-4270-910e-cbad364e19af-list_records_for_table-1790685407306.txt"),  # ottobre
]
OUT = "/private/tmp/claude-501/-Users-goffredodonofrio-Desktop-Como-TV-2--Analisi---Strategy-Digital-Strategy--claude-worktrees-wizardly-hodgkin-d4f79f/f5664d48-1974-44d3-9fab-872f10da4cdd/scratchpad/turni-airtable.json"

FLD_PERSONA = "fldCo5zEaD1Dt0xV8"

# (data, id campo orario, id campo attività) — trascritti dallo schema Airtable, in ordine
GIORNI = [
("2026-08-15","fldW4dT0Y8RxbIb1Q","fldIhbf2RF7xKaTBK"),
("2026-08-16","fldoVpI2lnJex7OW8","fldF8DLRpxXpYFRhE"),
("2026-08-17","fldTJj9SeojOtRZLb","fldcfV7L0HglPVniF"),
("2026-08-18","fld8jxOAZrlYlIWi2","fldZqeBWgwpGnJ95v"),
("2026-08-19","flduxrylcDnDvHkJe","fldT16D8zYpQe0dIf"),
("2026-08-20","fld2A5wtj6uSqB7i8","fldYsjSZh9XokjiyR"),
("2026-08-21","fldXtJsXcx1jNNy6P","fldCWaIs049tmssrw"),
("2026-08-22","fldSABiLNFCDrrO3H","fldTQiIpmxSdxQeZD"),
("2026-08-23","fldOoEaz8Pyz9dLb7","fldjZM1cMGySztQyZ"),
("2026-08-24","fldn7KRQ5Q7ycC3jx","fldclvGM9QS2b0ZVg"),
("2026-08-25","fldBf3GXh7PiDG8Vg","fldIXGaLwWcKrTkjd"),
("2026-08-26","fldI2oo8ptWT6bNXX","fldADCNbfTMar8iAr"),
("2026-08-27","fldskQCcCab45nP8L","fldDIdOv5c887MEjV"),
("2026-08-28","flds48mFsrwDZiESs","fldNicyKaPrkD2ayf"),
("2026-08-29","fldJ6PtNOAaY6Vt53","fld6Q0oAV0LtwNGJE"),
("2026-08-30","fldWAynlQtaaxY2nB","fldZfahzhiWVWyHWX"),
("2026-08-31","fldh81edHzPT7OJPd","fldNKjuySvgg08dtH"),
("2026-09-01","fldOs1C2GtP37QkfA","fldaN2MKzRuhQ5DKo"),
("2026-09-02","fldKAJPYh9xu2ysMI","fldJskjk3AFcNpDb7"),
("2026-09-03","fldm5hFd1nk9Ju60S","fldTpNVhceGqXq3YT"),
("2026-09-04","fldUdtjYakqE6XMHI","fldahn3tZl2OOTHnV"),
("2026-09-05","fldq9FFBcd6Esef6F","fldnTzHxBWCeSdRgy"),
("2026-09-06","fldmPSfFcYnP2TcNH","fldtOOb6kxsQuB9Nz"),
("2026-09-07","fldAkTIk48Qr1JE8b","fldWTT9kcDBb8PJgu"),
("2026-09-08","fldtrwqwnu6tWrqeZ","fldsJM6D56hhlRb34"),
("2026-09-09","fldM7zf1JiyIOmY20","fldaShuy9hpncOdXm"),
("2026-09-10","fldJ5sogZX38v9UOY","fldvK5RNAIVpQEjLW"),
("2026-09-11","fldFGWntrJHeXdHV8","fldaqWRmrfr2J8EIU"),
("2026-09-12","fld8O03LyFbhEZyYl","fldfDSKGeSqshV0hJ"),
("2026-09-13","fldatGZwKzWnLring","fldXy8TztGWlm2LgI"),
("2026-09-14","fldPCtEVSnkaHpVXb","fldWHMp9sCOEoJhjC"),
("2026-09-15","fldKZE1mqCA9EADRY","fldRBsNTXEhTEN6Eq"),
("2026-09-16","flddJRiYt9u8x4uFW","fldfwG6qJLNJtv5YW"),
("2026-09-17","fld4C1F8PcmqVvlzk","fldlOhwyn5yqe0eMv"),
("2026-09-18","fldz1fieY7nUACX4G","fldYFe80iWzKtjNua"),
("2026-09-19","fld6CDQi4IZWMsZGH","fldRjRpZc1lwxAVic"),
("2026-09-20","fldRdxnhQTDx7Dsdm","fldXsCDsGPLKq7Xhk"),
("2026-09-21","fldGhffMMeeidNYvT","fld9PFBupNik5y2kj"),
("2026-09-22","fldNrMTeZZVlyux2P","fld9ooVlBRGWvNQXk"),
("2026-09-23","fldA5ftwliQBud5cH","fldQsEsI1Kvc4bSd3"),
("2026-09-24","fld8D3zW4KUYEhJXD","fldy1ggYDQKNcAgro"),
("2026-09-25","fldAT3ZWA5PUc0R8x","fldR1kwCtsxpooTU5"),
("2026-09-26","flde35139eYr00sKf","fldIc1Q8xLCedSFJl"),
("2026-09-27","fld95fsuvc18Ooeeq","fldPBGeYn0wYfbNhm"),
("2026-09-28","fldqQrGHday0NglIE","fldF4BkoWMVri31MI"),
("2026-09-29","fldu4UImmFulCsDaE","fldBGczGZKrtxaXGY"),
("2026-09-30","fldsaESY8CtwBboG5","fldh4UDDOvH0jBJb2"),
("2026-10-01","fldXqomEbAIj7s2jT","fldTnJzgDCFrZaXVk"),
("2026-10-02","fld4HOVEmra0Zu7r9","fldGA7VvzJ5ERKMOu"),
("2026-10-03","fldgVY0LW9WuSouwg","fldGeZ5X8i07rAEIF"),
("2026-10-04","fldTjKsRxz5QkM4tO","fldYDdrCsLfMzb3Ne"),
("2026-10-05","fldLV01s0VOMe87Fi","fldHwXiT0AUIwXtbd"),
("2026-10-06","fldfMEGDg4YazRJyP","fldWBd0Gk9ssedn7d"),
("2026-10-07","fldVraXfCrtFACidF","fld8LN3DvAwHJgzGl"),
("2026-10-08","fldugaIgXGbdevkey","fldLeeyHxWBDf992G"),
("2026-10-09","fldugnzRYqCrDFT3L","fldG8qKIRXCyAQ4nP"),
("2026-10-10","fldBWrgWFgnEMe12x","fldGyk2MLGIUtKS2c"),
("2026-10-11","fldiq5jXssuc6hblt","fldBuPG8QBfn3yqe5"),
("2026-10-12","fldyP4xmSO7E2lpzE","fld7v8S3NOSOpwjeg"),
("2026-10-13","fldIzj4lOaApYWsSA","fldXvZeugrv4ZBCfr"),
("2026-10-14","fldrqZLgJviAiALfn","fldj0IYurLhgXOtdM"),
("2026-10-15","fldCDWIXUnjrWS1NS","fldQrOKv4UUtjdf6N"),
("2026-10-16","fldLqgAMk0c1GYyBo","flddeIuXXv2gxL2Qy"),
("2026-10-17","fldrhgX84Xdwg4f3w","fldfSld9RzzvN0HdJ"),
("2026-10-18","fldI1gyT985wU9H2X","fldEwJ8rtGjlgswGz"),
("2026-10-19","fldPemDMf9et3igPh","fldEBKKEcYDVwHtke"),
("2026-10-20","fldtEScPVlT3SN1lk","fldGe0TYPKZtvaZJ1"),
("2026-10-21","fldWVTsFPUHj0LZNO","fldHvFWEvQcXzK3EM"),
("2026-10-22","fldG8PQZ1xYag5ldk","fldAaBCmlXC3olXl5"),
("2026-10-23","fldue5PTVx2CTP51L","fldYgoSoldaKGfAqP"),
("2026-10-24","fldwJbukzlhaNYi9Q","fldxHwg8YMR1b92nV"),
("2026-10-25","fldU3XPperaPCutjh","fldKFMEcZthtyKSBh"),
("2026-10-26","fldzO8b0KLeBffrZm","fldRJ0jlo8wkHXP57"),
("2026-10-27","fldev6KnjFmyZnogm","fldmRmbpcsWxvl5OI"),
("2026-10-28","fldjpD1nUvwPDKbbv","fldMY7rEZYBG08puD"),
("2026-10-29","fldmu3LRyR4cW6zMz","fldM3BtqyTy6ECpQd"),
("2026-10-30","fldxcLfyJbUj55Gtg","fldtacuaqMWl7ZJgA"),
("2026-10-31","flda7tXlUwgwM59o8","fldVAh7rVz4QrHgtY"),
]

# Ferie Estive (letto inline): nome -> lista (inizio, fine)
FERIE_RAW = [
 ("Simone Solario",      [("2026-07-01","2026-07-17")]),
 ("Angelo Taglieri",     [("2026-06-08","2026-06-14"), ("2026-08-17","2026-08-31")]),
 ("Marco Ghironi",       [("2026-07-13","2026-07-19"), ("2026-08-10","2026-08-31"), ("2026-09-21","2026-09-27")]),
 ("Matteo Nigra",        [("2026-07-30","2026-08-03"), ("2026-07-21","2026-07-21"), ("2026-07-30","2026-08-03")]),
 ("Alessandro Ventura",  [("2026-07-13","2026-07-24")]),
 ("Andrea Di Giacomo",   [("2026-05-30","2026-06-15"), ("2026-09-18","2026-10-04")]),
 ("Luca Tumminello",     [("2026-08-18","2026-08-31")]),
 ("Tommaso Murdocca",    [("2026-08-15","2026-08-24")]),
 ("Francesco Castiglione",[("2026-08-07","2026-08-21")]),
 ("Manolo Chirico",      [("2026-06-22", None), ("2026-07-01","2026-07-12")]),
 ("Goffredo d'Onofrio",  [("2026-06-12","2026-06-23")]),
 ("Enrico Zambruno",     [("2026-06-11","2026-06-30"), ("2026-07-01","2026-07-01")]),
 ("Simone Indovino",     [("2026-06-18","2026-06-30"), ("2026-07-01","2026-07-02")]),
 ("Nicola Bondavalli",   [("2026-06-06","2026-06-19"), ("2026-07-06","2026-07-12")]),
 ("Giuseppe Broggini",   [("2026-06-23","2026-06-30"), ("2026-07-01","2026-07-03"),
                          ("2026-08-03","2026-08-09"), ("2026-09-21","2026-09-27")]),
 ("Adele Stigliano",     [("2026-08-03","2026-08-11")]),
 ("Roberto Ugliono",     [("2026-08-21","2026-08-31"), ("2026-09-01","2026-09-06")]),
]
# Nota: "Manolo Chirico" ha Inizio Ferie Giugno = 2026-06-22 senza Fine Giugno valorizzata.

def pid(nome):
    """minuscolo, parole ordinate alfabeticamente, poi apostrofi come separatori."""
    parole = sorted(w for w in nome.lower().split() if w)
    return re.sub(r"[’']", "-", "-".join(parole))


# i reparti sono definiti per nome e normalizzati con pid(), non scritti a mano
SOCIAL = {pid(n) for n in ("Castiglione Francesco", "Crivellaro Irene",
                           "Murdocca Tommaso", "Solario Simone", "Ugliono Roberto")}
GRAFICA = {pid(n) for n in ("Ventura Alessandro",)}


def reparto(i):
    if i in SOCIAL:  return "social"
    if i in GRAFICA: return "grafica"
    return "redazione"


KEYWORDS = {
    "OFF": "off",
    "FERIE": "ferie",
    "RECUPERO OFF": "recupero",
    "RECUPERO": "recupero",
    "FESTIVO": "festivo",
}
RX_ORARIO = re.compile(r"^(\d{1,2})(?:[.,](\d{2}))?-(\d{1,2})(?:[.,](\d{2}))?$")

non_convertiti = collections.Counter()


def parse_orario(v):
    """-> dict tipo/inizio/fine, oppure None se da saltare."""
    s = v.strip()
    if s.upper() in ("N/A", ""):
        return None
    if s.upper() in KEYWORDS:
        return {"tipo": KEYWORDS[s.upper()]}
    m = RX_ORARIO.match(s)
    if m:
        h1, m1, h2, m2 = m.group(1), m.group(2) or "00", m.group(3), m.group(4) or "00"
        return {"tipo": "lavoro",
                "inizio": f"{int(h1):02d}:{m1}",
                "fine":   f"{int(h2):02d}:{m2}"}
    non_convertiti[s] += 1
    return None


LUOGO_ESATTI = {"SEDE": "sede", "ESTERNA": "esterna", "TRASFERTA": "esterna"}


def parse_attivita(labels):
    luogo, resto = None, []
    for lab in labels:
        u = lab.strip().upper()
        if u in LUOGO_ESATTI:
            if luogo is None: luogo = LUOGO_ESATTI[u]
        elif "SMART" in u:
            if luogo is None: luogo = "smart"
        else:
            resto.append(lab)
    return luogo, resto


def main():
    # --- unisci i record dei tre file per record id ---
    celle_raw = {}   # recid -> {fieldid: value}
    persona_di = {}  # recid -> nome
    noti = set()
    for _, o, a in GIORNI:
        noti.add(o); noti.add(a)
    noti.add(FLD_PERSONA)

    for path in FILES:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for rec in data["records"]:
            cv = rec.get("cellValuesByFieldId") or {}
            sconosciuti = set(cv) - noti
            if sconosciuti:
                sys.exit(f"ERRORE: campi non mappati {sconosciuti} in {path}")
            celle_raw.setdefault(rec["id"], {}).update(cv)
            if FLD_PERSONA in cv:
                persona_di[rec["id"]] = cv[FLD_PERSONA]

    righe_vuote = len(celle_raw) - len(persona_di)

    persone = {}
    turni = {}
    n_celle = 0
    senza_orario_con_attivita = 0

    for recid, nome in sorted(persona_di.items(), key=lambda kv: kv[1]):
        i = pid(nome)
        if i in persone and persone[i]["nome"] != nome:
            sys.exit(f"ERRORE: id duplicato {i}: {persone[i]['nome']} / {nome}")
        persone[i] = {"id": i, "nome": nome, "reparto": reparto(i)}
        cv = celle_raw[recid]
        for data, fo, fa in GIORNI:
            cel_o = cv.get(fo)
            cel_a = cv.get(fa)
            voce = parse_orario(cel_o["name"]) if cel_o else None
            if voce is None:
                if cel_a:
                    senza_orario_con_attivita += 1
                continue
            if cel_a:
                luogo, resto = parse_attivita([x["name"] for x in cel_a])
                if luogo:
                    voce["luogo"] = luogo
                if resto:
                    voce["attivita"] = resto
            turni.setdefault(data, {})[i] = voce
            n_celle += 1

    # --- assenze dalle Ferie Estive ---
    assenze, visti = [], set()
    dup = 0
    for nome, periodi in FERIE_RAW:
        i = pid(nome)
        if i not in persone:
            persone[i] = {"id": i, "nome": nome, "reparto": reparto(i)}
        for da, a in periodi:
            a = a or da
            chiave = (i, da, a)
            if chiave in visti:
                dup += 1
                continue
            visti.add(chiave)
            assenze.append({"id": f"{i}-{da}", "persona": i,
                            "tipo": "ferie", "da": da, "a": a})

    out = {
        "versione": 1,
        "persone": [persone[k] for k in sorted(persone)],
        "turni": {d: turni[d] for d in sorted(turni)},
        "assenze": sorted(assenze, key=lambda x: (x["da"], x["persona"])),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")

    date = sorted(turni)
    print(f"record totali letti      : {len(celle_raw)}")
    print(f"righe senza Persona      : {righe_vuote}")
    print(f"persone                  : {len(out['persone'])}")
    print(f"giorni con turni         : {len(date)}")
    print(f"prima data / ultima data : {date[0]} / {date[-1]}")
    print(f"celle totali             : {n_celle}")
    print(f"assenze                  : {len(assenze)} (duplicati esatti scartati: {dup})")
    print(f"celle con attivita' ma senza orario utilizzabile: {senza_orario_con_attivita}")
    print(f"orari NON convertiti     : {dict(non_convertiti) or 'nessuno'}")


if __name__ == "__main__":
    main()
