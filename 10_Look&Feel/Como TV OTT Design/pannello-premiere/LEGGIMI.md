# Pannello Como TV per Premiere — come provarlo

> Stato: **prova**, non ancora da distribuire ai montatori.
> Perimetro e decisioni: `../UXP_PANNELLO_PREMIERE_handoff.md`.

## A che punto è

| Pezzo | Stato |
|---|---|
| Ponte che serve le partite (`?partite=1`) | **fatto e verificato** — 157 voci |
| Tendina delle partite dentro il pannello | scritta, **mai girata dentro Premiere** |
| Scrittura del testo nella grafica | **da provare** — è la Milestone 0 |

Tutto quello che sta in questa cartella non è mai stato eseguito: qui non c'è
Premiere. Il primo avvio è anche il primo collaudo, ed è normale che qualcosa
non torni al primo colpo.

## Come stanno insieme le tre macchine

Il pannello si **scrive** sul Mac e **gira** su un PC Windows di montaggio. Sono
due macchine diverse, e senza un canale in mezzo ogni correzione sarebbe una
chiavetta.

```
   Mac (si scrive)  ──►  VM projects-cloud.it  ──►  PC Windows (Premiere)
        pubblica.command        /como-tv-dev/pannello/        un comando + Reload
```

La VM fa da tramite perché è l'unico posto che vedono tutte e due, ed è già il
canale di tutto il resto. Sul PC **non serve git, non serve scompattare niente**.

### Una volta sola, sul PC

1. Da **Creative Cloud** installa **UXP Developer Tool** (cerca `UXP`).
2. Apri **PowerShell** e incolla il comando di aggiornamento qui sotto: crea la
   cartella e scarica i file.
3. Apri **Premiere** con il master aperto. *Prima di UDT*: UDT si aggancia a
   Premiere già in esecuzione, se lo apri dopo non lo vede.
4. In **UXP Developer Tool**: `Add Plugin` → scegli il `manifest.json` dentro
   `C:\Users\<utente>\ComoTV\pannello-premiere` → poi `Load`.
5. In Premiere: **Finestra → Estensioni → Como TV**.

### Ogni volta che il pannello cambia

Sul Mac: doppio clic su `pubblica.command`.
Sul PC: il comando qui sotto, poi **Reload** in UDT. Due gesti.

```powershell
$d="$HOME\ComoTV\pannello-premiere"; New-Item $d -ItemType Directory -Force | Out-Null; "manifest.json","index.html","pannello.js","LEGGIMI.md" | ForEach-Object { Invoke-WebRequest "https://projects-cloud.it/como-tv-dev/pannello/$_`?v=$(Get-Random)" -OutFile "$d\$_" -UseBasicParsing }; explorer $d
```

Il `?v=` in coda non è un vezzo: la VM dice ai browser di tenersi i file per
un'ora, e senza quello si riscaricherebbe la versione vecchia credendo di
aggiornare.

Chi preferisce a mano: `https://projects-cloud.it/como-tv-dev/pannello/comotv-pannello.zip`

## Che cosa guardare, in ordine

**1. La tendina si riempie?**
Se dice *«Elenco non disponibile»*, il problema è la rete: UXP blocca le
chiamate verso domini non dichiarati, e il dominio sta in `manifest.json` sotto
`requiredPermissions.network`. Il diario in fondo al pannello dice quale dei due
casi è.

**2. «Leggi la timeline» — questo è il punto che decide tutto.**
Con la sequenza `2_DATA_PARTITA_NOME_9-16` aperta, premi il pulsante e
**mandami quello che esce**, anche se è pieno di errori: soprattutto se è pieno
di errori.

Serve una riga sola, su V2/V3/V4/V5, che assomigli a:

```
V4: 1 elemento
   · TITOLO
     AE.ADBE Text …  → [0] Source Text · [1] …
```

Se quella riga c'è, il testo si scrive dentro la grafica nativa e il progetto va
per la strada corta. Se non c'è — se le grafiche native non espongono parametri
— si passa alla strada già prevista nel handoff: esportare il gruppo come
**modello di grafica animata da dentro Premiere** (nessun After Effects), dove i
parametri di testo ci sono di sicuro.

Il pannello, quando qualcosa non risponde, stampa anche i **nomi dei metodi**
che l'oggetto espone davvero. Serve a distinguere «l'API non lo permette» da
«il metodo si chiama in un altro modo»: sono due esiti diversi e portano a due
progetti diversi.

**3. «Scrivi la competizione»** per adesso non scrive: dice che cosa gli manca.
Non c'è modo di sapere *dove* scrivere prima del punto 2.

## Dopo

- Il pannello punta al ponte **di sviluppo** (`como-tv-dev`). Per la produzione
  va cambiato l'indirizzo in cima a `pannello.js` **e** installata la chiave
  Airtable sul ponte di produzione, che oggi non ce l'ha.
- Distribuzione: pacchetto `.ccx` su ogni macchina, insieme ai font Mazzard e
  DM Sans — se mancano, Premiere sostituisce in silenzio e la grafica esce con
  un altro carattere.
