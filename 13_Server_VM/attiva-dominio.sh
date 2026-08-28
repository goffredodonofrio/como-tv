#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════
#  ATTIVAZIONE DOMINIO — da lanciare quando projects-cloud.it e' vivo
# ═══════════════════════════════════════════════════════════════════
#
#      bash /opt/comotv/attiva-dominio.sh
#
#  Fa in ordine: controlla che il DNS punti a questa macchina, emette
#  il certificato Let's Encrypt (con rinnovo automatico), imposta il
#  nuovo indirizzo del sito e riscrive tutte le pagine. Se il DNS non
#  e' ancora pronto si ferma subito senza toccare nulla: si puo'
#  rilanciare quante volte si vuole.
#
set -euo pipefail

DOMINIO_LIVE="live.projects-cloud.it"
DOMINIO_APICE="projects-cloud.it"
MIO_IP="$(curl -s --max-time 8 https://api.ipify.org || hostname -I | awk '{print $1}')"

echo "→ questa macchina e' $MIO_IP"

# ── quali nomi puntano davvero qui? Il certificato si chiede solo per
#    quelli, altrimenti la verifica fallirebbe e Let's Encrypt conta i
#    tentativi falliti ──
NOMI=()
for n in "$DOMINIO_LIVE" "$DOMINIO_APICE"; do
  RISOLTO="$(dig +short A "$n" @8.8.8.8 | tail -1)"
  if [ "$RISOLTO" = "$MIO_IP" ]; then
    echo "  ✓ $n -> $RISOLTO"
    NOMI+=("$n")
  else
    echo "  · $n -> ${RISOLTO:-non risolve} (salto)"
  fi
done

if [ "${#NOMI[@]}" -eq 0 ]; then
  echo ""
  echo "✗ Nessun nome punta ancora a questa macchina: DNS non pronto."
  echo "  Serve un record A su Netsons:  live -> $MIO_IP"
  echo "  Rilancia questo script quando il dominio e' attivo."
  exit 1
fi

ARGS=""
for n in "${NOMI[@]}"; do ARGS="$ARGS -d $n"; done

echo ""
echo "→ chiedo il certificato per:${ARGS}"
certbot --nginx $ARGS --redirect --agree-tos --non-interactive \
  -m goffredo.donofrio@gmail.com

echo ""
echo "→ nuovo indirizzo del sito: https://$DOMINIO_LIVE"
echo "https://$DOMINIO_LIVE" > /etc/comotv-indirizzo

echo "→ riscrivo le pagine con il nuovo indirizzo…"
/usr/local/bin/comotv-aggiorna --solo-riscrittura

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Dominio attivo."
echo ""
echo "  Regia:    https://$DOMINIO_LIVE/regia/1"
echo "  Playout:  https://$DOMINIO_LIVE/playout/1  (…/7)"
echo ""
echo "  I vecchi indirizzi con l'IP continuano a funzionare."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
