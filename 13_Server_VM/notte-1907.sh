#!/bin/bash
# LA NOTTE DEL MAM COMO 1907 (Goffredo, 27/09/2026)
# Ogni notte, senza dirette, l'archivio del club si rimette in pari da solo:
#   1. l'elenco dei file della NAS (COMOTV - FRAME, sola lettura)
#   2. le date dall'orologio delle camere, solo per le cartelle nuove
#   3. l'indice: date, stagioni, metadati, persone, servizi
#   4. le locandine delle cartelle nuove (fotogramma + composizione col Chrome dell'export)
#   5. le miniature dei servizi nuovi
#   6. i volti: chi si vede nei video, confrontato con la galleria del Como (volti-1907.py)
# Se parte una diretta ci si ferma e si aspetta che finisca.
set -u
CASA=/var/lib/comotv-1907
diretta() {
  curl -s -m 8 -X POST -H "Content-Type: text/plain" -d '{"tipo":"clip-stato"}' http://127.0.0.1:8080/api |
    python3 -c "import json,sys;print(sum(1 for r in json.load(sys.stdin).get('reg',[]) if r.get('stato')=='registra' and not r.get('guarda')))" 2>/dev/null || echo 0
}
aspetta() { while [ "$(diretta)" != "0" ]; do echo "diretta in corso: aspetto"; sleep 300; done; }
passo() { echo "$(date +%H:%M) $*"; }

aspetta; passo "elenco della NAS"
nice -n 10 ionice -c3 /opt/comotv/elenco-1907.sh || { passo "elenco non riuscito: mi fermo"; exit 1; }
aspetta; passo "date dalle camere"
nice -n 15 python3 /opt/comotv/date-1907.py
passo "indice"
nice -n 10 python3 /opt/comotv/indice-1907-da-elenco.py
aspetta; passo "locandine"
nice -n 15 python3 /opt/comotv/copertine-1907.py | tail -1
D=$CASA/pub/copertine
nice -n 15 node /opt/comotv/copertine-render.js $D/copertine.json $D/src $D && chmod -R a+rX $CASA/pub
aspetta; passo "miniature dei servizi"
nice -n 15 python3 /opt/comotv/scalda-mini-1907.py | tail -1
# 6. chi si vede nei video (volti): al massimo due ore e mezza, poi l'indice li prende
aspetta; passo "volti"
nice -n 15 /opt/volti/bin/python /opt/comotv/volti-1907.py --minuti 150 2>/dev/null | tail -1
nice -n 10 python3 /opt/comotv/indice-1907-da-elenco.py
passo "fatto"
