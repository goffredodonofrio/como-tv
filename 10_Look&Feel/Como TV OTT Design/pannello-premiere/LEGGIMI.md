# Pannello Como TV per Premiere — come provarlo

> Stato: **prova**, non ancora da distribuire ai montatori.
> Perimetro e decisioni: `../UXP_PANNELLO_PREMIERE_handoff.md`.

## A che punto è

| Pezzo | Stato |
|---|---|
| Ponte che serve le partite (`?partite=1`) | **fatto e verificato** — 157 voci |
| Tendina delle partite dentro il pannello | **gira dentro Premiere** (26.3.2) |
| Lettura della timeline | **funziona**: progetto, sequenza, tracce, componenti |
| **Mettere la maschera giusta su V2** | **funziona** — 2026-09-04 |
| Scrittura del testo nelle grafiche native | **non si può** — vedi sotto |
| Modello di grafica animata (per il testo) | non provato; l'attrezzo c'è |

## Come funziona adesso

Il montatore sceglie la partita dalla tendina. Il pannello sa quale maschera
vuole quella competizione, la **ritrova dentro il progetto** (per nome, non per
percorso: se gli asset cambiano cartella su `Y:` continua a funzionare) e la
mette su **V2**, al posto di quella che c'è. `Ctrl+Z` annulla.

Quando la maschera non esiste — Champions, Serie A, Under 17, Under 18, UEFA
Youth League, EVENTO REC — **lo dice e spegne il pulsante**, invece di metterne
una sbagliata.

Tre cose imparate a caro prezzo, perché non stanno nella documentazione:

1. Una cartella del progetto non si apre com'è: va convertita con
   `FolderItem.cast(item)`. Senza, la ricerca si ferma al primo piano.
2. `Requires locked access` non vuol dire che manca il lucchetto: vuol dire che
   l'azione va **costruita** dentro `lockedAccess`, non solo eseguita.
3. `SequenceEditor` sa anche `insertMogrtFromPath` e `insertMogrtFromLibrary`:
   se un giorno si torna sul testo, l'attrezzo per i modelli di grafica animata
   c'è già.

## Milestone 0 — l'esito

**Le grafiche native di Premiere non sono scrivibili da UXP.** Non è
un'impressione: è misurato sul master vero, il 2026-09-04.

Il campo c'è e si vede. `V3`, `V4` e `V5` sono `Graphic`, ognuna con quattro
componenti, e dentro `AE.ADBE Text` il parametro `[0] Testo sorgente`. Ma il
suo **valore** non si raggiunge per nessuna via:

| Domanda | Risposta di Premiere |
|---|---|
| `getStartValue()` | nullo |
| `getValueAtTime(t)` | *«not supported for these value types. Use GetKeyframeAtTime»* |
| `getKeyframePtr(t)` | `Illegal Parameter type` — **16 forme di tempo diverse** |
| `getKeyframeListAsTickTimes()` | nessun keyframe |
| `areKeyframesSupported()` | no |
| `isTimeVarying()` | no |
| `createKeyframe(x)` | `Illegal Parameter type` con testo, numero, booleano, oggetto |

Gli altri parametri della stessa grafica (opacità, posizione, scala) si leggono
senza problemi. È **quel tipo di valore** a non essere supportato, non la
grafica e non il pannello.

### Il perché, letto dentro il file di progetto

Aperto `20260831_COMO TV_MASTER.prproj` (è XML compresso), il campo si trova
così:

```xml
<ArbVideoComponentParam …>
  <Name>Testo sorgente</Name>
  <StartKeyframeValue Encoding="base64">pAEAAAAAAABEMyIR…</StartKeyframeValue>
```

**`Arb` sta per *arbitrary***: il valore non è una stringa, è un blocco binario
(un FlatBuffer) che contiene lo stile del testo. Non è un limite del pannello e
non è un limite di Premiere 26: è un tipo di parametro che l'API UXP non sa
maneggiare, e non lo saprà finché Adobe non lo aggiunge. Scriverlo vorrebbe
dire fabbricare quel binario a mano, che non è una strada.

Conseguenza: per il **testo** si prende la strada che il handoff aveva già
previsto come ripiego — **modello di grafica animata esportato da dentro
Premiere**, senza After Effects. Lì i parametri di testo sono stringhe vere.

## Quello che il master dice, e il handoff non sapeva

Letto dal file, non dedotto.

**1. I formati sono dieci, non uno.** Oltre a `1_` e `2_DATA_PARTITA_NOME_9-16`
ci sono `CLIP SOCIAL_CLEAN_4-5`, `CLIP SOCIAL_NOME_CLEAN_3-4`,
`CLIP CLEAN 16-9`, `MASTER_VOD_16-9`, e per gli highlights e la partita intera
le varianti `_ITA`, `_ENG`, `_INTERNATIONAL SOUND`. La "decisione aperta n.1"
del handoff ha una risposta concreta.

**2. Il font è Nexa-Bold, non Mazzard.** Nei nove blocchi di testo del master:
`Nexa-Bold` ×7, `MazzardM-ExtraBold` ×1, `DMSans-Regular` ×1. Il handoff dice
di installare Mazzard e DM Sans su ogni macchina dei montatori: **è la lista
sbagliata**. Se manca Nexa-Bold, Premiere sostituisce in silenzio — il rischio
descritto è reale, ma riguarda un font che nessuno aveva in elenco.

**3. I PNG del master e i nomi di Airtable non coincidono.** Sui prossimi 157
eventi ci sono 19 competizioni. Solo 8 hanno un PNG che si chiama come
Airtable. Delle altre 11:

| Airtable dice | il master ha | |
|---|---|---|
| Bundesliga Austria | `bundesliga austriaca.png` | stesso oggetto, altro nome |
| Coppa di Germania | `dfb-pokal.png` | stesso oggetto, altro nome |
| Championship | `efl championship.png` | stesso oggetto, altro nome |
| Apertura / Clausura Liga Profesional | `liga profesional argentina.png` | stesso oggetto, altro nome |
| Serie A · UEFA Champions League · UEFA Youth League · Under 17 · Under 18 · EVENTO REC | — | **il PNG non c'è** |

La Champions da sola sono 24 righe: è la competizione più frequente dei
prossimi due mesi e non ha una maschera.

> Nota che chiude un cerchio: `efl championship.png` **esiste nel master**, ma
> in `generatore-airtable.js` la riga `'Championship': 'scottish_championship'`
> manda la Championship inglese sul logo scozzese. L'asset giusto c'è, è la
> mappatura a sbagliare.

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
$d="$HOME\ComoTV\pannello-premiere"; New-Item $d -ItemType Directory -Force | Out-Null; "manifest.json","index.html","pannello.js" | ForEach-Object { Invoke-WebRequest "https://projects-cloud.it/como-tv-dev/pannello/$_`?v=$(Get-Random)" -OutFile "$d\$_" -UseBasicParsing }; explorer $d
```

Il plugin sono **tre file**: manifest, pagina e codice. Questo LEGGIMI non serve
sul PC — e il ponte non serve i `.md`, quindi chiederlo darebbe un 404.

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
