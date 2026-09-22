#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Chi gioca in questo file? Lo chiede al tabellone.

  python3 riconosci.py file.mp4 durata_in_secondi candidati.json

I candidati sono le partite che quel giorno, a quell'ora, potrebbero essere
quella del file: [{"rec": "recXXX", "nome": "WOLFSBERGER-LASK LINZ 1-3"}, ...].
Torna quella scelta, se una c'e', con il perche'.

Perche' serve: meta' dei file dell'archivio non dice che partita e' — si
chiamano "MultiCorder3 - Output 1 - 01 settembre 2026 - 07-26-43.mp4". Il
giorno e l'ora restringono il campo a due o tre partite, ma non lo chiudono:
Como TV ne registra parecchie in parallelo. Il tabellone in sovrimpressione
invece dice chi gioca e come sta finendo, e quello chiude la questione.

Si legge in due posti: verso la FINE per il risultato finale — che nel nome
della partita su Airtable c'e' scritto, ed e' un confronto esatto — e in
mezzo per le sigle delle squadre, perche' in fondo c'e' spesso la grafica di
fine partita che copre la barra.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image, ImageOps

FFMPEG = os.environ.get("COMOTV_FFMPEG", "ffmpeg")
TESSERACT = os.environ.get("COMOTV_TESSERACT", "tesseract")
OROLOGIO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "orologio.py")


PONTE = os.environ.get("COMOTV_S3_PONTE", "").rstrip("/")


def fotogramma(file, secondi, fuori):
    # dietro il ponte S3 (la EC2 a Parigi) il fotogramma lo estrae la EC2:
    # qui arriva la sola fascia alta, poche decine di kB invece di un GOP
    if PONTE and file.startswith(PONTE + "/o/"):
        import urllib.request, urllib.parse
        chiave = urllib.parse.unquote(file[len(PONTE) + 3:])
        q = urllib.parse.urlencode({"k": chiave, "t": str(int(max(0, secondi))), "c": "top", "fmt": "png"})
        try:
            with urllib.request.urlopen(PONTE + "/f?" + q, timeout=150) as r:
                dati = r.read()
            if len(dati) < 1000:
                return False
            open(fuori, "wb").write(dati)
            return True
        except Exception:
            return False
    try:
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error",
                        "-ss", str(int(max(0, secondi))), "-i", file, "-frames:v", "1",
                        "-vf", "crop=iw:ih*0.25:0:0", "-y", fuori],
                       timeout=180, check=False)
    except Exception:
        return False
    return os.path.exists(fuori) and os.path.getsize(fuori) > 1000


def leggi(img, psm="7"):
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    img.save(tmp.name)
    try:
        out = subprocess.run([TESSERACT, tmp.name, "stdout", "--psm", psm],
                             capture_output=True, text=True, timeout=60).stdout
        return " ".join(out.split())
    except Exception:
        return ""
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def barra(png, targa, quanto):
    """La barra del tabellone attorno alla targa del cronometro.

    Ancorarla alla targa e' quello che la rende affidabile: cercare "una
    grafica" in ogni fotogramma a volte trovava un cartellone pubblicitario.
    La targa invece e' quella del cronometro, che sappiamo gia' dov'e'.
    """
    x, y, w, h = targa
    im = Image.open(png).convert("L")
    W, H = im.size
    x0, x1 = max(0, int(x - h * quanto)), min(W, int(x + w + h * quanto))
    y0, y1 = max(0, y - 5), min(H, y + h + 5)
    if x1 - x0 < 30 or y1 - y0 < 10:
        return None
    c = im.crop((x0, y0, x1, y1))
    k = max(2, int(round(95.0 / max(1, y1 - y0))))
    return c.resize((c.width * k, c.height * k), Image.LANCZOS)


def targa_credibile(t):   # preferita nella ricerca, non obbligatoria
    """La targa del cronometro e' piccola: quattro cifre e i due punti.

    Senza questo controllo passava anche tutta la barra del tabellone — 552
    per 154 pixel — e allora la finestra costruita attorno prendeva mezzo
    stadio, dentro cui il lettore trova qualunque cosa tranne le squadre.
    """
    if not t or len(t) != 4:
        return False
    w, h = t[2], t[3]
    if h < 12 or h > 70 or w < 28 or w > 280:
        return False
    return 1.4 <= (w / float(h)) <= 7.0


