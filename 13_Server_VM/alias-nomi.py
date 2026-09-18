#!/usr/bin/env python3
"""COME LI DICONO DA NOI. Dai pezzi trascritti dell'archivio (_corpus) tira
fuori, per ogni nome che ESPN scrive, come lo scrive whisper quando lo sente
dai nostri telecronisti: "Acco Borramonna" per Jacobo Ramon, "Nicopas" per
Nico Paz. Sono le pronunce, e vanno confermate da una persona: qui si
propongono, con quante volte ricorrono e in quali partite.

  alias-nomi.py [cartella _corpus] [api]   → alias-proposti.json + tabella
"""
import json, os, re, sys, glob, subprocess, collections, difflib, unicodedata

CORPUS = sys.argv[1] if len(sys.argv) > 1 else "/var/lib/comotv-dev/clip/_corpus"
API = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8081/api"

def api(c):
    out = subprocess.run(["curl", "-s", "-m", "60", "-X", "POST", API, "-H", "Content-Type: text/plain", "-d", json.dumps(c)],
                         capture_output=True, text=True).stdout
    return json.loads(out)

def piatto(s):
    s = unicodedata.normalize("NFD", s).lower()
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn" and ch.isalpha())

# come suona all'italiana: whisper scrive quello che sente, e un nome
# straniero detto da un italiano cambia lettere in modo prevedibile
SUONI = [("ph", "f"), ("ck", "c"), ("kh", "c"), ("k", "c"), ("y", "i"), ("w", "v"), ("x", "cs"), ("th", "t"),
         ("sch", "sc"), ("tch", "c"), ("j", "g"), ("z", "s"), ("qu", "cu"), ("h", "")]
def suona(s):
    s = piatto(s)
    for a, b in SUONI: s = s.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", s)          # le doppie non si sentono

def somiglianza(a, b):
    return difflib.SequenceMatcher(None, suona(a), suona(b)).ratio()

# parole comuni che whisper scrive maiuscole a inizio frase: non sono nomi
# storpiati, e "Allora" non e' Ati Allah
COMUNI = set("""allora cioe cioè tutto tutti certo santa santo ecco sono mentre ancora poi dopo prima sotto sopra quindi pero però
questo questa quello quella molto bene male subito forse anche adesso oggi ieri domani grande grandi buona buono bella bello
river under tutto niente nulla dentro fuori avanti indietro destra sinistra centro campo palla pallone porta gol rete
primo secondo terzo tempo minuto minuti partita squadra squadre arbitro cross tiro parata angolo rigore fallo
comunque perche perché quando quanto quanti come dove chi che cosa vero falso giusto sempre mai ora qui li lì
attenzione occasione azione ripartenza pressione possesso lancio verticale diagonale corsa duello""".split())
def main():
    vocab = {}
    proposti = collections.defaultdict(lambda: {"n": 0, "partite": set(), "come": collections.Counter()})
    sconosciuti = collections.Counter()
    for f in sorted(glob.glob(os.path.join(CORPUS, "*.info.json"))):
        info = json.load(open(f))
        base = f[:-len(".info.json")]
        try: j = json.load(open(base + ".json"))
        except Exception: continue
        rec = info["rec"]
        if rec not in vocab:
            v = api({"tipo": "clip-vocabolario", "rec": rec, "lingua": "it"}).get("partita") or {}
            nomi = set(v.get("giocatori", []) + v.get("allenatori", []) + v.get("squadre", []))
            forme = {}
            for n in nomi:
                forme[n] = n
                pezzi = n.split()
                if len(pezzi) > 1: forme[pezzi[-1]] = n            # il cognome da solo
            vocab[rec] = forme
        forme = vocab[rec]
        esatte = {piatto(k) for k in forme}
        testo = " ".join(s["text"].strip() for s in (j.get("transcription") or []))
        parole = re.findall(r"[A-Za-zÀ-ÿ']+", testo)
        i = 0
        while i < len(parole):
            w = parole[i]
            if not (w[0].isupper() and len(w) >= 4) or piatto(w) in esatte or piatto(w) in COMUNI: i += 1; continue
            # prima in coppia con la parola dopo (Acco Borramonna), poi da sola
            candidati = []
            if i + 1 < len(parole) and parole[i + 1][0].isupper():
                candidati.append((w + " " + parole[i + 1], 2))
            candidati.append((w, 1))
            preso = False
            for cand, salto in candidati:
                if piatto(cand) in esatte: break
                meglio, voto = None, 0
                for chiave, nome in forme.items():
                    r = somiglianza(cand, chiave)
                    if r > voto: voto, meglio = r, nome
                if meglio and voto >= 0.66 and abs(len(suona(cand)) - len(suona(meglio.split()[-1] if " " not in cand else meglio))) <= 4:
                    p = proposti[(cand.lower(), meglio)]
                    p["n"] += 1; p["partite"].add(info["partita"][:28]); p["come"][cand] += 1; p["voto"] = max(p.get("voto", 0), voto)
                    i += salto; preso = True; break
            if not preso:
                sconosciuti[w] += 1; i += 1
    righe = []
    for (alias, nome), p in proposti.items():
        righe.append({"alias": p["come"].most_common(1)[0][0], "nome": nome, "n": p["n"], "voto": round(p.get("voto", 0), 2), "partite": sorted(p["partite"])})
    # prima quelle sicure: viste piu' volte, o molto simili
    righe.sort(key=lambda x: (-(x["n"] >= 2 or x["voto"] >= 0.8), -x["n"], -x["voto"]))
    json.dump({"alias": righe, "sconosciuti": sconosciuti.most_common(80)}, open(os.path.join(CORPUS, "alias-proposti.json"), "w"), ensure_ascii=False, indent=1)
    print("pezzi letti:", len(glob.glob(os.path.join(CORPUS, "*.info.json"))), "| alias proposti:", len(righe))
    with open(os.path.join(CORPUS, "alias-proposti.txt"), "w") as f:
        f.write("# PRONUNCE PROPOSTE — come whisper scrive il nome quando lo sente dai nostri telecronisti -> nome ESPN\n")
        f.write("# Conferma: lascia la riga. Sbagliata: cancellala o metti # davanti. (n = quante volte, voto = quanto somiglia)\n\n")
        for r in righe:
            f.write("%-24s -> %-30s   n=%d voto=%.2f  %s\n" % (r["alias"], r["nome"], r["n"], r["voto"], "; ".join(r["partite"][:2])))
    for r in righe[:60]:
        print("  %2d× %.2f  %-22s → %-28s %s" % (r["n"], r["voto"], r["alias"], r["nome"], ", ".join(r["partite"][:2])))
    print("-- parole maiuscole senza un nome vicino (soprannomi, modi di dire, errori):")
    print("   " + ", ".join("%s(%d)" % (w, n) for w, n in sconosciuti.most_common(40)))

if __name__ == "__main__":
    main()
