# Fogli partita della redazione

I giornalisti pubblicano un foglio per partita (arbitro, precedenti, allenatori, storia,
curiosità) su Slack in **#como-tv-assegnazioni-appunti** e a volte nel Drive
**ARCHIVIO APPUNTI**. `fogli-redazione.js` li raccoglie ogni 15 minuti, ne estrae il
testo (Word con python, PDF con pdftotext) e li scrive in `/var/lib/comotv-fogli/pub`,
che nginx serve su `/fogli-redazione/`. La **lavagna** dei telecronisti li legge da lì.
Niente va in onda.

| File | Dove sta sulla VM |
|---|---|
| `fogli-redazione.js` | `/opt/comotv-fogli/` |
| `comotv-fogli.service`, `comotv-fogli.timer` | `/etc/systemd/system/` |
| le chiavi | `/etc/comotv-fogli.env` (root:comotv, 640) — mai nel repo |

Chiavi in `/etc/comotv-fogli.env`:

    SLACK_TOKEN=xoxb-...        # app Slack di sola lettura: channels:history, groups:history, files:read, users:read
    SLACK_CANALI=C0AG3PSDTAR
    GOOGLE_SA_FILE=/etc/comotv-fogli-sa.json   # account di servizio con ARCHIVIO APPUNTI condivisa in lettura
    DRIVE_CARTELLE=1n_2D6_d8wYd2Oqzimjzou0oQLoxS63br

Senza una delle chiavi quella fonte si salta. `aggiorna.sh` non aggiorna questo lettore:
dopo un cambio si ricopia `fogli-redazione.js` in `/opt/comotv-fogli/`.

A mano (come comotv): `node fogli-redazione.js` (un giro), `--file foglio.docx` (uno dal
disco), `--rifai` (indice e nomi da capo). Log: `journalctl -u comotv-fogli`.
`--rileggi` riscarica e rilegge tutti i fogli con le regole di adesso (serve dopo un cambio
alla lettura dei Word o dei PDF: i file originali non si tengono). Prova senza toccare prod:
`FOGLI_DIR=/tmp/fp` con `pub/fogli`, `pub/nomi` e `tmp` vuote.

PDF dal Mac: "fi", "fl", "ffi" sono una legatura senza Unicode e pdftotext li perde
("nale", "u ciali"). Il lettore li rimette con pypdf, dal venv `/opt/comotv-fogli/venv`
(`python3 -m venv venv && venv/bin/pip install pypdf`, fatto il 22/09/2026). Senza venv
si salta la riparazione.
