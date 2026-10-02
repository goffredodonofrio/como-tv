#!/bin/bash
# AIUTANTE MAM COMO TV — installazione sul Mac con una riga di Terminale (01/10/2026)
#   curl -fsSL https://projects-cloud.it/como-tv/aiutante/pacchetto/installa-mac.sh | bash
# Scaricato col browser, il .command finisce in quarantena e macOS lo blocca;
# da Terminale no. Fa le stesse cose di "Installa (Mac).command".
set -e
BASE="${COMOTV_AIUTANTE_BASE:-https://projects-cloud.it/como-tv/aiutante/pacchetto}"
echo "== Aiutante MAM Como TV: installazione =="
NODE=$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1 || true)
if [ -z "$NODE" ]; then echo "Manca Node.js: installalo da https://nodejs.org (LTS) o con 'brew install node', poi rilancia."; exit 1; fi
FF=$(command -v ffmpeg || ls /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg 2>/dev/null | head -1 || true)
if [ -z "$FF" ]; then echo "Manca ffmpeg: installalo con 'brew install ffmpeg' (Homebrew: https://brew.sh), poi rilancia."; exit 1; fi
DEST="$HOME/Library/Application Support/ComoTV Aiutante"
mkdir -p "$DEST" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
curl -fsSL "$BASE/aiutante.js" -o "$DEST/aiutante.nuovo.js"
"$NODE" --check "$DEST/aiutante.nuovo.js"
mv "$DEST/aiutante.nuovo.js" "$DEST/aiutante.js"
PL="$HOME/Library/LaunchAgents/tv.comotv.aiutante.plist"
cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>tv.comotv.aiutante</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/aiutante.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ComoTV-Aiutante.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ComoTV-Aiutante.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PL"
sleep 3
"$NODE" "$DEST/aiutante.js" --prova
if curl -s http://127.0.0.1:47800/salute | grep -q '"ok":true'; then
  echo "FATTO: l'aiutante e' acceso. Riapri l'Editing del MAM: gli export partono da questo Mac."
else
  echo "L'aiutante non risponde: guarda ~/Library/Logs/ComoTV-Aiutante.log"
fi
echo "La NAS non serve: i pezzi li manda il MAM. (Se e' montata come 'COMOTV - VOD' la usa e va ancora piu' veloce.)"
