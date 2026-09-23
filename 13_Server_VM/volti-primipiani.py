#!/usr/bin/env python3
"""Trova i primi piani di una partita e prova a dargli un nome, in due modi.

Un primo piano e' due domande diverse, e conviene tenerle separate.

  1. E' un primo piano?  Lo dice la misura: in campo largo un volto occupa
     il due o tre per cento dell'altezza del fotogramma, in un primo piano
     un quinto. Non serve sapere chi sia.

  2. Chi e'?  Due risposte, calcolate tutte e due e messe a confronto:
     - PER DEDUZIONE: il primo piano subito dopo un'azione e' quasi sempre
       del protagonista di quell'azione, e il suo nome ce l'abbiamo gia'
       dagli appunti e da ESPN. Costa zero.
     - PER VOLTO: il confronto con gli scontornati, ristretto alle due rose
       di quella sera. Quaranta facce, non settemila: e' il motivo per cui
       la cosa gira su due core.

Serve a capire quanto spesso la deduzione basta da sola, prima di mandare
il riconoscimento su tutto l'archivio.

I fotogrammi li estrae la EC2 dentro la regione del bucket e qui arriva
solo l'immagine: il file non si scarica mai.

    /opt/volti/bin/python volti-primipiani.py --rec recJAvpsrqhFIMJ2L --foglio /tmp/pp.jpg
"""
import argparse
import io
import json
import os
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

DATI = "/var/lib/comotv/clip"
CASA = "/var/lib/comotv/volti"
MODELLI = "/opt/volti/modelli"
API = "http://127.0.0.1:8080/api"
PONTE = "http://127.0.0.1:8095"
LATO = 960          # a 640 il volto di un primo piano e' 70 px: SFace ne vuole 112
QUOTA = 0.18        # il volto piu' grande oltre il 18% dell'altezza: primo piano
VICINO = 0.50       # gli autori di SFace dicono 0.363, ma su un fotogramma di
                    # diretta (compresso, mosso, di taglio) sotto il mezzo e'
                    # rumore: meglio dire "non lo so" che dire un nome sbagliato
STACCO = 0.05       # e il secondo deve stare indietro: due che si somigliano
                    # uguale vogliono dire che non si e' riconosciuto nessuno
CERTO = 0.62        # per dire un nome da solo, senza chiedere conferma,
DISTACCO = 0.10     # serve molto di piu', e serve che lo dica anche l'azione
PROPOSTE = 3        # quanti nomi mettere in fila quando non si e' sicuri
CONFERME = "conferme.json"


def api(corpo, attesa=300):
    r = urllib.request.Request(API, json.dumps(corpo).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=attesa))


def piatto(s):
    """Senza accenti e in minuscolo: gli scontornati si chiamano cosi'."""
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def cognome(nome_intero):
    """"Jordy Alcivar" -> "alcivar". Gli scontornati sono per cognome."""
    pezzi = [p for p in piatto(nome_intero).split("-") if p]
    return pezzi[-1] if pezzi else ""


def chi_nomina(riga, rosa):
    """Il protagonista dell'azione. La riga di ESPN lo mette dopo il punto
    mediano ("Occasione - Jordy Alcivar"), quella del giornalista dentro la
    prosa ("GOL di Bruno Henrique, colpo di testa"): invece di indovinare la
    forma della frase si cerca nel testo un cognome delle due rose. Cosi'
    "Delay in match (Flamengo)" non nomina nessuno, ed e' giusto.
    """
    if riga.get("giocatore"):
        return riga["giocatore"]
    testo = "-" + piatto((riga.get("titolo") or "") + " " + (riga.get("dettaglio") or "")) + "-"
    trovati = [(testo.find("-" + c + "-"), n) for c, n in rosa.items() if ("-" + c + "-") in testo]
    return min(trovati)[1] if trovati else ""


# ── LA GALLERIA ────────────────────────────────────────────────────────
def galleria_ristretta(rose):
    """Solo i volti delle due squadre di stasera. Cercare fra settemila
    scontornati vuol dire trovare omonimi che non sono nemmeno in campo."""
    vettori = np.load(CASA + "/galleria.npy")
    elenco = json.load(open(CASA + "/galleria.json"))
    voluti = {}
    for squadra, gente in (rose or {}).items():
        for nome in gente:
            voluti.setdefault(cognome(nome), (nome, squadra))
    # anche i due allenatori: sono quelli che prendono piu' primi piani di tutti
    for squadra in (rose or {}):
        voluti.setdefault("coach-" + piatto(squadra), ("allenatore " + squadra, squadra))
    dentro, chi = [], []
    for i, r in enumerate(elenco):
        k = ("coach-" + r["nome"]) if r["ruolo"] == "allenatore" else r["nome"]
        if k in voluti:
            dentro.append(i)
            chi.append({"nome": voluti[k][0], "squadra": voluti[k][1], "file": r["file"]})
    if not dentro:
        return None, []
    v = vettori[dentro].astype(np.float32)
    v /= (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)
    return v, chi


