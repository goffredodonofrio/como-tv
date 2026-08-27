#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════
#  INSTALLAZIONE PONTE COMO TV su Ubuntu (Aruba Cloud)
# ═══════════════════════════════════════════════════════════════════
#
#  Da eseguire UNA VOLTA sulla VM appena creata, come root:
#      bash installa.sh
#
#  Si può rilanciare senza danni: rifà solo ciò che manca.
#
set -euo pipefail

REPO="${COMOTV_REPO:-https://github.com/goffredodonofrio/como-tv.git}"
SITO="/var/www/comotv"
APP="/opt/comotv"
DATI="/var/lib/comotv"
QUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "═══ Ponte Como TV — installazione ═══"
[ "$(id -u)" -eq 0 ] || { echo "Devi essere root:  sudo bash installa.sh"; exit 1; }

# ── 1. pacchetti ───────────────────────────────────────────────────
# Una VM appena creata sta quasi sempre installando da sola gli
# aggiornamenti di sicurezza, e tiene occupato il gestore pacchetti:
# invece di fallire, aspettiamo che abbia finito.
if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
  echo "→ il sistema sta finendo gli aggiornamenti automatici, aspetto…"
  ATTESA=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    sleep 10; ATTESA=$((ATTESA + 10))
    [ $((ATTESA % 60)) -eq 0 ] && echo "   … ancora in corso (${ATTESA}s)"
    if [ "$ATTESA" -ge 900 ]; then
      echo "   Sono passati 15 minuti: qualcosa è bloccato."
      echo "   Controlla con:  systemctl status unattended-upgrades"
      exit 1
    fi
  done
  echo "→ finito, proseguo."
fi

echo "→ aggiorno il sistema e installo i pacchetti…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx ca-certificates ufw >/dev/null

if ! command -v node >/dev/null 2>&1; then
  echo "→ installo Node.js 22 LTS…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "   Node.js $(node --version)"

# ── 2. utente e cartelle ───────────────────────────────────────────
id -u comotv >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin comotv
mkdir -p "$APP" "$DATI" "$SITO"

# ── 3. il ponte ────────────────────────────────────────────────────
echo "→ installo il ponte…"
cp "$QUI/server.js" "$APP/server.js"
cp "$QUI/aggiorna.sh" "$APP/aggiorna.sh"
chmod +x "$APP/aggiorna.sh"
chown -R comotv:comotv "$APP" "$DATI"

# ── 4. le pagine ───────────────────────────────────────────────────
if [ -d "$SITO/.git" ]; then
  echo "→ le pagine ci sono già, le aggiorno…"
else
  echo "→ scarico le pagine da GitHub…"
  rm -rf "$SITO"
  git clone --depth 1 "$REPO" "$SITO" >/dev/null 2>&1
fi
git config --global --add safe.directory "$SITO" 2>/dev/null || true

# ── 5. servizio ────────────────────────────────────────────────────
echo "→ configuro il servizio…"
cp "$QUI/comotv.service" /etc/systemd/system/comotv.service
systemctl daemon-reload
systemctl enable comotv >/dev/null 2>&1
systemctl restart comotv

# ── 5b. controllo automatico degli aggiornamenti ───────────────────
echo "→ attivo il controllo automatico degli aggiornamenti…"
if [ -f "$QUI/comotv-sync.service" ]; then
  cp "$QUI/comotv-sync.service" "$QUI/comotv-sync.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now comotv-sync.timer >/dev/null 2>&1
fi

# ── 6. nginx ───────────────────────────────────────────────────────
echo "→ configuro nginx…"
cp "$QUI/nginx-comotv.conf" /etc/nginx/sites-available/comotv
ln -sf /etc/nginx/sites-available/comotv /etc/nginx/sites-enabled/comotv
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 && systemctl reload nginx

# ── 7. firewall ────────────────────────────────────────────────────
echo "→ apro solo le porte necessarie…"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ── 8. adatto le pagine a questa macchina ──────────────────────────
IP="$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
INDIRIZZO="${COMOTV_INDIRIZZO:-http://$IP}"
echo "→ adatto le pagine all'indirizzo $INDIRIZZO…"
COMOTV_INDIRIZZO="$INDIRIZZO" bash "$APP/aggiorna.sh" --solo-riscrittura

# ── fatto ──────────────────────────────────────────────────────────
sleep 1
STATO="$(systemctl is-active comotv || true)"
echo
echo "═══════════════════════════════════════════════════════════"
echo "  Installazione completata."
echo "  Servizio ponte: $STATO"
echo
echo "  Grafiche Live:  $INDIRIZZO/live/classifiche.html"
echo "  Regia:          $INDIRIZZO/live/regia.html"
echo
echo "  Link per i vMix (Live Studio / Live Match, canali 1-7):"
echo "    $INDIRIZZO/live/grafica-live.html?c=1"
echo "    $INDIRIZZO/live/partita-live.html?c=1"
echo "  (li trovi tutti, pronti da copiare, nella pagina Regia)"
echo
echo "  Per aggiornare le pagine dopo un push:  comotv-aggiorna"
echo "═══════════════════════════════════════════════════════════"

# scorciatoia comoda
cat > /usr/local/bin/comotv-aggiorna <<'FINE'
#!/usr/bin/env bash
exec bash /opt/comotv/aggiorna.sh "$@"
FINE
chmod +x /usr/local/bin/comotv-aggiorna
