# Esporta grafiche in video

Le grafiche diventano file video per la post-produzione, dal tasto **⬇ Esporta** negli editor.

| Grafiche | Editor | Motore | Formato | Nome del file |
|---|---|---|---|---|
| Talent Hunters: carta, approved, heatmap | `talent-hunters/th-editor.js` | `th-*-vmix.html` | MP4 | `TH_carta_…` |
| Talent Hunters: torta, radar | idem | idem | MOV ProRes 4444 con alfa | `TH_torta_…` |
| Risultati (dal 21/09/2026) | `risultati.html` | `risultati-vmix.html` | MOV con wipe | `RISULTATI_…` |
| Classifiche | `classifiche-campionati.html` | `classifica-vmix.html` | MOV con wipe | `CLASSIFICA_…` |
| Tabelloni e gironi | `tabelloni.html` | `tabellone-vmix.html`, `gruppi-vmix.html` | MOV con wipe | `TABELLONE_…`, `GIRONI_…` |

- **Sempre 50 fps** (dal 22/09/2026, il 25 è stato tolto): le sequenze dei montatori sono a 50p. Il lavoro e il
  file sono il doppio del 25 (classifica di 6,6 s: circa 3 minuti di lavoro, 430 MB in MOV).
- **MP4 (H.264)** per le grafiche col loro fondo.
- **MOV con wipe** (dal 21/09/2026, solo risultati, classifiche, tabelloni e gironi; Talent Hunters no):
  davanti alla grafica le due bande oro Como TV, come le montano in post. Il video comincia
  trasparente, le bande coprono tutto a 0,5 s, uscendo scoprono la grafica, che parte da zero li'.
  La wipe e' `wipe-como.mov` accanto al servizio (1920x1080, ProRes 4444, 60 fps, 0,95 s),
  ricavata dal file dei montatori; l'originale sta in
  `10_Look&Feel/MOTION/GRAFICA LIVE/WIPE COMO TV (bande oro, alfa).mov`. NON e' nel repo:
  va copiata a mano in `/opt/comotv-esporta/` e `/opt/comotv-dev-esporta/`. Se manca, quelle
  grafiche escono in MP4 senza wipe.
- **MOV ProRes 4444 con alfa** per quelle trasparenti, da mettere sopra le immagini in Premiere.

Il tasto di risultati, classifiche e tabelloni e' un modulo solo, `live/esporta-video.js`: prende i dati
dalla stessa funzione dell'anteprima dell'editor, quindi il video e' esattamente l'anteprima.
Per aggiungere un'altra grafica: il suo motore deve leggere i dati da `?d=` e finire di muoversi
(niente rotazioni infinite, o la durata automatica si ferma alla prima); si aggiunge a `MOTORI` in
`esporta-servizio.js` e si chiama `EsportaVideo.tasto({...})` nel suo editor.

## Come funziona

`esporta-grafica.js` apre il motore in un Chrome senza schermo con un **orologio finto**:
timer, requestAnimationFrame, Date, animazioni CSS e video avanzano solo quando lo decide lo
script. Si scatta un fotogramma, si avanza di 1/25 di secondo, si scatta ancora: nessun
fotogramma perso, anche a priorità bassa. La durata la trova da sola (fine delle animazioni + 2 s,
tetto 30 s). I fotogrammi vanno in ffmpeg.

`esporta-servizio.js` è la coda: **un'esportazione alla volta, `nice 19`**, file tenuti due ore.
Sta **accanto al ponte, non dentro**: se Chrome si pianta il ponte non se ne accorge, e cambiare
questi file non riavvia il ponte. Rende solo i motori `th-*-vmix.html`, solo dalla propria base.

**Mai durante una diretta**: un'esportazione occupa la CPU della macchina delle grafiche per circa
un minuto (misurato: torta 9,4 s → 53 s di lavoro).

## Stato

| | Dev | Prod |
|---|---|---|
| cartella | `/opt/comotv-dev-esporta` | `/opt/comotv-esporta` (installato il 17/09/2026) |
| servizio | `comotv-dev-esporta` su 127.0.0.1:8091 | `comotv-esporta` su 127.0.0.1:8090 |
| base motori | `https://projects-cloud.it/como-tv-dev/live/` | `https://projects-cloud.it/como-tv/live/` |
| nginx | `location /como-tv-dev/esporta/` → 8091 | `location /esporta/` → 8090 (le pagine prod hanno il ponte su `/api`, quindi cercano `/esporta/` alla radice) |

Il tasto compare solo se `…/esporta/salute` risponde JSON.
**Non lo aggiorna `aggiorna.sh`**: se cambiano `esporta-grafica.js` o `esporta-servizio.js`, vanno ricopiati
a mano in `/opt/comotv-esporta` e poi `systemctl restart comotv-esporta` (fuori dalle dirette; il ponte non si ferma).
Le unità systemd sono in questa cartella (`comotv-esporta.service`, `comotv-dev-esporta.service`).

## Come è stato installato in prod (17/09/2026)

```bash
mkdir -p /opt/comotv-esporta/lavori
cp /var/www/comotv/13_Server_VM/esporta/{esporta-grafica.js,esporta-servizio.js,package.json} /opt/comotv-esporta/
# node_modules e chrome-headless-shell 153 copiati da dev (stesse versioni gia' provate)
cp -a /opt/comotv-dev-esporta/{node_modules,package-lock.json,chrome} /opt/comotv-esporta/
cp comotv-esporta.service /etc/systemd/system/
chown -R comotv:comotv /opt/comotv-esporta && systemctl daemon-reload && systemctl enable --now comotv-esporta
# nginx (backup in /root/nginx-comotv.backup-*): prima di "flusso in tempo reale"
#   location /esporta/ { proxy_pass http://127.0.0.1:8090/; proxy_http_version 1.1;
#                        proxy_set_header Host $host; proxy_read_timeout 120s; }
nginx -t && systemctl reload nginx
```
