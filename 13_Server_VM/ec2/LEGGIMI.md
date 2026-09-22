# Il ponte S3 sulla EC2 (Parigi, eu-west-3)

L'archivio di Como Football sta su S3 (`mola-italy-como-archive`, 145 TB, classe Standard).
La VM in Italia non ha una chiave: legge attraverso una EC2 nella stessa regione
del secchio, dove il traffico S3→EC2 è gratis. Dalla EC2 alla VM passa solo
quello che serve, contato byte per byte, con un tetto (80 GB/mese, 4 GB/giorno:
la fascia gratuita di AWS è 100 GB/mese).

- `relay.py` gira sulla EC2 come `relay-s3.service` (utente ubuntu, 127.0.0.1:8095),
  con il ruolo IAM in sola lettura dell'istanza. Rotte: `/conto`, `/o/<chiave>`
  (letture a intervalli, mai più di 2 MB per risposta), `/f?k=&t=&w=&c=top&fmt=png`
  (un fotogramma estratto lì, ~100 kB).
- La VM lo raggiunge con `comotv-tunnel-ec2.service` (tunnel ssh, chiave
  `/etc/comotv/ec2-tunnel.key` autorizzata sulla EC2) e il ponte lo usa se ha
  `COMOTV_S3_PONTE=http://127.0.0.1:8095` nell'ambiente.
- L'inventario del secchio (`s3-inventario.json`, solo TEMP) si rifà sulla EC2 con
  `aws s3api list-objects-v2` e si copia nella cartella dati del ponte: niente byte
  di video, solo elenco.
- La EC2 accesa costa a Como Football circa un euro al giorno: si spegne quando non serve.
