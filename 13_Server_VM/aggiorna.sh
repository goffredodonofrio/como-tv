#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════
#  AGGIORNAMENTO PAGINE — da lanciare dopo ogni push
# ═══════════════════════════════════════════════════════════════════
#
#      comotv-aggiorna
#
#  Scarica le pagine nuove da GitHub e le adatta a questa macchina:
#   · il ponte diventa /api (questa VM) invece di Apps Script
#   · i link per i vMix puntano a questo indirizzo invece che a GitHub
#
#  Le pagine non vengono messe in cache dal server, quindi il
#  cambiamento si vede subito: niente più numeri di versione (?v=)
#  da aggiornare su vMix.
#
set -euo pipefail

SITO="/var/www/comotv"
SOLO_RISCRITTURA=0
[ "${1:-}" = "--solo-riscrittura" ] && SOLO_RISCRITTURA=1

# indirizzo pubblico di questa macchina (dominio se c'è, altrimenti IP)
if [ -z "${COMOTV_INDIRIZZO:-}" ]; then
  if [ -f /etc/comotv-indirizzo ]; then
    COMOTV_INDIRIZZO="$(cat /etc/comotv-indirizzo)"
  else
    COMOTV_INDIRIZZO="http://$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
  fi
fi
echo "$COMOTV_INDIRIZZO" > /etc/comotv-indirizzo

if [ "$SOLO_RISCRITTURA" -eq 0 ]; then
  echo "→ scarico le pagine aggiornate…"
  cd "$SITO"
  # le pagine sul server non si modificano a mano: si riparte sempre
  # da quelle pubblicate, poi si riapplicano gli adattamenti
  git fetch --quiet origin
  git reset --hard --quiet origin/main
fi

echo "→ adatto le pagine a questa macchina ($COMOTV_INDIRIZZO)…"

# 1) il ponte: da Apps Script a questa VM
find "$SITO" -name "*.html" -type f -print0 | xargs -0 sed -i \
  -e 's|https://script\.google\.com/macros/s/[A-Za-z0-9_-]*/exec|/api|g'

# 2) i link per i vMix: da GitHub Pages a questa macchina
ESC="$(printf '%s' "$COMOTV_INDIRIZZO" | sed 's/[&|]/\\&/g')"
find "$SITO" -name "*.html" -type f -print0 | xargs -0 sed -i \
  -e "s|https://goffredodonofrio\.github\.io/como-tv|$ESC|g"

# 3) niente più numeri di versione: qui le pagine non si mettono in cache
find "$SITO" -name "*.html" -type f -print0 | xargs -0 sed -i \
  -e 's|\(grafica-live\.html?c=" + ci + "\)&v=" + VMIX_V_STUDIO|\1"|g' \
  -e 's|\(partita-live\.html?c=" + ci + "\)&v=" + VMIX_V_PARTITA|\1"|g'

chown -R comotv:comotv "$SITO" 2>/dev/null || true

# 4) il ponte stesso: se il codice del server è cambiato, va sostituito.
#    Il riavvio interrompe le grafiche per un istante, quindi si fa solo
#    quando il file è davvero diverso: un push di sole pagine non tocca
#    nulla. Lo stato (scalette e messa in onda) è su disco e viene ripreso.
NUOVO="$SITO/13_Server_VM/server.js"
INUSO="/opt/comotv/server.js"
if [ "$SOLO_RISCRITTURA" -eq 0 ] && [ -f "$NUOVO" ] && ! cmp -s "$NUOVO" "$INUSO"; then
  if node --check "$NUOVO" 2>/dev/null; then
    echo "→ il ponte è cambiato: lo sostituisco e riavvio…"
    install -o comotv -g comotv -m 644 "$NUOVO" "$INUSO"
    # aggiorna.sh si sostituisce con uno spostamento, non riscrivendosi:
    # il file in esecuzione resta valido fino alla fine
    if [ -f "$SITO/13_Server_VM/aggiorna.sh" ]; then
      install -o comotv -g comotv -m 755 "$SITO/13_Server_VM/aggiorna.sh" /opt/comotv/aggiorna.sh.nuovo
      mv -f /opt/comotv/aggiorna.sh.nuovo /opt/comotv/aggiorna.sh
    fi
    systemctl restart comotv
    sleep 2
    if systemctl is-active --quiet comotv; then
      echo "  ✓ ponte riavviato"
    else
      echo "  ✗ il ponte non riparte: systemctl status comotv"
    fi
  else
    echo "⚠️  il nuovo server.js ha un errore di sintassi: NON lo installo."
    echo "   resta in funzione quello di prima."
  fi
fi

RIGHE="$(grep -rl '"/api"' "$SITO" --include='*.html' | wc -l | tr -d ' ')"
echo "→ fatto: $RIGHE pagine collegate al ponte di questa macchina"
echo
echo "  Regia:  $COMOTV_INDIRIZZO/regia/1"
