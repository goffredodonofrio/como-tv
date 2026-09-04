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
node --check pannello.js || { echo "✗ pannello.js ha un errore di sintassi: non spedisco"; exit 1; }
python3 -c "import json;json.load(open('manifest.json'))" || { echo "✗ manifest.json non e' json valido"; exit 1; }

echo "→ impacchetto (serve solo a chi preferisce scaricare a mano)"
rm -f /tmp/comotv-pannello.zip
( cd .. && zip -q -r /tmp/comotv-pannello.zip pannello-premiere -x "*.DS_Store" )

echo "→ deposito sulla VM"
ssh "$VM" "mkdir -p $DOVE" || exit 1
scp -q manifest.json index.html pannello.js LEGGIMI.md /tmp/comotv-pannello.zip "$VM:$DOVE/" || exit 1
ssh "$VM" "chmod 644 $DOVE/*"

echo "✓ fatto. Sul PC: rilancia il comando di aggiornamento, poi Reload in UDT."
