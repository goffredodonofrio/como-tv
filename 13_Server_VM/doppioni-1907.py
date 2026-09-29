#!/usr/bin/env python3
"""
DOPPIONI-1907 — la lista dei doppioni del FRAME, per chi puo' cancellare (Como 1907).
(Goffredo, 29/09/2026: "una lista di doppioni in modo che il team di Como 1907 cancelli le
cose che non servono")

Noi leggiamo soltanto (il FRAME e' montato in sola lettura): qui si PROPONE, cancella il club.
Doppione = stesso nome e stessa dimensione (file sopra 1 MB; i file di servizio piccoli come
XML/THM non contano), poi CONTROLLATO nel contenuto (primi e ultimi 256 KB).

1. CARTELLE COPIATE: una cartella (con tutto quello che ha sotto) e' la copia di UN'ALTRA
   cartella: tutti i suoi file stanno la', e l'altra ha al massimo il 50% di file in piu'.
   (Prima versione scartata: "contenuta in qualunque cosa" proponeva di cancellare l'archivio
   di stagione perche' i file erano finiti anche in un progetto promo.)
2. QUALE TENERE: l'archivio (stagioni, Matchdays, MATCH, Interviews...) prima dei progetti
   derivati (copy, TO SORT, B ROLL, export, documentari, promo, TikTok...); a parita' il
   percorso piu' corto e pulito; se una contiene l'altra, si tiene la piu' completa.
3. SICUREZZA: ogni file deve restare almeno in una copia che non si propone di cancellare.
4. DOPPIONI SPARSI: gli altri file uguali, uno per riga, con la stessa regola su chi tenere.

Scrive /var/lib/comotv-1907/doppioni.json (il Mac ne fa il foglio Excel).
  python3 doppioni-1907.py [--verifica]
"""
import argparse, collections, hashlib, json, os, re, time

R = "/mnt/qnap100-frame"
CASA = "/var/lib/comotv-1907"
OUT = os.path.join(CASA, "doppioni.json")
CACHE = os.path.join(CASA, "impronte.json")
MIN = 1_000_000
PEZZO = 256 * 1024
MARGINE = 1.5          # la cartella tenuta puo' avere al massimo il 50% di file in piu'
MIN_FILE = 2           # una "cartella copiata" ha almeno 2 file grandi
DERIVATI = re.compile(r"copy|copia|\(\d\)|to[ _]?sort|_to_delete|cestino|backup|\bold\b|temp|b[ -]?roll|export|documentar|promo|tiktok|reels?\b|news|"
                      r"celebration|footage for|recap|assets|project|progett|\.dra/|premiere|davinci|render|download", re.I)
ARCHIVIO = re.compile(r"season|stagione|matchday|\bmatch\b|interviews|training|academy|women|first team|pre-season", re.I)


def peggio(p):
    """piu' alto = peggio da tenere (si propone di cancellare)"""
    return (100 if DERIVATI.search(p) else 0) - (30 if ARCHIVIO.search(p.split("/")[0]) else 0) + p.count("/") * 3 + len(p) / 200


def impronta(via, cache):
    if via in cache: return cache[via]
    try:
        with open(os.path.join(R, via), "rb") as f:
            a = f.read(PEZZO); f.seek(0, 2); n = f.tell(); f.seek(max(0, n - PEZZO)); b = f.read(PEZZO)
        h = hashlib.sha1(a + b + str(n).encode()).hexdigest()[:20]
    except OSError:
        h = None
    cache[via] = h
    return h


