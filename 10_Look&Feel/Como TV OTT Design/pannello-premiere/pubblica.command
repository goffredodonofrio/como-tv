#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Deposita il pannello sulla VM, da dove il PC di montaggio se lo prende
# ═══════════════════════════════════════════════════════════════════
#
#  Il pannello si scrive sul Mac ma gira su un PC Windows, dall'altra parte
#  della stanza. Senza un canale, ogni correzione sarebbe una chiavetta.
#
#  La VM fa da tramite perche' e' l'unico posto che vedono tutti e due, e
#  perche' e' gia' il canale di tutto il resto. Sul PC non serve ne' git ne'
#  scompattare: un comando tira giu' i file, poi Reload in UXP Developer Tool.
#
#  Da lanciare dopo ogni modifica ai file del pannello.

cd "$(dirname "$0")" || exit 1
VM=root@209.227.239.211
DOVE=/var/www/comotv-dev/pannello

echo "→ controllo che il js sia sano prima di spedirlo"
for j in pannello.js maschere.js; do node --check "$j" || { echo "✗ $j ha un errore di sintassi: non spedisco"; exit 1; }; done
python3 -c "import json;json.load(open('manifest.json'))" || { echo "✗ manifest.json non e' json valido"; exit 1; }

echo "→ impacchetto (serve solo a chi preferisce scaricare a mano)"
rm -f /tmp/comotv-pannello.zip
( cd .. && zip -q -r /tmp/comotv-pannello.zip pannello-premiere -x "*.DS_Store" )

echo "→ deposito sulla VM"
ssh "$VM" "mkdir -p $DOVE" || exit 1
# LEGGIMI.md non sale: il ponte non serve i .md, e chiederlo dal PC darebbe
# un 404 su un file che al plugin non serve. Sta nello zip, per chi lo vuole.
scp -q manifest.json index.html pannello.js maschere.js /tmp/comotv-pannello.zip "$VM:$DOVE/" || exit 1

# Il plugin minimo: copia nuda dell'esempio ufficiale, niente di nostro
# dentro. Serve a separare "Premiere non carica i pannelli" da "il nostro
# pannello ha qualcosa che non va": senza, si correggerebbe al buio.
ssh "$VM" "mkdir -p $DOVE/prova"
scp -q prova/manifest.json prova/index.html "$VM:$DOVE/prova/" || exit 1
# 644 ai file e 755 alle cartelle, distinti: un chmod 644 dato in blocco
# toglie alle cartelle il permesso di attraversamento, e da fuori il
# risultato e' un 404 su file che invece ci sono.
ssh "$VM" "find $DOVE -type f -exec chmod 644 {} + ; find $DOVE -type d -exec chmod 755 {} +"

echo "✓ fatto. Sul PC: rilancia il comando di aggiornamento, poi Reload in UDT."
