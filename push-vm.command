#!/bin/bash
# Como TV — pubblica sulla VM delle Grafiche Live
# Doppio-click da Finder: committa, pusha su GitHub e aggiorna la VM
# che serve le grafiche live (regia, playout, pagine della redazione).

cd "$(dirname "$0")"
VM="209.227.239.211"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Como TV — Pubblica sulle Grafiche Live"
echo "  📂 $(pwd)"
echo "  🖥  VM $VM"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ────────────────────────────────────────────
# 0) Lock orfani
# ────────────────────────────────────────────
for lock in ".git/index.lock" ".git/HEAD.lock"; do
  [ -e "$lock" ] && { echo "🧹 Rimuovo lock: $lock"; rm -f "$lock"; }
done

# ────────────────────────────────────────────
# 1) Il repo è su un ramo?
#    Se un rebase si è interrotto, git resta "staccato" e i commit
#    finirebbero fuori da ogni ramo: meglio fermarsi e dirlo.
# ────────────────────────────────────────────
if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "HEAD" ]; then
  echo "⚠️  Il repo NON è su un ramo (HEAD staccato)."
  echo "   Succede quando un rebase si interrompe a metà."
  echo "   Committare adesso creerebbe un commit fuori da ogni ramo."
  echo ""
  echo "   Chiedi a Claude Code di sistemarlo, oppure prova:"
  echo "     git rebase --abort"
  echo ""
  read -p "Premi Invio per chiudere..."
  exit 1
fi

# ────────────────────────────────────────────
# 2) Commit
# ────────────────────────────────────────────
echo "📋 Stato del repo:"
git status --short
echo ""

git add -A

if ! git diff --cached --quiet; then
  default_msg="chore: aggiornamento $(date '+%Y-%m-%d %H:%M')"
  echo "📝 Modifiche da committare:"
  git diff --cached --name-only | sed 's/^/   • /'
  echo ""
  echo "   Messaggio commit (Invio = \"$default_msg\"):"
  read -r msg
  [ -z "$msg" ] && msg="$default_msg"
  echo ""
  echo "💾 Commit: \"$msg\""
  git commit -m "$msg"
  echo ""
else
  echo "✓ Nessuna modifica da committare."
  echo ""
fi

# ────────────────────────────────────────────
# 3) Pull + push
# ────────────────────────────────────────────
echo "🔄 Pull --rebase da origin/main..."
git pull --rebase --autostash origin main 2>&1 || \
  echo "⚠️  Pull/rebase ha avuto un problema — procedo con il push."

echo ""
echo "⬆️  Push verso origin/main..."
if ! git push origin main; then
  echo ""
  echo "❌ Push fallito: la VM non verrà aggiornata."
  echo "   • se dice che il remoto ha commit non presenti in locale, rilancia"
  echo "   • se il repo risulta staccato, chiedi a Claude Code"
  echo ""
  read -p "Premi Invio per chiudere..."
  exit 1
fi
echo "✅ Push completato."
echo ""

# ────────────────────────────────────────────
# 4) Aggiorno la VM
# ────────────────────────────────────────────
echo "📡 Aggiorno la VM..."
if ssh -o ConnectTimeout=10 -o BatchMode=yes "root@$VM" "comotv-aggiorna" 2>&1 | sed 's/^/   /'; then
  echo ""
else
  echo ""
  echo "⚠️  Non sono riuscito ad aggiornare la VM da qui."
  echo "   Su GitHub è tutto a posto e la VM si aggiorna da sola entro 3 minuti."
  echo "   Per forzare subito:  ssh root@$VM 'comotv-aggiorna'"
  echo ""
  read -p "Premi Invio per chiudere..."
  exit 1
fi

# ────────────────────────────────────────────
# 5) Controllo che le pagine rispondano davvero
# ────────────────────────────────────────────
echo "🔎 Controllo le pagine sulla VM..."
TUTTO_OK=1
for pagina in "live/classifiche.html" "live/regia.html" "live/partita.html"; do
  CODICE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$VM/$pagina")"
  if [ "$CODICE" = "200" ]; then
    echo "   ✓ $pagina"
  else
    echo "   ✗ $pagina (risposta $CODICE)"
    TUTTO_OK=0
  fi
done
PONTE="$(curl -s --max-time 10 "http://$VM/api" | grep -c 'Ponte Como TV')"
[ "$PONTE" = "1" ] && echo "   ✓ ponte della regia attivo" || { echo "   ✗ ponte della regia non risponde"; TUTTO_OK=0; }

echo ""
if [ "$TUTTO_OK" = "1" ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  ✅ Grafiche live aggiornate e funzionanti"
  echo ""
  echo "  Redazione:  http://$VM/live/classifiche.html"
  echo "  Regia:      http://$VM/live/regia.html"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  I vMix non vanno toccati: al riavvio dell'input"
  echo "  prendono da soli la versione nuova."
else
  echo "⚠️  Qualcosa non risponde. Controlla con:"
  echo "     ssh root@$VM 'systemctl status comotv nginx'"
fi

echo ""
echo "📍 Ultimi commit:"
git log --oneline -5

echo ""
read -p "Premi Invio per chiudere..."
