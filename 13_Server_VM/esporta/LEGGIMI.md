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
| cartella | `/opt/comotv-dev-esporta` | da installare in `/opt/comotv-esporta` |
| servizio | `comotv-dev-esporta` su 127.0.0.1:8091 | porta 8090 |
| nginx | `location /como-tv-dev/esporta/` → 8091 | `location /esporta/` → 8090 |

Il tasto compare solo se `…/esporta/salute` risponde: in prod, finché non si installa, resta nascosto.
**Non lo installa `aggiorna.sh`**: la prima volta va fatto a mano.

## Installare in prod (a mano, fuori dalle dirette)

```bash
mkdir -p /opt/comotv-esporta/lavori && cd /opt/comotv-esporta
cp /var/www/comotv/13_Server_VM/esporta/{esporta-grafica.js,esporta-servizio.js,package.json} .
PUPPETEER_SKIP_DOWNLOAD=1 npm install
npx @puppeteer/browsers install chrome-headless-shell@stable --path /opt/comotv-esporta/chrome
# unità systemd: copia di comotv-dev-esporta.service con porta 8090,
# ESPORTA_BASE=https://projects-cloud.it/live/ e i percorsi /opt/comotv-esporta
chown -R comotv:comotv /opt/comotv-esporta && systemctl enable --now comotv-esporta
# nginx: location /esporta/ { proxy_pass http://127.0.0.1:8090/; proxy_read_timeout 120s; }
nginx -t && systemctl reload nginx
```
