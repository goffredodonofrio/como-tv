"""Il piano dello scarico Frame -> NAS 1907 (02/10/2026): cosa, in che ordine, dove.
Ingressi: frame-como1907-elenco.tsv (Frame, con gli id), elenco.tsv (NAS), il foglio Excel del confronto.
Uscita: piano.tsv  priorita  id_frame  byte  azione(sostituisci|nuovo)  destinazione(relativa a COMOTV - FRAME)  progetto"""
import csv, collections, openpyxl, os, re
PRIO = {"Season 2025-2026": 1, "Season 2026-27": 2, "COMO TV: DISCOVER COMO": 3}
fr = collections.defaultdict(list)            # (progetto, percorso) -> [(id, byte)]
for r in csv.reader(open("frame-como1907-elenco.tsv", encoding="utf-8"), delimiter="\t"):
    if r[0].startswith("#") or len(r) < 7 or r[2] != "F" or r[4] == "1": continue
    fr[(r[0], r[1])].append((r[6], int(r[3] or 0)))
nas = {}; nasl = set()
for r in open("elenco.tsv", encoding="utf-8", errors="replace"):
    t = r.rstrip("\n").split("\t", 2)
    if len(t) == 3 and t[0].isdigit(): nas[t[2]] = int(t[0]); nasl.add(t[2].lower())
# il prefisso sulla NAS di ogni progetto: dai file gia' presenti, dove il percorso NAS finisce col percorso Frame
pref = collections.defaultdict(collections.Counter)
perbyte = collections.defaultdict(list)
for p, b in nas.items(): perbyte[(p.rsplit("/", 1)[-1].lower(), b)].append(p)
for (prog, via), lst in fr.items():
    for i, b in lst:
        for p in perbyte.get((via.rsplit("/", 1)[-1].lower(), b), []):
            if p.endswith("/" + via): pref[prog][p[: -len(via) - 1]] += 1
PREF = {k: v.most_common(1)[0][0] for k, v in pref.items()}
# i progetti senza file gia' presenti da cui capirlo: le cartelle che ci sono sulla NAS (02/10/2026)
PREF.update({k: v for k, v in {"Season 2026-27": "2026-2027 Season", "COMO TV: COMO LEGENDS": "COMO TV- COMO LEGENDS",
                               "SUMMER CAMP 2026": "SUMMER CAMP 2026", "SENT Academy": "SENT Academy"}.items() if k not in PREF})
wb = openpyxl.load_workbook("Frame-vs-NAS_Como1907.xlsx", read_only=True)
piano = []; presi = set(); usati = set(nasl); senza = collections.Counter()
def scegli(prog, via, gb, nas_via=None):
    cand = fr.get((prog, via), [])
    if not cand: return None
    i, b = min(cand, key=lambda x: abs(x[1] - gb * 1e9))
    if abs(b - gb * 1e9) > 6e6: return None
    return i, b
for foglio, azione0 in (("Da riscaricare", "sostituisci"), ("Mancano sulla NAS", "nuovo")):
    for r in wb[foglio].iter_rows(min_row=2, values_only=True):
        prog, via, gb = r[0], r[1], r[2] or 0
        azione = azione0
        s = scegli(prog, via, gb)
        if not s: senza[foglio] += 1; continue
        i, b = s
        chiave = (via.rsplit("/", 1)[-1].lower(), b)
        if chiave in presi: continue                       # doppione dentro Frame: una copia basta
        # 02/10/2026: il file rotto sulla NAS si sostituisce SOLO se sta nello stesso percorso
        # che il file ha su Frame. Abbinato per nome soltanto, C0663 della 2025-26 aveva preso
        # il posto di C0663 della 2023-24 (i nomi delle telecamere si ripetono): allora e' "nuovo"
        if azione == "sostituisci" and not (r[4] == PREF.get(prog, prog) + "/" + via or r[4].endswith("/" + via)): azione = "nuovo"
        if azione == "sostituisci": dest = r[4]
        else:
            top = PREF.get(prog, prog); dest = top + "/" + via
            if dest.lower() in usati:                      # un altro file con lo stesso nome: nome distinto
                base, ext = os.path.splitext(dest); dest = base + " [frame " + i[:8] + "]" + ext
        if azione == "sostituisci" and dest.lower() in {x[4].lower() for x in piano if x[3] == "sostituisci"}: continue
        presi.add(chiave); usati.add(dest.lower())
        piano.append((PRIO.get(prog, 4), i, b, azione, dest, prog))
piano.sort(key=lambda x: (x[0], x[3] != "sostituisci", x[5], x[4]))
with open("piano.tsv", "w", encoding="utf-8") as f:
    f.write("# priorita\tid_frame\tbyte\tazione\tdestinazione\tprogetto\n")
    for x in piano: f.write("\t".join(map(str, x)) + "\n")
tot = collections.defaultdict(lambda: [0, 0])
for x in piano: tot[x[0]][0] += 1; tot[x[0]][1] += x[2]
for k in sorted(tot): print("priorita", k, tot[k][0], "file", round(tot[k][1] / 1e12, 2), "TB")
print("totale", len(piano), "file", round(sum(x[2] for x in piano) / 1e12, 2), "TB · senza id:", dict(senza))
print("prefissi:", {k: v for k, v in PREF.items()})
print("progetti senza prefisso:", sorted(set(p for (p, _) in fr) - set(PREF)))
print("rinominati per nome doppio:", sum(1 for x in piano if "[frame " in x[4]))
