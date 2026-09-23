#!/usr/bin/env python3
"""Rende preciso il puntamento delle azioni su tutto l'archivio.

Due cure, in quest'ordine, partita per partita:

  1. IL CRONOMETRO. Il fischio d'inizio stimato dall'ora nel nome del file
     sbaglia di minuti, e sul secondo tempo anche di sette: cosi' ogni
     azione cade lontano, comprese quelle silenziose. Il cronometro in
     sovrimpressione raddrizza tutta la partita una volta sola.

  2. IL BOATO. Sul punto ormai giusto si cerca il tratto di stadio che non
     prende fiato: inchioda al secondo gol, rigori ed espulsioni.

L'ordine conta: cercare il boato attorno a una stima sbagliata di sette
minuti vuol dire ascoltare il posto sbagliato.

Costa qualche fotogramma e qualche misura audio, tutto fatto sulla EC2
dentro la regione del bucket, cioe' niente. Si ferma da solo se le letture
da S3 di oggi passano gli otto giga (AWS ne regala cento al mese) o se il
MAM sta registrando una diretta. Prima le partite del Como, poi le piu'
recenti.

    setsid nohup python3 comotv-puntamento-giro.py >/dev/null 2>&1 &
    tail -f /tmp/giro-puntamento.log
"""
import json
import time
import urllib.request

DATI = "/var/lib/comotv/clip"
API = "http://127.0.0.1:8080/api"
CONTO = "http://127.0.0.1:8095/conto"
TETTO_GIORNO = 8_000_000_000
LOG = "/tmp/giro-puntamento.log"


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


def da_fare():
    """Le partite che hanno ancora qualcosa da sistemare, in ordine."""
    archivio = json.load(open(DATI + "/archivio.json"))
    appunti = json.load(open(DATI + "/appunti.json"))
    espn = json.load(open(DATI + "/espn.json"))
    coda = []
    for k, a in archivio.items():
        if not (a.get("pezzi") or []):
            continue
        if k not in appunti and not ((espn.get(k) or {}).get("eventi") or []):
            continue
        nome = (a.get("partita") or "").upper()
        if "AUDIO ONLY" in nome:          # un file senza video non ha niente da leggere
            continue
        orologio = bool(a.get("orologio") or a.get("orologioFallito"))
        boato = bool(a.get("boati") or a.get("boatiFatti"))
        if orologio and boato:
            continue
        como = 0 if "COMO" in nome else 1
        giorno = a.get("giorno") or "00000000"
        coda.append((como, -int(giorno) if giorno.isdigit() else 0, k, orologio, boato))
    coda.sort()
    return coda


def main():
    while True:
        coda = da_fare()
        if not coda:
            scrivi("FINITO: tutte le partite hanno cronometro e boato")
            return
        _, _, k, ha_orologio, ha_boato = coda[0]
        restano = len(coda) - 1

        if letti_oggi() > TETTO_GIORNO:
            scrivi("tetto del giorno raggiunto: aspetto un'ora")
            time.sleep(3600)
            continue
        if c_e_una_diretta():
            scrivi("c'e' una diretta: aspetto dieci minuti")
            time.sleep(600)
            continue

        # 1) il cronometro, che raddrizza tutta la partita
        if not ha_orologio:
            try:
                j = api({"tipo": "clip-archivio-ancora", "rec": k, "cronometro": True})
                if j.get("ok"):
                    o = j.get("orologio") or {}
                    scrivi("%s cronometro 1T=%ss 2T=%ss%s" % (
                        k, o.get("inizio1"), o.get("inizio2"),
                        " verificato" if o.get("verificato") else ""))
                else:
                    scrivi("%s cronometro no: %s" % (k, (j.get("errore") or "")[:70]))
            except Exception as e:
                scrivi("%s cronometro rotto: %s" % (k, str(e)[:70]))

        # 2) il boato, cercato dove ormai sappiamo che sta l'azione
        if not ha_boato:
            try:
                j = api({"tipo": "clip-archivio-punta", "rec": k, "tabellone": False})
                e = (j.get("esito") or {}) if j.get("ok") else {}
                scrivi("%s boato %s/%s (restano %d)" % (
                    k, e.get("trovati"), e.get("cercati"), restano))
            except Exception as e:
                scrivi("%s boato rotto: %s (restano %d)" % (k, str(e)[:60], restano))

        time.sleep(2)


if __name__ == "__main__":
    main()
