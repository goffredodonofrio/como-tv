#!/usr/bin/env python3
"""Legge il cronometro a tutte le partite che hanno appunti o eventi ESPN.

Il fischio d'inizio stimato dall'ora nel nome del file sbaglia di minuti, e
sul secondo tempo anche di sette: cosi' ogni azione della partita cade
lontano, comprese quelle silenziose che il boato non puo' aiutare. Il
cronometro in sovrimpressione raddrizza tutta la partita una volta sola, e
costa qualche fotogramma letto sulla EC2 dentro la regione del bucket,
cioe' niente.

Si ferma da solo se le letture da S3 di oggi passano gli otto giga (quello
che AWS regala sono cento giga al mese) oppure se il MAM sta registrando una
diretta. Prima le partite del Como, poi le piu' recenti.

    setsid nohup python3 comotv-orologi-giro.py >/dev/null 2>&1 &
    tail -f /tmp/giro-orologi.log
"""
import json
import time
import urllib.request

DATI = "/var/lib/comotv/clip"
API = "http://127.0.0.1:8080/api"
CONTO = "http://127.0.0.1:8095/conto"
TETTO_GIORNO = 8_000_000_000
LOG = "/tmp/giro-orologi.log"


def api(corpo, attesa=1800):
    r = urllib.request.Request(API, json.dumps(corpo).encode(),
                               {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=attesa))


def scrivi(testo):
    with open(LOG, "a") as f:
        f.write(time.strftime("%H:%M ") + testo + "\n")


def letti_oggi():
    try:
        return json.load(urllib.request.urlopen(CONTO, timeout=10)).get("giorno_byte", 0)
    except Exception:
        return 0


def c_e_una_diretta():
    try:
        j = api({"tipo": "clip-stato"}, 20)
        return any(r.get("stato") == "registra" for r in (j.get("reg") or []))
    except Exception:
        return False


def prossima():
    """La prossima partita da leggere: prima il Como, poi le piu' recenti."""
    archivio = json.load(open(DATI + "/archivio.json"))
    appunti = json.load(open(DATI + "/appunti.json"))
    espn = json.load(open(DATI + "/espn.json"))
    coda = []
    for k, a in archivio.items():
        if a.get("orologio") or a.get("orologioFallito"):
            continue
        if not (a.get("pezzi") or []):
            continue
        if k not in appunti and not ((espn.get(k) or {}).get("eventi") or []):
            continue
        # un file di solo audio non ha un cronometro da leggere
        if "AUDIO ONLY" in (a.get("partita") or "").upper():
            continue
        como = 0 if "COMO" in (a.get("partita") or "").upper() else 1
        giorno = a.get("giorno") or "00000000"
        coda.append((como, -int(giorno) if giorno.isdigit() else 0, k))
    coda.sort()
    return (coda[0][2], len(coda)) if coda else (None, 0)


def main():
    while True:
        k, restano = prossima()
        if not k:
            scrivi("FINITO: non resta nessuna partita senza cronometro")
            return
        if letti_oggi() > TETTO_GIORNO:
            scrivi("tetto del giorno raggiunto: aspetto un'ora")
            time.sleep(3600)
            continue
        if c_e_una_diretta():
            scrivi("c'e' una diretta: aspetto dieci minuti")
            time.sleep(600)
            continue
        try:
            j = api({"tipo": "clip-archivio-ancora", "rec": k, "cronometro": True})
            # il ponte risponde 200 anche quando dice di no: senza questo
            # controllo il giro rileggeva la stessa partita all'infinito
            if not j.get("ok"):
                scrivi("%s no: %s (restano %d)" % (k, (j.get("errore") or "")[:90], restano - 1))
                time.sleep(2)
                continue
            o = j.get("orologio") or {}
            scrivi("%s ok 1T=%ss 2T=%ss%s (restano %d)" % (
                k, o.get("inizio1"), o.get("inizio2"),
                " verificato" if o.get("verificato") else "", restano - 1))
        except Exception as e:
            try:
                msg = json.loads(e.read().decode()).get("errore", "")[:90]
            except Exception:
                msg = str(e)[:90]
            scrivi("%s no: %s (restano %d)" % (k, msg, restano - 1))
        time.sleep(2)


if __name__ == "__main__":
    main()