def trova_targa(file, durata):
    """Dov'e' il cronometro: due fotogrammi a venti secondi, e lo dice orologio.py.

    Si accetta SOLO la targa che orologio.py ha verificato — quella su cui ha
    letto due orari a venti secondi l'uno dall'altro. E' l'unica garanzia che
    quel rettangolo sia il cronometro e non un cartellone: un riquadro preso
    per somiglianza, senza quella prova, porta la finestra dall'altra parte
    del campo e da li' non si legge piu' niente.
    """
    for frazione in (0.45, 0.62, 0.30, 0.75, 0.55, 0.38, 0.68, 0.22):
        t = int(durata * frazione)
        a, b = tempfile.mktemp(suffix=".png"), tempfile.mktemp(suffix=".png")
        try:
            if not fotogramma(file, t, a) or not fotogramma(file, t + 20, b):
                continue
            try:
                o = json.loads(subprocess.run(["python3", OROLOGIO, a, b],
                                              capture_output=True, text=True, timeout=240).stdout)
            except Exception:
                continue
            if o.get("cifre"):
                return o["cifre"]
        finally:
            for f in (a, b):
                try:
                    os.unlink(f)
                except OSError:
                    pass
    return None


SCARTA = {"AM", "PM", "LIVE", "HALF", "TIME", "FULL", "HT", "FT"}


def momenti(durata, inizio1, inizio2):
    """Quando guardare. Con il cronometro letto si guarda la PARTITA, non il
    file: verso il novantesimo per il risultato finale — che e' quello scritto
    nel nome su Airtable — e a meta' tempo per le squadre, perche' alla fine
    c'e' spesso la grafica dei titoli che copre la barra. Senza cronometro si
    va a percentuali del file, che e' peggio: un file con tredici minuti di
    cartello e diciassette di intervallo non e' la partita."""
    if inizio1 is not None and inizio2 is not None:
        q = [(inizio2 + 2700, 2), (inizio2 + 2400, 2), (inizio1 + 1500, 1),
             (inizio1 + 2100, 1), (inizio2 + 900, 1), (inizio1 + 600, 1)]
        return [(t, w) for t, w in q if 30 <= t <= durata - 20]
    return [(durata * f, w) for f, w in ((0.93, 2), (0.88, 2), (0.55, 1), (0.35, 1), (0.70, 1))]


def guarda(file, durata, targa, inizio1=None, inizio2=None):
    """Le sigle lette e i risultati visti, con il peso: quello che si vede
    verso la fine conta il doppio, perche' li' il risultato e' quello finale."""
    sigle, risultati = {}, {}
    for quando, peso in momenti(durata, inizio1, inizio2):
        png = tempfile.mktemp(suffix=".png")
        try:
            if not fotogramma(file, int(quando), png):
                continue
            # attorno alla targa si allarga di parecchio: le squadre e il
            # risultato stanno di fianco al cronometro, e quanto lontano
            # dipende da come e' disegnata la grafica. Tre larghezze, e si
            # tiene tutto quello che si legge.
            for quanto in (7, 4, 11):
                im = barra(png, targa, quanto)
                if im is None:
                    continue
                for z in (im, ImageOps.invert(im)):
                    s = leggi(z)
                    if not s:
                        continue
                    for w in re.findall(r"[A-Za-z]{2,6}", s):
                        w = w.upper()
                        if w in SCARTA:
                            continue
                        sigle[w] = sigle.get(w, 0) + 1
                    for m in re.finditer(r"(?<![\d:])(\d{1,2})\s*[-:]\s*(\d{1,2})(?![\d:])", s):
                        a, b = int(m.group(1)), int(m.group(2))
                        if a <= 9 and b <= 9:
                            k = "%d-%d" % (a, b)
                            risultati[k] = risultati.get(k, 0) + peso
        finally:
            try:
                os.unlink(png)
            except OSError:
                pass
    return sigle, risultati


COMUNI = re.compile(r"\b(FC|AC|SC|SK|CF|CD|AS|SS|US|CA|RC|BK|IF|U\d+)\b")


def parole(nome):
    n = re.sub(r"\(.*?\)", "", nome.upper())
    n = re.sub(r"\[.*?\]", "", n)
    n = re.sub(r"\b\d+-\d+\b", "", n)
    n = COMUNI.sub(" ", n)
    return [w for w in re.split(r"[^A-ZÀ-Ù]+", n) if len(w) >= 3]


