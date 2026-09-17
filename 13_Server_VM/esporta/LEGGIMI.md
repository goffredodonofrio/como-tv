# Esporta grafiche in video

Le grafiche di **Talent Hunters** diventano file video per la post-produzione, dal tasto
**⬇ Esporta** negli editor (`live/talent-hunters/th-editor.js`).

- **MP4 (H.264)** per carta, approved, heatmap: hanno il loro fondo.
- **MOV ProRes 4444 con alfa** per torta e radar: trasparenti, da mettere sopra le immagini in Premiere.

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
