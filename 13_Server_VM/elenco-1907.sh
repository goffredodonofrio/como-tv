#!/bin/bash
# elenco veloce del materiale del club: dimensione, data, percorso (una riga per file)
# (29/09/2026) si salta "_CESTINO COMO TV": li' ci sono i doppioni spostati dalla pagina Doppioni 1907
cd /mnt/qnap100-frame || exit 1
find . -mindepth 1 \( -name "@*" -o -name ".*" -o -name "_CESTINO COMO TV" -o -name "_CESTINO COMO 1907" \) -prune -o -type f -printf "%s\t%T@\t%P\n" > /var/lib/comotv-1907/elenco.tsv.tmp && mv /var/lib/comotv-1907/elenco.tsv.tmp /var/lib/comotv-1907/elenco.tsv
