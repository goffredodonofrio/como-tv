#!/bin/bash
# AIUTANTE MAM COMO TV — lo toglie dal Mac (gli export tornano alla VM)
PL="$HOME/Library/LaunchAgents/tv.comotv.aiutante.plist"
launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null
rm -f "$PL"
rm -rf "$HOME/Library/Application Support/ComoTV Aiutante"
echo "Aiutante tolto. La configurazione (~/.comotv-aiutante.json) e i file in Download/MAM Export restano."
read -r -p "Premi Invio per chiudere." _
