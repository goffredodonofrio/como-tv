#!/bin/bash
# AIUTANTE MAM COMO TV — installazione sul Mac (01/10/2026)
# Copia l'aiutante in ~/Library/Application Support/ComoTV Aiutante e lo fa
# partire da solo a ogni accensione (LaunchAgent). Doppio clic e basta.
cd "$(dirname "$0")" || exit 1
echo "== Aiutante MAM Como TV: installazione =="
NODE=$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)
if [ -z "$NODE" ]; then
  echo "Manca Node.js. Installalo (https://nodejs.org, versione LTS, oppure: brew install node) e rilancia questo file."
  read -r -p "Premi Invio per chiudere." _; exit 1
fi
FF=$(command -v ffmpeg || ls /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg 2>/dev/null | head -1)
if [ -z "$FF" ]; then
  echo "Manca ffmpeg. Installalo con Homebrew (brew install ffmpeg) e rilancia questo file."
  read -r -p "Premi Invio per chiudere." _; exit 1
fi
DEST="$HOME/Library/Application Support/ComoTV Aiutante"
mkdir -p "$DEST" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp aiutante.js "$DEST/aiutante.js"
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
launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PL"
sleep 3
"$NODE" "$DEST/aiutante.js" --prova
echo
if curl -s http://127.0.0.1:47800/salute | grep -q '"ok":true'; then
  echo "FATTO: l'aiutante e' acceso. Riapri l'Editing del MAM: gli export partono da questo Mac."
else
  echo "L'aiutante non risponde: guarda ~/Library/Logs/ComoTV-Aiutante.log"
fi
echo "La NAS non serve: i pezzi li manda il MAM. (Se e' montata come 'COMOTV - VOD' la usa e va ancora piu' veloce.)"
read -r -p "Premi Invio per chiudere." _
