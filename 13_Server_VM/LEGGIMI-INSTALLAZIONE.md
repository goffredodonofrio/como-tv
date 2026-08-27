# Grafiche Live Como TV — installazione sulla VM

Guida per portare tutto il sistema (pagine + ponte) su una macchina vostra,
su **Ubuntu / Aruba Cloud**. Tempo previsto: **30-40 minuti**, quasi tutti
di attesa.

---

## 1. Che macchina ordinare

**Sistema operativo: Ubuntu Server 24.04 LTS** (va bene anche 22.04 LTS).
Niente interfaccia grafica: la macchina fa solo da server.

**Risorse consigliate**

| | Consigliata | Minima che regge |
|---|---|---|
| CPU | 2 vCPU | 1 vCPU |
| RAM | 4 GB | 2 GB |
| Disco | 40 GB SSD | 20 GB SSD |

Il carico vero è ridicolo per una macchina del genere: le pagine pesano meno
di un megabyte in tutto e il ponte tiene in memoria poche decine di kilobyte
per canale. I 7 vMix collegati insieme, con tutte le console aperte, non
arrivano all'1% di CPU. I 2 vCPU e i 4 GB servono solo a stare tranquilli e
a non dover migrare di nuovo se un domani aggiungiamo contributi video.

**Su Aruba Cloud**: va bene un *Cloud Server Smart* di taglia piccola/media.
Scegliete un **datacenter italiano** (Arezzo, Bergamo o Milano): meno strada
fanno i pacchetti, meno ritardo c'è tra il click in regia e la grafica in onda.

**Da chiedere/annotare al momento della creazione:**
- indirizzo IP pubblico della macchina
- accesso SSH come `root` (password o chiave)
- se avete un dominio (es. `grafiche.comotv.it`), fate puntare un record **A**
  all'IP: servirà per il certificato HTTPS

---

## 2. Installazione

### 2.1 Copiare il pacchetto sulla VM

Dal Mac, nella cartella del progetto:

```bash
scp -r "13_Server_VM" root@INDIRIZZO-IP:/root/
```