def quanto_sicuri(x, confermato):
    """Tre stati, non due. Un nome si scrive da solo SOLO quando due fonti
    indipendenti dicono la stessa cosa: il volto con largo margine e l'azione
    che nomina quella persona. Tutto il resto diventa una proposta da
    confermare, e quello che non somiglia a nessuno resta senza nome — che e'
    una risposta buona, non un fallimento."""
    if confermato is not None:
        return confermato.get("chi", ""), "confermato"
    p = x.get("proposte") or []
    if not p:
        return "", "senza nome"
    primo, secondo = p[0], (p[1]["quanto"] if len(p) > 1 else 0.0)
    daccordo = x.get("dedotto") and cognome(primo["chi"]) == cognome(x["dedotto"])
    if primo["quanto"] >= CERTO and (primo["quanto"] - secondo) >= DISTACCO and daccordo:
        return primo["chi"], "certo"
    if primo["quanto"] >= VICINO - 0.08:
        return "", "da confermare"
    return "", "senza nome"


def di_faccia(volto):
    """Un volto di taglio o di spalle non si riconosce, e non e' nemmeno un
    primo piano: e' una nuca grande. YuNet segna anche gli occhi, e la loro
    distanza rispetto alla larghezza della testa dice quanto la persona e'
    girata: misurata su una partita intera sta sotto 0,2 quando e' di profilo
    e sale a 0,3-0,47 quando guarda verso di noi. L'inclinazione separa chi
    e' di faccia da chi ha la testa rovesciata in una scivolata."""
    larga = float(volto[2])
    ox, oy, sx, sy = volto[4:8]
    occhi = float(np.hypot(sx - ox, sy - oy))
    if occhi < 0.26 * larga:
        return False
    return abs(float(sy - oy)) <= 0.45 * occhi


# ── I FOTOGRAMMI ───────────────────────────────────────────────────────
CANTINA = ""


def fotogramma(chiave, sec):
    """I fotogrammi si tengono da parte. Leggere un fotogramma da S3 costa
    fra 40 kB e un mega a seconda di com'e' fatto il file, e riprovare a dare
    un nome agli stessi primi piani non deve costare una seconda lettura."""
    tenuto = os.path.join(CANTINA, "%09.1f.jpg" % sec) if CANTINA else ""
    if tenuto and os.path.exists(tenuto):
        return cv2.imread(tenuto, cv2.IMREAD_COLOR)
    u = PONTE + "/f?" + urllib.parse.urlencode({"k": chiave, "t": "%.1f" % sec, "w": str(LATO), "q": "4"})
    try:
        with urllib.request.urlopen(u, timeout=150) as r:
            if r.status != 200:
                return None
            dati = r.read()
    except Exception:
        return None
    if tenuto:
        open(tenuto, "wb").write(dati)
    return cv2.imdecode(np.frombuffer(dati, np.uint8), cv2.IMREAD_COLOR)


def letture_s3():
    try:
        return json.load(urllib.request.urlopen(PONTE + "/conto", timeout=10)).get("giorno_byte", 0)
    except Exception:
        return 0


def leggi_conferme():
    try:
        return json.load(open(os.path.join(CASA, CONFERME)))
    except Exception:
        return {}


