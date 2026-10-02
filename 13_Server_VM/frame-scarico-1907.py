#!/usr/bin/env python3
"""Lo scarico da Frame.io alla NAS del Como 1907 (02/10/2026).

Goffredo: riportare sulla NAS (COMOTV - FRAME) quello che su Frame c'e' e sulla
NAS manca o e' rotto, senza i doppioni di Frame. Il piano (piano.tsv) lo fa
piano-scarico.py dal confronto Frame/NAS: priorita', id di Frame, byte,
azione (sostituisci = il file sulla NAS e' vuoto/incompleto/rovinato; nuovo =
manca), destinazione relativa a COMOTV - FRAME.

I link agli originali arrivano dalla scheda di Frame nel Chrome di Goffredo
attraverso frame-ponte-1907.py (link.json). Qui si scarica, nell'ordine del piano:
  - in una copia nascosta accanto alla destinazione (.frame-<id>.part), che riprende
    da dove era se si interrompe;
  - il file vale solo se pesa esattamente quanto su Frame; allora prende il posto
    del file rotto (sostituisci) o il suo nome (nuovo). Un file diverso con lo
    stesso nome non si tocca mai: il nuovo prende un nome distinto;
  - durante una diretta si ferma (clip-stato "registra"), e si ferma del tutto se
    sulla NAS restano meno di MIN_LIBERI byte.
Stato in stato.json (id -> fatto/errore), registro in scarico.log.

Uso: frame-scarico-1907.py [--solo N] [--insieme K]
"""
import json, os, re, subprocess, sys, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

CASA = "/var/lib/comotv-1907/frame-scarico"
RADICE = "/mnt/qnap100-frame-scarico"
PIANO, LINK, STATO, LOG = (os.path.join(CASA, x) for x in ("piano.tsv", "link.json", "stato.json", "scarico.log"))
MIN_LIBERI = 3 * 10**12            # sotto i 3 TB liberi sulla NAS ci si ferma
LOCK = threading.Lock()
FERMO = threading.Event()

def log(t):
    r = time.strftime("%F %T") + " " + t
    print(r, flush=True)
    with LOCK, open(LOG, "a") as f: f.write(r + "\n")

def leggi(p, vuoto):
    try: return json.load(open(p))
    except Exception: return vuoto

def segna(i, st):
    with LOCK:
        s = leggi(STATO, {}); s[i] = dict(st, ts=int(time.time()))
        json.dump(s, open(STATO + ".tmp", "w")); os.replace(STATO + ".tmp", STATO)

def in_diretta():
    try:
        r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8080/api", data=b'{"tipo":"clip-stato"}',
                                   headers={"Content-Type": "application/json"}), timeout=20).read().decode()
        return '"registra"' in r
    except Exception:
        return False

def liberi():
    s = os.statvfs(RADICE); return s.f_bavail * s.f_frsize

def scadenza(u):
    m = re.search(r"[?&]Expires=(\d+)", u); return int(m.group(1)) if m else 0

def link_di(i):
    v = leggi(LINK, {}).get(i)
    return v["url"] if v and scadenza(v["url"]) > time.time() + 900 else None

def nome_libero(dest, i):
    if not os.path.exists(dest): return dest
    base, ext = os.path.splitext(dest); return base + " [frame " + i[:8] + "]" + ext

def uno(x):
    pr, i, byte, azione, rel = x["prio"], x["id"], x["byte"], x["azione"], x["dest"]
    dest = os.path.join(RADICE, rel)
    while not FERMO.is_set():
        if in_diretta(): log("diretta in corso: aspetto"); time.sleep(120); continue
        if liberi() < MIN_LIBERI: log("NAS quasi piena: mi fermo"); FERMO.set(); return
        u = link_di(i)
        if u: break
        time.sleep(30)                                   # il link arriva dalla scheda di Frame
    if FERMO.is_set(): return
    if azione == "nuovo" and os.path.exists(dest) and os.path.getsize(dest) == byte:
        segna(i, {"stato": "fatto", "nota": "c'era gia'"}); return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = os.path.join(os.path.dirname(dest), ".frame-" + i + ".part")
    t0 = time.time(); prima = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    p = subprocess.run(["curl", "-sS", "--fail", "-L", "--retry", "3", "--retry-delay", "10", "-C", "-",
                        "--speed-limit", "100000", "--speed-time", "120", "-o", tmp, u], capture_output=True, text=True)
    ora = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    if p.returncode != 0 or ora != byte:
        err = (p.stderr.strip().splitlines() or ["peso " + str(ora) + " invece di " + str(byte)])[-1][:200]
        if ora > byte: os.remove(tmp)                    # piu' grande del vero: si ricomincia da capo
        segna(i, {"stato": "errore", "errore": err}); log("ERRORE " + rel + ": " + err); return
    if azione == "sostituisci" and os.path.exists(dest) and os.path.getsize(dest) > byte:
        # sulla NAS c'e' un file piu' grande di quello di Frame: non e' quello rotto, non si tocca
        os.remove(tmp); segna(i, {"stato": "errore", "errore": "sulla NAS e' piu' grande: lasciato"}); log("LASCIATO " + rel + ": sulla NAS e' piu' grande"); return
    if azione == "sostituisci":
        # vuoto, incompleto o rovinato (anche col peso giusto), nello stesso percorso che ha su Frame
        os.replace(tmp, dest)                            # il file vuoto o rotto lascia il posto a quello intero
    else:
        dest = nome_libero(dest, i); os.replace(tmp, dest)
    dt = max(0.1, time.time() - t0); mb = (byte - prima) / 1e6
    segna(i, {"stato": "fatto", "dest": os.path.relpath(dest, RADICE)})
    log("ok P%s %s · %.0f MB in %.0f s (%.1f MB/s)" % (pr, os.path.relpath(dest, RADICE), mb, dt, mb / dt))

def main():
    solo = int(sys.argv[sys.argv.index("--solo") + 1]) if "--solo" in sys.argv else 0
    insieme = int(sys.argv[sys.argv.index("--insieme") + 1]) if "--insieme" in sys.argv else 3
    fatti = {k for k, v in leggi(STATO, {}).items() if v.get("stato") == "fatto"}
    voci = []
    for r in open(PIANO, encoding="utf-8"):
        if r.startswith("#"): continue
        t = r.rstrip("\n").split("\t")
        if len(t) >= 5 and t[1] not in fatti:
            voci.append({"prio": t[0], "id": t[1], "byte": int(t[2]), "azione": t[3], "dest": t[4]})
    if solo: voci = voci[:solo]
    log("parto: %d file da fare, %.2f TB, %d insieme" % (len(voci), sum(v["byte"] for v in voci) / 1e12, insieme))
    with ThreadPoolExecutor(insieme) as ex: list(ex.map(uno, voci))
    log("fine giro")

if __name__ == "__main__":
    main()