def combacia(sigla, nome):
    """Quanto una sigla del tabellone somiglia a un nome di squadra.

    Le sigle non sono le prime tre lettere del nome scritto su Airtable: sono
    come si chiama il club. SCR e' SC Rapid, WAC e' Wolfsberger AC, ASK sta
    dentro LASK. Quindi si prova in quattro modi, dal piu' sicuro al meno.
    """
    s = sigla.upper()
    if len(s) < 2:
        return 0
    ws = parole(nome)
    if not ws:
        return 0
    for w in ws:                                   # BUR -> BURNLEY
        if w.startswith(s):
            return 3
    attaccato = re.sub(r"[^A-Z]", "", nome.upper())
    if len(s) >= 3 and s in attaccato:             # ASK dentro LASK
        return 2
    iniziali = "".join(w[0] for w in re.split(r"[^A-Za-zÀ-ù]+", nome.upper()) if w)
    if len(s) >= 2 and s in iniziali:              # RBS <- Red Bull Salisburgo
        return 2
    prima = ws[0]                                  # BRC <- BRistol City
    i = 0
    for ch in s:
        i = prima.find(ch, i)
        if i < 0:
            return 0
        i += 1
    return 1 if len(s) >= 3 else 0


def scegli(candidati, sigle, risultati):
    piu = sorted(risultati.items(), key=lambda kv: -kv[1])
    voti = []
    for c in candidati:
        nome = c.get("nome") or ""
        v, perche = 0, []
        m = re.search(r"\b(\d{1,2})-(\d{1,2})\b", nome)
        if m:
            atteso = "%s-%s" % (m.group(1), m.group(2))
            if piu and piu[0][0] == atteso:
                v += 4
                perche.append("risultato " + atteso)
            elif atteso in risultati:
                v += 2
                perche.append("risultato " + atteso + " visto a meta'")
        squadre = [p for p in re.split(r"\s*-\s*",
                   re.sub(r"\s*\(.*?\)", "", re.sub(r"\s*\d+-\d+.*$", "", nome))) if p.strip()]
        usate = set()
        for s in sigle:
            best = max((combacia(s, p) for p in squadre), default=0)
            if best >= 2 and s not in usate:
                v += best
                usate.add(s)
                perche.append("%s(%d)" % (s, best))
        voti.append({"rec": c.get("rec"), "nome": nome, "voto": v, "perche": perche})
    voti.sort(key=lambda x: -x["voto"])
    return voti


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"errore": "servono file, durata e candidati"}))
        return 2
    file, durata = sys.argv[1], float(sys.argv[2])
    try:
        candidati = json.loads(sys.argv[3])
    except Exception:
        candidati = []
    # la targa e i due inizi arrivano dal cronometro gia' letto, quando c'e':
    # e' la stessa lettura che serve al tabellino, e non si paga due volte
    targa_data = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] not in ("", "null") else None
    inizio1 = float(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] not in ("", "null") else None
    inizio2 = float(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] not in ("", "null") else None
    if not candidati:
        print(json.dumps({"scelto": None, "perche": "nessun candidato"}))
        return 0
    targa = targa_data if (targa_data and len(targa_data) == 4) else trova_targa(file, durata)
    if not targa:
        print(json.dumps({"scelto": None, "perche": "nessun tabellone trovato"}))
        return 0
    sigle, risultati = guarda(file, durata, targa, inizio1, inizio2)
    voti = scegli(candidati, sigle, risultati)
    # SI SCEGLIE SOLO QUANDO NON CI SONO DUBBI. Un aggancio sbagliato e'
    # peggio di nessun aggancio: mette gli appunti di un'altra partita sopra
    # a questa, e chi monta non ha modo di accorgersene. Serve un voto pieno
    # e un distacco netto dal secondo.
    scelto = None
    if voti and voti[0]["voto"] >= 4 and (len(voti) == 1 or voti[0]["voto"] >= voti[1]["voto"] + 3):
        scelto = voti[0]
    print(json.dumps({"scelto": scelto, "voti": voti[:4], "targa": targa,
                      "sigle": sorted(sigle, key=lambda s: -sigle[s])[:8],
                      "risultati": sorted(risultati.items(), key=lambda kv: -kv[1])[:4]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