def scrivi_conferma(rec, sec, chi):
    """Quello che dici tu vale piu' di qualunque somiglianza, e vale per
    sempre: la prossima lettura non ti richiede la stessa cosa. Un nome
    vuoto vuol dire "nessuno di questi", ed e' una risposta buona."""
    tutte = leggi_conferme()
    tutte.setdefault(rec, {})["%.1f" % float(sec)] = {
        "chi": chi, "quando": time.strftime("%Y-%m-%dT%H:%M:%S")}
    os.makedirs(CASA, exist_ok=True)
    json.dump(tutte, open(os.path.join(CASA, CONFERME), "w"), ensure_ascii=False, indent=1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rec", required=True)
    p.add_argument("--prima", type=float, default=5, help="secondi prima dell'azione")
    p.add_argument("--dopo", type=float, default=35, help="secondi dopo: il replay e le facce stanno li'")
    p.add_argument("--passo", type=float, default=2.5)
    p.add_argument("--foglio", default="", help="dove scrivere il provino da guardare")
    p.add_argument("--conferma", action="append", default=[],
                   help="1188.0=Martin Baturina  oppure  1188.0=  per \"nessuno di questi\"")
    a = p.parse_args()

    for c in a.conferma:
        sec, _, chi = c.partition("=")
        scrivi_conferma(a.rec, sec, chi.strip())
        print("segnato: %ss -> %s" % (sec, chi.strip() or "nessuno di questi"))

    os.environ.setdefault("OPENCV_LOG_LEVEL", "SILENT")
    arch = json.load(open(DATI + "/archivio.json"))[a.rec]
    espn = json.load(open(DATI + "/espn.json")).get(a.rec) or {}
    pezzi = arch.get("pezzi") or []
    if len(pezzi) != 1:
        print("per ora una registrazione di un pezzo solo (questa ne ha %d)" % len(pezzi))
        return
    chiave = pezzi[0]["chiave"]
    global CANTINA
    CANTINA = os.path.join(CASA, "fotogrammi", a.rec)
    os.makedirs(CANTINA, exist_ok=True)

    reg = api({"tipo": "clip-archivio-apri", "rec": a.rec})["reg"]["id"]
    righe = api({"tipo": "clip-tabellino", "reg": reg}).get("righe") or []
    print("%s — %d azioni" % (arch.get("partita"), len(righe)))

    rose = espn.get("rose") or {}
    rosa = {}
    for squadra, gente in rose.items():
        for n in gente:
            rosa.setdefault(cognome(n), n)
    volti, nomi = galleria_ristretta(rose)
    coperti = len(set(cognome(x["nome"]) for x in nomi) & set(rosa))
    print("rose: %d giocatori | con una foto in casa: %d su %d cognomi | scontornati in gara: %d"
          % (sum(len(x) for x in rose.values()), coperti, len(rosa), len(nomi)))
    if len(nomi) > len(rosa) * 1.3:
        print("  ATTENZIONE: piu' scontornati che giocatori. Gli omonimi di altri")
        print("  campionati entrano in gara e il riconoscimento non vale niente.")

    # i secondi da guardare: attorno a ogni azione, senza chiedere due volte
    # lo stesso fotogramma quando due azioni sono vicine
    quando = {}
    for k, r in enumerate(righe):
        t = float(r.get("t") or 0)
        s = t - a.prima
        while s <= t + a.dopo:
            quando.setdefault(round(s * 2) / 2, k)
            s += a.passo
    secondi = sorted(quando)
    print("fotogrammi da chiedere: %d" % len(secondi))

    prima = letture_s3()
    inizio = time.time()
    with ThreadPoolExecutor(4) as pool:   # il lavoro lo fa la EC2, non noi
        immagini = list(pool.map(lambda s: (s, fotogramma(chiave, s)), secondi))
    print("presi in %.0f s — S3 letti %.1f MB" % (time.time() - inizio, (letture_s3() - prima) / 1e6))

    conferme = leggi_conferme()
    gia_dette = conferme.get(a.rec, {})
    rilevatore = cv2.FaceDetectorYN.create(MODELLI + "/yunet.onnx", "", (LATO, LATO), 0.7, 0.3, 5000)
    traduttore = cv2.FaceRecognizerSF.create(MODELLI + "/sface.onnx", "")
    primi, visti = [], 0
    for sec, im in immagini:
        if im is None:
            continue
        visti += 1
        h, w = im.shape[:2]
        rilevatore.setInputSize((w, h))
        _, facce = rilevatore.detect(im)
        if facce is None or len(facce) == 0:
            continue
        volto = max(facce, key=lambda f: f[2] * f[3])
        quota = float(volto[3]) / h
        if quota < QUOTA or not di_faccia(volto):
            continue
        riga = righe[quando[sec]]
        dedotto = chi_nomina(riga, rosa)
        proposte = []
        if volti is not None:
            v = traduttore.feature(traduttore.alignCrop(im, volto)).flatten().astype(np.float32)
            v /= (np.linalg.norm(v) + 1e-9)
            somiglianze = volti @ v
            for i in np.argsort(-somiglianze)[:PROPOSTE]:
                proposte.append({"chi": nomi[int(i)]["nome"], "squadra": nomi[int(i)]["squadra"],
                                 "quanto": round(float(somiglianze[int(i)]), 3)})
        x = {"t": sec, "quota": round(quota, 3), "azione": riga.get("titolo", ""),
             "minuto": riga.get("minuto", ""), "dedotto": dedotto, "proposte": proposte,
             "_im": im, "_box": volto[:4].astype(int)}
        x["chi"], x["certezza"] = quanto_sicuri(x, gia_dette.get("%.1f" % sec))
        primi.append(x)

    gruppi = {"confermato": [], "certo": [], "da confermare": [], "senza nome": []}
    for x in primi:
        gruppi[x["certezza"]].append(x)
    print("\n--- %d fotogrammi letti, %d primi piani ---" % (visti, len(primi)))
    for nome in ("confermato", "certo", "da confermare", "senza nome"):
        print("  %-14s %d" % (nome, len(gruppi[nome])))

    for nome in ("confermato", "certo"):
        for x in gruppi[nome]:
            print("\n  %7.1fs  %s  ->  %s  (%s)" % (x["t"], x["minuto"], x["chi"], nome))
    if gruppi["da confermare"]:
        print("\n--- da confermare: chi e'? ---")
        for x in gruppi["da confermare"]:
            print("  %7.1fs  %-7s %s" % (x["t"], x["minuto"], x["azione"][:40]))
            if x["dedotto"]:
                print("           l'azione nomina: %s" % x["dedotto"])
            for i, q in enumerate(x["proposte"], 1):
                print("           %d) %-24s %-18s %.2f" % (i, q["chi"], q["squadra"][:18], q["quanto"]))
    if gruppi["senza nome"]:
        print("\n--- senza nome (nessuno somiglia abbastanza) ---")
        for x in gruppi["senza nome"]:
            print("  %7.1fs  %-7s %s" % (x["t"], x["minuto"], x["azione"][:50]))

    os.makedirs(CASA, exist_ok=True)
    json.dump([{k: v for k, v in x.items() if not k.startswith("_")} for x in primi],
              open(CASA + "/primipiani-" + a.rec + ".json", "w"), ensure_ascii=False, indent=1)

    if a.foglio and primi:
        provino(primi, a.foglio)
        print("provino: " + a.foglio)


def provino(primi, dove):
    """Un foglio da guardare: il fotogramma, il volto riquadrato, e sotto i
    due nomi. Serve a decidere con gli occhi, non con le statistiche."""
    COL, LARG, ALT, PIE = 4, 320, 180, 46
    righe = (len(primi) + COL - 1) // COL
    tela = np.full((righe * (ALT + PIE), COL * LARG, 3), 22, np.uint8)
    for i, x in enumerate(primi):
        im = cv2.resize(x["_im"], (LARG, ALT))
        s = LARG / x["_im"].shape[1]
        bx, by, bw, bh = (x["_box"] * s).astype(int)
        cv2.rectangle(im, (bx, by), (bx + bw, by + bh), (90, 200, 255), 1)
        r, c = divmod(i, COL)
        y, xx = r * (ALT + PIE), c * LARG
        tela[y:y + ALT, xx:xx + LARG] = im
        f = cv2.FONT_HERSHEY_SIMPLEX
        cv2.putText(tela, "%.0fs  %s" % (x["t"], piatto(x["minuto"])), (xx + 6, y + ALT + 14), f, 0.38, (150, 150, 150), 1, cv2.LINE_AA)
        if x["chi"]:
            cv2.putText(tela, piatto(x["chi"])[:30], (xx + 6, y + ALT + 29), f, 0.44, (140, 250, 160), 1, cv2.LINE_AA)
            cv2.putText(tela, x["certezza"], (xx + 6, y + ALT + 42), f, 0.34, (110, 160, 120), 1, cv2.LINE_AA)
        elif x["proposte"] and x["certezza"] == "da confermare":
            for j, q in enumerate(x["proposte"][:2]):
                cv2.putText(tela, "%d) %s %.2f" % (j + 1, piatto(q["chi"])[:20], q["quanto"]),
                            (xx + 6, y + ALT + 29 + j * 13), f, 0.36, (120, 200, 250), 1, cv2.LINE_AA)
        else:
            cv2.putText(tela, "senza nome", (xx + 6, y + ALT + 30), f, 0.38, (120, 120, 120), 1, cv2.LINE_AA)
    cv2.imwrite(dove, tela, [cv2.IMWRITE_JPEG_QUALITY, 88])


if __name__ == "__main__":
    main()
