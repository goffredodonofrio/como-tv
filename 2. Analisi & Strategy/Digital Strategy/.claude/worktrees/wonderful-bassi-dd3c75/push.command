#!/bin/bash
# Como TV — push completo
# Doppio-click da Finder per committare e pushare sul repo GitHub.

cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Como TV — Git Push"
echo "  📂 $REPO_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ────────────────────────────────────────────
# 0) Pulizia lock orfani
# ────────────────────────────────────────────
for lock in \
  ".git/index.lock" \
  ".git/HEAD.lock" \
  "7_Android APK/.git/index.lock" \
  "7_Android APK/.git/HEAD.lock"
do
  if [ -e "$lock" ]; then
    echo "🧹 Rimuovo lock: $lock"
    rm -f "$lock"
  fi
done

# ────────────────────────────────────────────
# 1) Stage + commit (solo se ci sono modifiche nei file tracciati)
# ────────────────────────────────────────────
echo "📋 Stato del repo:"
git status --short
echo ""

git add -A

# Controlla se c'è qualcosa in staging
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
# 2) Pull --rebase
# ────────────────────────────────────────────
echo "🔄 Pull --rebase da origin/main..."
git pull --rebase --autostash origin main 2>&1 || \
  echo "⚠️  Pull/rebase ha avuto un problema — procedo con il push."

# ────────────────────────────────────────────
# 3) Push
# ────────────────────────────────────────────
echo ""
echo "⬆️  Push verso origin/main..."
if git push origin main; then
  echo ""
  echo "✅ Push completato!"
  echo ""
  echo "📍 Ultimi commit:"
  git log --oneline -5
else
  echo ""
  echo "❌ Push fallito. Possibili cause:"
  echo "   • Token GitHub scaduto → rigenera su github.com"
  echo "   • Il remoto ha commit non presenti in locale → riprova"
fi

echo ""
read -p "Premi Invio per chiudere..."
