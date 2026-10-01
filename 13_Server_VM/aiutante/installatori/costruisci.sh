#!/bin/bash
# Costruisce gli installatori dell'aiutante (01/10/2026):
#   ComoTV-Aiutante-Mac.pkg      (Node e ffmpeg universali: Apple Silicon e Intel)
#   ComoTV-Aiutante-Windows.exe  (Node e ffmpeg per Windows 64 bit)
# Uso: costruisci.sh <cartella dei download> <cartella di uscita>
#   download: node-vX-darwin-arm64.tar.gz, node-vX-darwin-x64.tar.gz, node-vX-win-x64.zip,
#             mac-arm64-ffmpeg.zip, mac-arm64-ffprobe.zip, mac-amd64-ffmpeg.zip, mac-amd64-ffprobe.zip,
#             win-ffmpeg.zip (gyan.dev essentials)
set -e
QUI="$(cd "$(dirname "$0")" && pwd)"; DL="$1"; OUT="$2"
VERSIONE=$(grep -m1 '^const VERSIONE = ' "$QUI/../aiutante.js" | cut -d'"' -f2)
LAV=$(mktemp -d); mkdir -p "$OUT"
# ── Mac: binari universali ──
mkdir -p "$LAV/a" "$LAV/x" "$LAV/mac"
tar -xzf "$DL"/node-*-darwin-arm64.tar.gz -C "$LAV/a"; tar -xzf "$DL"/node-*-darwin-x64.tar.gz -C "$LAV/x"
lipo -create "$LAV"/a/node-*/bin/node "$LAV"/x/node-*/bin/node -output "$LAV/mac/node"
for t in ffmpeg ffprobe; do
  mkdir -p "$LAV/fa-$t" "$LAV/fx-$t"
  unzip -qo "$DL/mac-arm64-$t.zip" -d "$LAV/fa-$t"; unzip -qo "$DL/mac-amd64-$t.zip" -d "$LAV/fx-$t"
  lipo -create "$LAV/fa-$t/$t" "$LAV/fx-$t/$t" -output "$LAV/mac/$t"
done
cp "$QUI/../aiutante.js" "$LAV/mac/aiutante.js"
chmod 755 "$LAV/mac/node" "$LAV/mac/ffmpeg" "$LAV/mac/ffprobe"
# niente attributi dei download (quarantena, provenienza): se no il .pkg si porta dietro i file ._
xattr -cr "$LAV/mac"
export COPYFILE_DISABLE=1
# IL .PKG A MANO (non con pkgbuild): sui macOS recenti ogni file creato porta
# com.apple.provenance, che non si toglie, e pkgbuild lo infila nel pacchetto come
# file "._qualcosa". Qui l'archivio lo fa cpio con COPYFILE_DISABLE (niente ._), la
# distinta mkbom, e pkgutil --flatten mette insieme il pacchetto di Apple.
ESP="$LAV/esp/aiutante.pkg"; mkdir -p "$ESP/Scripts"
cp "$QUI/mac-scripts/postinstall" "$ESP/Scripts/postinstall"; chmod 755 "$ESP/Scripts/postinstall"
(cd "$LAV/mac" && find . | COPYFILE_DISABLE=1 cpio -o --format odc 2>/dev/null | gzip -9 -c > "$ESP/Payload")
# la distinta dalla cartella; i proprietari (root:wheel) li mette postinstall
mkbom "$LAV/mac" "$ESP/Bom"
KB=$(du -sk "$LAV/mac" | cut -f1); NF=$(find "$LAV/mac" | wc -l | tr -d ' ')
cat > "$ESP/PackageInfo" <<PI
<?xml version="1.0" encoding="utf-8"?>
<pkg-info format-version="2" identifier="tv.comotv.aiutante" version="$VERSIONE" install-location="/Library/Application Support/ComoTV Aiutante" auth="root" overwrite-permissions="true" relocatable="false">
  <payload numberOfFiles="$NF" installKBytes="$KB"/>
  <scripts><postinstall file="./postinstall"/></scripts>
</pkg-info>
PI
rm -f "$OUT/ComoTV-Aiutante-Mac.pkg"
pkgutil --flatten "$ESP" "$OUT/ComoTV-Aiutante-Mac.pkg"
[ -n "$SOLO_MAC" ] && { rm -rf "$LAV"; ls -la "$OUT"; exit 0; }
# ── Windows ──
mkdir -p "$LAV/w" "$LAV/win" "$LAV/wf"
unzip -qo "$DL"/node-*-win-x64.zip -d "$LAV/w"; cp "$LAV"/w/node-*/node.exe "$LAV/win/node.exe"
unzip -qo "$DL/win-ffmpeg.zip" -d "$LAV/wf"; cp "$LAV"/wf/ffmpeg-*/bin/ffmpeg.exe "$LAV"/wf/ffmpeg-*/bin/ffprobe.exe "$LAV/win/"
cp "$QUI/../aiutante.js" "$LAV/win/aiutante.js"
# makensis di Homebrew si pianta (bad_alloc) se la lingua del sistema e' vuota
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
(cd "$QUI" && makensis -V2 -DVERSIONE="$VERSIONE" -DSORGENTI="$LAV/win" windows.nsi)
mv "$QUI/ComoTV-Aiutante-Windows.exe" "$OUT/"
rm -rf "$LAV"
ls -la "$OUT"