(sostituite `INDIRIZZO-IP` con l'IP della macchina)

### 2.2 Lanciare l'installazione

Sempre dal Mac:

```bash
ssh root@INDIRIZZO-IP
cd /root/13_Server_VM
bash installa.sh
```

Lo script fa tutto da solo: aggiorna il sistema, installa Node.js e nginx,
scarica le pagine da GitHub, avvia il ponte, configura il firewall e adatta
le pagine all'indirizzo di questa macchina.

Alla fine stampa gli indirizzi pronti all'uso. **Se qualcosa va storto, si
può rilanciare senza problemi**: rifà solo ciò che manca.

### 2.3 (Consigliato) Certificato HTTPS

Solo se avete un dominio che punta alla macchina:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d grafiche.comotv.it
comotv-aggiorna     # rigenera i link con https://
```

Il certificato si rinnova da solo.

---

## 3. Dopo l'installazione

### 3.1 Le postazioni della redazione

Aprire una volta la pagina Regia dal nuovo indirizzo e verificare che carichi
la scaletta.

> ⚠️ **Una accortezza per le postazioni che usavano già il sistema.** Se su un
> computer qualcuno aveva impostato a mano l'indirizzo del ponte con il
> pulsante ⚙, quel valore resta salvato nel browser e vince sul nuovo. Si
> risolve in dieci secondi: premere ⚙ su una pagina qualsiasi e scrivere
> `/api` come indirizzo del ponte.

### 3.1b Indirizzi brevi

Sulla VM le pagine hanno anche un indirizzo corto, più facile da dettare
al telefono o da scrivere a mano:

| Breve | Pagina |
|---|---|
| `/live` | Grafiche Live (la home degli strumenti) |
| `/regia` | Regia · `/regia/3` apre già il canale 3 |
| `/partita` | Live Match · `/partita/3` apre già il canale 3 |
| `/classifiche` `/risultati` `/formazioni` `/marcatori` `/sottopancia` | i cinque strumenti |
| `/studio/1` … `/studio/7` | **link vMix — Live Studio** |
| `/match/1` … `/match/7` | **link vMix — Live Match** |

Esempio: `http://209.227.239.211/regia`

### 3.2 I vMix

I link sono cambiati (non più `goffredodonofrio.github.io`, ma il vostro
indirizzo). Li trovate già pronti, con il pulsante per copiarli, nella pagina
**Regia**: sotto ogni numero di vMix ci sono *Link vMix · Live Studio* e
*Link vMix · Live Match*.

Su ogni macchina vMix: aprire l'input Web Browser esistente e sostituire
l'indirizzo con quello nuovo.

> **Buona notizia**: da adesso **non serve più cambiare il numero di versione
> `?v=`** a ogni aggiornamento. Il server dice al browser di non conservare
> le pagine in memoria, quindi ogni riavvio dell'input carica già l'ultima
> versione.

---

## 4. Uso quotidiano

### Aggiornare le pagine dopo un push

Sul Mac si continua a lavorare e a fare `push.command` come sempre. Poi, sulla
VM (o via SSH da un terminale):

```bash
comotv-aggiorna
```

Scarica le pagine nuove da GitHub e le riadatta alla macchina. Dura due
secondi e **non interrompe le dirette**: il ponte non si ferma, cambiano solo
i file delle pagine.

### Comandi utili

```bash
systemctl status comotv      # come sta il ponte
systemctl restart comotv     # riavvio (le scalette NON si perdono)
journalctl -u comotv -f      # cosa sta succedendo, in tempo reale
```

### Loghi delle squadre

Le giovanili non hanno stemmi su nessuna fonte pubblica. Nel pannello
**Live Match**, accanto a ciascuna squadra, c'è il pulsante **Carica**:
si sceglie un'immagine (PNG, JPG, WEBP o SVG, fino a 2 MB) e resta
salvata sul server **con il nome della squadra**. Dalla volta dopo basta
scrivere quel nome e il logo si aggancia da solo.

Le squadre che hanno uno stemma ufficiale lo usano senza fare niente; chi
non ha né stemma né logo caricato esce con uno scudetto del colore
squadra e la sigla.

### Copia di sicurezza

Da salvare: lo stato delle scalette e i loghi caricati.

```bash
cp /var/lib/comotv/stato.json /root/backup-stato-$(date +%F).json
tar czf /root/backup-loghi-$(date +%F).tgz -C /var/lib/comotv loghi
```

Tutto il resto (pagine e ponte) si riscarica in un minuto con
`installa.sh`.

---

## 5. Cosa cambia rispetto a oggi

**Va meglio:**
- **La messa in onda diventa istantanea.** Oggi il layer vMix chiede al ponte
  ogni secondo e mezzo, e la risposta arriva da Google in 1,2-1,7 secondi:
  dal click all'onda passano fino a 3 secondi. Sulla VM la risposta è di
  **mezzo millisecondo** e il server *spinge* il comando appena arriva.
- **Niente più code di pubblicazione.** L'attesa di 51 minuti del 27 agosto,
  con le grafiche nuove ferme, non può più succedere.
- **Niente più `?v=`** da cambiare sui 7 vMix a ogni modifica.
- **Niente più "Nuova versione" del deployment** per ogni modifica al ponte.
- **Niente più risposte a vuoto** di Apps Script nei momenti di punta.

**Resta su Google (e va bene così):**
- il pulsante **"Al foglio"**: i tab su Fogli Google continuano a essere
  scritti da Apps Script, che è il posto giusto per farlo. La VM inoltra la
  richiesta. Lì la lentezza non conta: nessuno va in onda da un foglio.
- i **dati ESPN** e gli **stemmi**: arrivano da internet come adesso, quindi
  la VM deve poter uscire in rete (la banda illimitata è più che sufficiente).

**Da sapere:**
- GitHub resta la fonte di verità del codice: si continua a pushare da lì e
  la VM scarica. Se un domani la VM sparisse, le pagine su GitHub Pages
  tornerebbero a funzionare come prima cambiando una riga.
- Lo stato delle scalette vive sulla VM e sopravvive ai riavvii.

---

## 6. Se qualcosa non va

| Sintomo | Cosa guardare |
|---|---|
| Le pagine non si aprono | `systemctl status nginx` e `systemctl status comotv` |
| Le pagine si aprono ma la regia dice "Ponte non raggiungibile" | `journalctl -u comotv -n 50` |
| Una postazione continua ad andare su Google | il ⚙ di quella postazione: impostare `/api` |
| Il vMix mostra la grafica vecchia | riavviare l'input Web Browser di quella macchina |
| Dopo un aggiornamento manca qualcosa | `comotv-aggiorna` e ricontrollare |

Il ponte si riavvia da solo se dovesse fermarsi, e riparte da solo quando la
macchina viene riaccesa: non c'è niente da far partire a mano.