def main():
    a = argparse.ArgumentParser(); a.add_argument("--verifica", action="store_true")
    x = a.parse_args()
    diretti = collections.defaultdict(dict)          # cartella -> {chiave: nome}
    dove = collections.defaultdict(list)             # chiave -> [cartelle]
    peso = collections.Counter(); nfile = collections.Counter()
    for r in open(os.path.join(CASA, "elenco.tsv"), encoding="utf-8", errors="replace"):
        try: s, m, p = r.rstrip("\n").split("\t", 2)
        except ValueError: continue
        s = int(s); d, _, nome = p.rpartition("/")
        a_ = d.split("/")
        for i in range(1, len(a_) + 1):
            q = "/".join(a_[:i]); peso[q] += s; nfile[q] += 1
        if nome.startswith(".") or s < MIN: continue
        k = (nome.lower(), s); diretti[d][k] = nome; dove[k].append(d)
    # le chiavi di tutto il sottoalbero di ogni cartella
    albero = collections.defaultdict(set)
    for d, ks in diretti.items():
        a_ = d.split("/")
        for i in range(1, len(a_) + 1): albero["/".join(a_[:i])].update(ks)
    parenti = lambda p, q: p == q or p.startswith(q + "/") or q.startswith(p + "/")
    def antenati(d):
        a_ = d.split("/"); return ["/".join(a_[:i]) for i in range(1, len(a_) + 1)]
    # 1. per ogni cartella, l'altra cartella di cui e' copia
    copia = {}
    for A in sorted(albero, key=lambda p: -len(albero[p])):
        KA = albero[A]
        if len(KA) < MIN_FILE: continue
        k0 = min(KA, key=lambda k: len(dove[k]))           # la chiave piu' rara: pochi candidati
        cand = {B for d in dove[k0] for B in antenati(d) if not parenti(A, B)}
        buone = [B for B in cand if len(albero[B]) <= MARGINE * len(KA) and KA <= albero[B]]
        if buone: copia[A] = buone
    # 2. si decide: identiche -> si tiene la meno "derivata"; A dentro B piu' grande -> si tiene B
    proposte = {}
    for A, Bs in copia.items():
        for B in sorted(Bs, key=peggio):
            ident = albero[A] == albero[B]
            if ident and peggio(A) < peggio(B): continue       # A e' la migliore: la cancellata sara' B
            if ident and peggio(A) == peggio(B) and A < B: continue
            # l'archivio non si cancella per tenere un progetto derivato un po' piu' grande: i suoi
            # file uguali vanno tra gli sparsi, e li' si cancella la copia del progetto
            if not ident and peggio(B) - peggio(A) >= 50: continue
            proposte[A] = B; break
    # si tengono solo le piu' alte (una riga per albero copiato)
    scelte = {}
    for A in sorted(proposte, key=lambda p: p.count("/")):
        if any(A.startswith(q + "/") for q in scelte): continue
        scelte[A] = proposte[A]
    # la tenuta non deve essere proposta a sua volta (o stare sotto una proposta)
    for A in list(scelte):
        B, giri = scelte[A], 0
        while giri < 20:
            su = next((q for q in scelte if q != A and (B == q or B.startswith(q + "/"))), None)
            if not su: break
            B = scelte[su]; giri += 1
        if giri >= 20 or parenti(A, B) or not albero[A] <= albero[B]: scelte.pop(A); continue
        scelte[A] = B
    # 3. sicurezza sulle chiavi: ogni file resta almeno in una cartella non proposta
    def proposta(d): return next((q for q in scelte if d == q or d.startswith(q + "/")), None)
    for k, ds in dove.items():
        if all(proposta(d) for d in ds):
            for d in ds:
                q = proposta(d)
                if q: scelte.pop(q, None)
                if not all(proposta(z) for z in ds): break
    # verifica del contenuto: i 5 file piu' grandi di ogni proposta contro la loro copia tenuta
    cache = {}
    try: cache = json.load(open(CACHE))
    except Exception: pass
    diverse = []
    if x.verifica:
        for A, B in list(scelte.items()):
            ks = sorted(albero[A], key=lambda k: -k[1])[:5]
            for k in ks:
                va = next((d + "/" + diretti[d][k] for d in dove[k] if d == A or d.startswith(A + "/")), None)
                vb = next((d + "/" + diretti[d][k] for d in dove[k] if d == B or d.startswith(B + "/")), None)
                if not va or not vb: continue
                ha, hb = impronta(va, cache), impronta(vb, cache)
                if not ha or ha != hb: diverse.append([A, va, vb]); scelte.pop(A, None); break
        json.dump(cache, open(CACHE, "w"))
    righe = [{"cartella": A, "tieni": B, "file": nfile[A], "peso": peso[A], "grandi": len(albero[A]), "piccoli": nfile[A] - sum(len(diretti[d]) for d in diretti if d == A or d.startswith(A + "/")),
              "identica": albero[A] == albero[B], "in_piu": len(albero[B]) - len(albero[A]), "verificata": bool(x.verifica)} for A, B in scelte.items()]
    righe.sort(key=lambda r: -r["peso"])
    # 4. i doppioni sparsi fuori dalle cartelle proposte
    sparsi = []
    # le cartelle tenute al posto di una copia restano intere: i loro file sono i primi da tenere
    tenute = set(scelte.values())
    dentro_tenuta = lambda d: any(d == t or d.startswith(t + "/") for t in tenute)
    for k, ds in dove.items():
        if len(ds) < 2: continue
        fuori = sorted({d for d in ds if not proposta(d)}, key=lambda d: (0 if dentro_tenuta(d) else 1, peggio(d)))
        if len(fuori) < 2: continue
        tieni = fuori[0]
        togli = [d + "/" + diretti[d][k] for d in fuori[1:]]
        sparsi.append({"tieni": tieni + "/" + diretti[tieni][k], "togli": togli, "peso": k[1]})
    if x.verifica:
        # anche qui il contenuto
        # tutti i gruppi (le impronte gia' fatte restano in impronte.json: di notte si aggiungono solo le nuove)
        for s in sorted(sparsi, key=lambda s: -s["peso"] * len(s["togli"])):
            h0 = impronta(s["tieni"], cache)
            s["togli"] = [v for v in s["togli"] if h0 and impronta(v, cache) == h0]
            s["verificato"] = True
        sparsi = [s for s in sparsi if s["togli"]]
        json.dump(cache, open(CACHE, "w"))
    sparsi.sort(key=lambda s: -s["peso"] * len(s["togli"]))
    tc = sum(r["peso"] for r in righe); ts = sum(s["peso"] * len(s["togli"]) for s in sparsi)
    # PER LA PAGINA "DOPPIONI 1907" (Goffredo, 29/09/2026: vederli in anteprima e scegliere):
    # ogni cartella con qualche coppia di file d'esempio (prima i video, i piu' pesanti)
    VID = (".mp4", ".mov", ".mxf", ".m4v", ".mts", ".jpg", ".jpeg", ".png")
    def esempi(A, B, n=6):
        ks = sorted(albero[A], key=lambda k: (0 if k[0].endswith(VID) else 1, -k[1]))
        fuori = []
        for k in ks:
            va = next((d + "/" + diretti[d][k] for d in dove[k] if d == A or d.startswith(A + "/")), None)
            vb = next((d + "/" + diretti[d][k] for d in dove[k] if d == B or d.startswith(B + "/")), None)
            if va and vb: fuori.append([va, vb])
            if len(fuori) >= n: break
        return fuori
    pub = {"aggiornato": int(time.time()), "verifica": bool(x.verifica),
           "cartelle": [dict(r, esempi=esempi(r["cartella"], r["tieni"])) for r in righe],
           "file": [{"a": v, "b": s["tieni"], "peso": s["peso"], "copie": len(s["togli"]) + 1, "verificato": bool(s.get("verificato"))} for s in sparsi for v in s["togli"]]}
    import gzip
    dest = os.path.join(CASA, "pub", "doppioni.json")
    json.dump(pub, open(dest + ".tmp", "w"), ensure_ascii=False, separators=(",", ":"))
    with open(dest + ".tmp", "rb") as f, gzip.open(dest + ".gz.tmp", "wb", 9) as g: g.write(f.read())
    os.replace(dest + ".gz.tmp", dest + ".gz"); os.replace(dest + ".tmp", dest)
    json.dump({"aggiornato": int(time.time()), "cartelle": righe, "sparsi": sparsi, "diverse": diverse, "totale_cartelle": tc, "totale_sparsi": ts,
               "file_totali": sum(1 for _ in dove), "tb_totali": peso[""] if "" in peso else None}, open(OUT, "w"), ensure_ascii=False)
    print("cartelle copiate: %d (%.2f TB) · doppioni sparsi: %d gruppi (%.2f TB) · diverse nel contenuto: %d" % (len(righe), tc / 1e12, len(sparsi), ts / 1e12, len(diverse)))


if __name__ == "__main__":
    main()
