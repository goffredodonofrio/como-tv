/**
 * ═══════════════════════════════════════════════════════════════════
 *  PANNELLO COMO TV per Premiere — scelta della partita
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Il montatore sceglie la partita da una tendina e il nome della
 *  competizione si scrive da solo. Oggi lo digita a mano, e gli errori
 *  di battitura vanno in onda.
 *
 *  Le partite arrivano dal ponte sulla VM (?partite=1): la chiave di
 *  Airtable resta li', non finisce dentro un plugin installato su sette
 *  macchine.
 *
 *  ── Sul "Leggi la timeline" ──────────────────────────────────────
 *  Non e' un pulsante di servizio: e' la prova che decide il progetto.
 *  L'unica cosa non data per certa e' se UXP arrivi a scrivere dentro
 *  una grafica NATIVA di Premiere. Invece di scriverlo secondo quello
 *  che dice la documentazione, il pannello guarda e riferisce: percorre
 *  la sequenza vera e stampa che cosa trova davvero, compresi i nomi
 *  dei metodi che gli oggetti espongono. Se l'API e' diversa da come me
 *  l'aspetto, si vede subito nel diario invece di sembrare un bug.
 */
(function () {
  "use strict";

  var PONTE = "https://projects-cloud.it/como-tv-dev/api";
  var eventi = [], scelto = null;

  // La lettura scende in profondita' e a valle servono ancora: tenerli qui
  // evita di passarli di mano in mano attraverso quattro funzioni.
  var SEQ = null, PPRO = null;

  // Da nome nuovo a nome col segnaposto. Serve a ripremere il pulsante
  // senza rovinare quello che la prima passata ha gia' sistemato: il
  // modello e' l'unica cosa che sa dov'era DATA e dov'era NOME.
  var MODELLI = {};


  function el(id) { return document.getElementById(id); }

  // Un sp-textfield vuoto non ha ancora un .value: chiederlo e chiamarci
  // .trim() sopra fa saltare tutto il pulsante, e sembra che il pannello
  // sia rotto invece che semplicemente vuoto.
  function testoDi(id) {
    var e = el(id);
    var v = e && e.value;
    return v === undefined || v === null ? "" : String(v).trim();
  }

  // ── il diario ──────────────────────────────────────────────────────
  function dico(testo, classe) {
    var d = el("diario");
    var r = document.createElement("div");
    if (classe) r.className = classe;
    r.textContent = testo;
    d.appendChild(r);
    d.scrollTop = d.scrollHeight;
  }
  function pulisci() { el("diario").textContent = ""; }

  // Il diario e' fatto di righe separate. Chiedendone il testo in blocco si
  // riottiene tutto attaccato, e un referto senza a capo e' illeggibile
  // proprio dove conta: va ricomposto riga per riga.
  function testoDiario() {
    var fuori = [], f = el("diario").children;
    for (var i = 0; i < f.length; i++) fuori.push(f[i].textContent);
    return fuori.join("\n");
  }

  // Quando qualcosa non risponde come previsto, la domanda vera e'
  // "che cosa sa fare questo oggetto?". La risposta sta nel prototipo.
  // Non tutto quello che viene lanciato e' un Error: alcuni rifiuti dell'API
  // arrivano nudi, e chiedendone .message si stampa "undefined" — che sembra
  // un difetto nostro invece della risposta che e'.
  function mess(e) {
    if (!e) return "senza motivo";
    return e.message || e.description || String(e);
  }

  function metodiDi(o) {
    if (!o) return "(niente)";
    var visti = {}, fuori = [];
    for (var p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      Object.getOwnPropertyNames(p).forEach(function (n) {
        if (n === "constructor" || visti[n]) return;
        visti[n] = 1; fuori.push(n);
      });
    }
    return fuori.sort().join(", ");
  }

  // ── le partite ─────────────────────────────────────────────────────
  function caricaPartite() {
    fetch(PONTE + "?partite=1", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.errore || "il ponte non risponde");
        eventi = j.eventi || [];
        var s = el("partita");
        s.textContent = "";
        eventi.forEach(function (e, i) {
          var o = document.createElement("option");
          o.value = String(i);
          o.textContent = e.etichetta;
          s.appendChild(o);
        });
        s.disabled = false;
        mostra();
      })
      .catch(function (e) {
        var s = el("partita");
        s.textContent = "";
        var o = document.createElement("option");
        o.textContent = "Elenco non disponibile";
        s.appendChild(o);
        dico("Le partite non arrivano: " + e.message, "no");
        dico("Se dice 'not allowed', manca il dominio in manifest.json.", "forse");
      });
  }

  function mostra() {
    scelto = eventi[parseInt(el("partita").value, 10)] || null;
    if (!scelto) return;
    el("vComp").textContent = scelto.competizione || "—";
    var d = new Date(scelto.quando);
    el("vData").textContent = isNaN(d) ? "—"
      : d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
    el("vSquadre").textContent = scelto.programma ? "(programma)"
      : (scelto.casa + " – " + scelto.ospite);

    // La maschera e' il vero lavoro del pannello: il testo non si scrive,
    // ma scegliere il PNG giusto fra ventinove e' esattamente il passaggio
    // dove oggi nasce l'errore che va in onda.
    var m = window.Maschere.per(scelto.competizione);
    var v = el("vMask");
    if (m.file) { v.textContent = m.file; v.className = ""; }
    else if (m.manca) { v.textContent = "il PNG non esiste"; v.className = "no"; }
    else { v.textContent = "competizione mai vista"; v.className = "forse"; }
    // Il pulsante resta acceso anche senza maschera: nome e testi valgono
    // lo stesso, e spegnere tutto per un PNG mancante toglierebbe il resto.
    el("btnMask").disabled = false;

    // Il nome si puo' proporre solo conoscendo quello attuale, che sta in
    // Premiere: finche' non si e' guardata la sequenza si mostra la forma.
    var vn = el("vNome");
    vn.textContent = (SEQ && SEQ.name ? nomeProposto(SEQ.name) : "") ||
                     nomeProposto("DATA_PARTITA_NOME") + "  (forma)";
  }

  // ── il pulsante unico ──────────────────────────────────────────────
  // Un clic solo, e rifa' tutto da capo. Ripremerlo dopo aver corretto un
  // titolo deve dare lo stesso risultato di averlo scritto giusto la prima
  // volta: e' la differenza fra uno strumento e una trappola.
  async function mettiTutto() {
    if (!scelto) return;
    pulisci();

    var ppro = premiere();
    if (!ppro) { dico("Non trovo l'API di Premiere.", "no"); return; }
    var progetto = await ppro.Project.getActiveProject();
    var sequenza = await progetto.getActiveSequence();
    if (!sequenza) { dico("Nessuna sequenza aperta.", "no"); return; }
    PPRO = ppro; SEQ = sequenza;

    await mettiMaschera(progetto, sequenza, ppro);
    dico("");
    await rinomina(progetto, sequenza);
    dico("");
    await scriviTesti(progetto, sequenza, ppro);
  }

  // ── i tre testi ────────────────────────────────────────────────────
  // Qui casca l'asino, e vale la pena scrivere perche'.
  //
  // Le grafiche native del master tengono il testo in un parametro
  // "arbitrario": un blocco binario, non una stringa. Provato in ogni modo
  // il 2026-09-04 — sedici forme di tempo, quattro tipi di valore — e non
  // si scrive. Non e' un limite nostro: e' un tipo che UXP non maneggia.
  //
  // Un MODELLO DI GRAFICA ANIMATA invece espone i suoi campi come stringhe
  // vere. Si esporta da dentro Premiere (Grafica → Esporta come modello di
  // grafica animata), senza After Effects, e l'aspetto non cambia di un
  // pixel perche' e' la stessa grafica impacchettata.
  //
  // Finche' quel modello non esiste, questa funzione non finge: dice cosa
  // manca e chi lo deve fare.
  // ── il titolo, disegnato dal ponte e messo in timeline ─────────────
  // Il giro completo: il ponte disegna il PNG (li' il font c'e' e il
  // canvas di UXP non serve), il pannello lo scarica, lo salva, lo importa
  // e lo mette dove stavano le grafiche native — che vengono tolte.
  //
  // Si riconoscono per quello che sono, non per il numero di traccia: una
  // grafica di testo ha un componente "AE.ADBE Text". Cosi' l'endtag su V5
  // o un logo su V6 non li tocca nessuno, anche se domani le tracce
  // cambiano ordine.
  async function graficheDiTesto(sequenza, ppro) {
    var fuori = [], quante = 0;
    try { quante = await sequenza.getVideoTrackCount(); } catch (e) { return fuori; }
    for (var i = 0; i < quante; i++) {
      var pezzi = [];
      try {
        var tr = await sequenza.getVideoTrack(i);
        pezzi = await tr.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      } catch (e) { continue; }
      for (var k = 0; k < (pezzi || []).length; k++) {
        var catena, n = 0, testo = false;
        try { catena = await pezzi[k].getComponentChain(); n = await catena.getComponentCount(); }
        catch (e) { continue; }
        for (var c = 0; c < n && !testo; c++) {
          try {
            var comp = await catena.getComponentAtIndex(c);
            if (/AE\.ADBE Text/i.test(await comp.getMatchName())) testo = true;
          } catch (e) {}
        }
        if (testo) fuori.push({ traccia: i, pezzo: pezzi[k] });
      }
    }
    return fuori;
  }

  // Il formato lo dice il nome della sequenza: "..._9-16", "..._16-9".
  function formatoDi(nome) {
    var m = String(nome || "").match(/(\d+-\d+)\s*$/);
    return m ? m[1] : "9-16";
  }

  async function scriviTesti(progetto, sequenza, ppro) {
    var valori = [testoDi("t1"), testoDi("t2"), testoDi("sott")];
    if (!valori[0] && !valori[1] && !valori[2]) { dico("Nessun testo da mettere."); return; }

    // Il ponte disegna, il pannello porta. Il nome del file cambia ogni
    // volta: Premiere tiene in cache i media per percorso, e riusare lo
    // stesso nome vorrebbe dire rivedere il titolo di prima.
    var formato = formatoDi(sequenza.name);
    var giro = PONTE + "?titolo=" + encodeURIComponent(valori[0]) +
               "&t2=" + encodeURIComponent(valori[1]) +
               "&sott=" + encodeURIComponent(valori[2]) +
               "&formato=" + encodeURIComponent(formato);
    var nomeFile = "titolo-" + Date.now() + ".png";
    var percorso = "";
    try {
      var r = await fetch(giro, { cache: "no-store" });
      var buf = await r.arrayBuffer();
      if (buf.byteLength < 500) throw new Error("il ponte non ha disegnato niente");
      var uxp = require("uxp");
      var cartella = await uxp.storage.localFileSystem.getTemporaryFolder();
      var file = await cartella.createEntry(nomeFile, { overwrite: true });
      await file.write(buf, { format: uxp.storage.formats.binary });
      percorso = file.nativePath;
      dico("Titolo disegnato (" + formato + ", " + Math.round(buf.byteLength / 1024) + " KB).", "si");
    } catch (e) { dico("Non ottengo il titolo: " + mess(e), "no"); return; }

    var immagine = null;
    try {
      var radice = await progetto.getRootItem();
      await progetto.importFiles([percorso], true, radice, false);
      var cercata = await cercaNelProgetto(progetto, nomeFile);
      immagine = cercata.pezzo;
      if (!immagine) throw new Error("importata ma non la ritrovo nel progetto");
    } catch (e) { dico("Non importo il titolo: " + mess(e), "no"); return; }

    // Le grafiche di testo che c'erano: da qui si prendono le misure e poi
    // se ne vanno. Se non ce n'e' nessuna non si inventa una posizione.
    var vecchie = await graficheDiTesto(sequenza, ppro);
    if (!vecchie.length) {
      dico("Non trovo le grafiche di testo: non so dove mettere il titolo.", "no");
      dico("Il PNG e' comunque nel progetto: " + nomeFile, "forse");
      return;
    }
    var traccia = vecchie[0].traccia, inizio = null, finiva = null;
    try { inizio = await vecchie[0].pezzo.getStartTime(); } catch (e) {}
    for (var q = 0; q < vecchie.length; q++) {
      try {
        var f = await vecchie[q].pezzo.getEndTime();
        if (!finiva || f.seconds > finiva.seconds) finiva = f;
      } catch (e) {}
      if (vecchie[q].traccia < traccia) traccia = vecchie[q].traccia;
    }
    if (!inizio) { dico("Non capisco da dove partono le grafiche.", "no"); return; }

    var editor;
    try { editor = await ppro.SequenceEditor.getEditor(sequenza); }
    catch (e) { dico("Non ottengo l'editor: " + mess(e), "no"); return; }

    await togliVecchie(progetto, editor, ppro, vecchie.map(function (v) { return v.pezzo; }));

    try {
      await progetto.lockedAccess(function () {
        var az = editor.createOverwriteItemAction(immagine, inizio, traccia, -1);
        progetto.executeTransaction(function (g) { g.addAction(az); }, "Como TV: titolo");
      });
      dico("✓ titolo messo su V" + (traccia + 1) + ".", "si");
    } catch (e) { dico("Non metto il titolo: " + mess(e), "no"); return; }

    if (finiva) await pareggiaTitolo(progetto, sequenza, ppro, traccia, finiva);
    return;
  }

  // Come per la maschera: un PNG entra con la durata di default e va
  // allungato fino a dove finivano le grafiche che ha sostituito.
  async function pareggiaTitolo(progetto, sequenza, ppro, traccia, fine) {
    try {
      var tr = await sequenza.getVideoTrack(traccia);
      var pezzi = await tr.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      if (!pezzi || !pezzi.length) return;
      await progetto.lockedAccess(function () {
        var az = pezzi[0].createSetEndAction(fine);
        progetto.executeTransaction(function (g) { g.addAction(az); }, "Como TV: durata titolo");
      });
      dico("✓ durata del titolo pareggiata.", "si");
    } catch (e) { dico("Durata del titolo non pareggiata: " + mess(e), "forse"); }
  }

  // Qui stavano la vecchia scriviTesti e "campiScrivibili": cercavano nelle
  // grafiche un campo di testo scrivibile, e non lo trovavano mai perche'
  // non esiste. Ora il testo non si cerca dentro Premiere: si disegna fuori.

  async function togliVecchie(progetto, editor, ppro, vecchie) {
    var modi = [];

    // il modo giusto, se la classe fa quello che sembra
    modi.push(["selezione", function () {
      var sel = ppro.TrackItemSelection.createEmptySelection();
      for (var i = 0; i < vecchie.length; i++) sel.addItem(vecchie[i], false);
      return editor.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.VIDEO);
    }]);
    modi.push(["selezione senza tipo", function () {
      var sel = ppro.TrackItemSelection.createEmptySelection();
      for (var i = 0; i < vecchie.length; i++) sel.addItem(vecchie[i], false);
      return editor.createRemoveItemsAction(sel, false, true);
    }]);
    modi.push(["elenco", function () {
      return editor.createRemoveItemsAction(vecchie, false, true);
    }]);

    for (var m = 0; m < modi.length; m++) {
      try {
        await progetto.lockedAccess(function () {
          var via = modi[m][1]();
          progetto.executeTransaction(function (g) { g.addAction(via); }, "Como TV: via le vecchie");
        });
        dico("Tolte le " + vecchie.length + " maschere che c'erano (" + modi[m][0] + ").", "si");
        return true;
      } catch (e) { dico("· via " + modi[m][0] + ": " + mess(e), "forse"); }
    }
    dico("Non riesco a togliere le vecchie: la traccia si sporca.", "no");
    dico("   TrackItemSelection espone: " + metodiDi(ppro.TrackItemSelection));
    dico("   l'editor espone: " + metodiDi(editor));
    return false;
  }

  // La maschera appena messa va allungata fino a dove finiva la vecchia,
  // se no ne resta un pezzo scoperto. Non so quale sia il metodo giusto —
  // e a questo punto della giornata ho imparato a non fingere di saperlo:
  // si prova, e se non va si stampa cosa quel pezzo di timeline sa fare.
  async function pareggiaDurata(progetto, sequenza, ppro, quando, fine) {
    if (!fine) return;
    var v2, pezzi;
    try {
      v2 = await sequenza.getVideoTrack(1);
      pezzi = await v2.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    } catch (e) { return; }
    if (!pezzi || pezzi.length < 2) return;      // gia' a posto: una sola clip

    dico("Su V2 sono rimaste " + pezzi.length + " clip: allungo la nuova.", "forse");
    var nuova = pezzi[0];
    try {
      await progetto.lockedAccess(function () {
        var az = nuova.createSetEndAction(fine);
        progetto.executeTransaction(function (g) { g.addAction(az); }, "Como TV: durata maschera");
      });
      dico("✓ durata pareggiata.", "si");
    } catch (e) {
      dico("Non allungo la maschera: " + mess(e), "forse");
      dico("   la clip espone: " + metodiDi(nuova));
    }
  }

  // Qui stava "Prova: titoli come PNG". Ha risposto — salvare sì, scaricare
  // dal ponte sì, importare sì — e una prova che ha risposto non si tiene
  // in giro: diventa il codice vero, che sta piu' sotto.

  // ── il nome della sequenza ─────────────────────────────────────────
  // Le sequenze del master si chiamano "2_DATA_PARTITA_NOME_9-16": DATA,
  // PARTITA e NOME sono segnaposto, non parole. Chi monta li sostituisce a
  // mano, ed e' l'altro punto dove un refuso entra nel progetto e ci resta.
  //
  // Il pannello ha gia' tutto: la data, le due squadre, la competizione.
  // Le mette al posto dei segnaposto e lascia intatto il resto del nome —
  // il numero davanti e il formato in coda dicono cose che Airtable non sa.
  function nomeProposto(vecchio) {
    if (!scelto) return "";
    var d = new Date(scelto.quando);
    var data = isNaN(d) ? "" :
      String(d.getFullYear()) +
      ("0" + (d.getMonth() + 1)).slice(-2) +
      ("0" + d.getDate()).slice(-2);
    var partita = scelto.programma ? scelto.casa : (scelto.casa + "-" + scelto.ospite);
    var comp = (scelto.competizione || "").toUpperCase();

    // Il modello e' il nome com'era PRIMA di ogni rinomina. Alla seconda
    // passata i segnaposto non ci sono piu', e ricostruire il nome da zero
    // — come facevo — butta via quello che Airtable non sa: il numero
    // davanti e il formato in coda. "2_..._9-16" diventava "...", e chi
    // correggeva un titolo si ritrovava la sequenza sfregiata.
    var modello = MODELLI[vecchio] || vecchio;
    if (!/DATA|PARTITA|NOME/.test(modello)) modello = modelloDa(vecchio);
    if (!modello) return "";
    return modello.replace(/DATA/g, data).replace(/PARTITA/g, partita).replace(/NOME/g, comp);
  }

  // Da "1_20260905_AJAX-PSV_EREDIVISIE_9-16" torna indietro a
  // "1_DATA_PARTITA_NOME_9-16". Rifiutarsi di rinominare, come facevo, era
  // sicuro ma scomodo: obbligava a riaprire la sequenza dal master ogni
  // volta che il pannello si ricaricava. La data a otto cifre e' un'ancora
  // affidabile — nessun altro pezzo del nome ha quella forma — e da li' si
  // sa che i due segmenti dopo sono la partita e la competizione.
  function modelloDa(nome) {
    var p = String(nome).split("_");
    for (var i = 0; i < p.length; i++) {
      if (/^\d{8}$/.test(p[i]) && i + 2 <= p.length - 1) {
        return p.slice(0, i).concat(["DATA", "PARTITA", "NOME"]).concat(p.slice(i + 3)).join("_");
      }
      if (/^\d{8}$/.test(p[i]) && i + 2 === p.length + 0) {
        return p.slice(0, i).concat(["DATA", "PARTITA", "NOME"]).join("_");
      }
    }
    return "";
  }

  async function rinomina(progetto, sequenza) {
    var vecchio = sequenza.name || "";
    var nuovo = nomeProposto(vecchio);
    if (!nuovo) {
      dico("Il nome non lo tocco: “" + vecchio + "”", "forse");
      dico("Non ha i segnaposto DATA_PARTITA_NOME e non so quale fosse il", "forse");
      dico("modello, quindi rifarlo da zero butterebbe via il numero davanti", "forse");
      dico("e il formato in coda. Riapri la sequenza dal master, o rimetti il", "forse");
      dico("nome col segnaposto: da li' in poi ci penso io.", "forse");
      return;
    }
    dico("Da: " + vecchio);
    dico("A:  " + nuovo, "si");
    if (nuovo === vecchio) { dico("Gia' cosi': non tocco niente.", "forse"); return; }

    // La sequenza in timeline e la sua voce nel progetto sono due cose
    // diverse: il nome sta sulla seconda, e si ritrova per nome.
    var trovato = await cercaNelProgetto(progetto, vecchio);
    if (!trovato.pezzo) {
      dico("Non trovo la sequenza nel progetto: " + trovato.errore, "no");
      if (trovato.nota) dico("   " + trovato.nota, "forse");
      return;
    }

    try {
      await progetto.lockedAccess(function () {
        var azione = trovato.pezzo.createSetNameAction(nuovo);
        progetto.executeTransaction(function (gruppo) {
          gruppo.addAction(azione);
        }, "Como TV: nome sequenza");
      });
      // Da adesso il nome nuovo sa da dove viene: ripremere il pulsante
      // con un titolo corretto rifara' la stessa sostituzione, non un
      // nome inventato.
      MODELLI[nuovo] = MODELLI[vecchio] || vecchio;
      dico("✓ rinominata.", "si");
      dico("Se non ti torna: Ctrl+Z.", "forse");
    } catch (e) {
      dico("Non riesco a rinominare: " + mess(e), "no");
      dico("La voce di progetto espone: " + metodiDi(trovato.pezzo));
    }
  }

  // ── mettere la maschera ────────────────────────────────────────────
  // I ventinove PNG sono gia' dentro il progetto: non c'e' niente da
  // importare da Y:\\, basta ritrovare il pezzo giusto nel bin. Cercarlo per
  // nome invece che per percorso vuol dire anche che il pannello continua a
  // funzionare se un domani gli asset cambiano cartella.
  async function cercaNelProgetto(progetto, nomeFile) {
    var radice;
    try { radice = await progetto.getRootItem(); }
    catch (e) { return { errore: "non apro il progetto: " + mess(e) }; }

    var cerco = nomeFile.toLowerCase(), coda = [[radice, ""]], visti = 0, raccontato = "";
    while (coda.length && visti < 5000) {
      var g = coda.shift(), it = g[0], dove = g[1];
      visti++;

      var n = "";
      try { n = it.name || ""; } catch (e) {}
      if (n.toLowerCase() === cerco) return { pezzo: it, visti: visti };

      // Una cartella del progetto non si apre com'e': va prima convertita in
      // FolderItem. Senza il cast, getItems() non esiste e la ricerca si
      // ferma al primo piano — sei elementi invece di quarantatre.
      var figli = null, perche = "";
      var cartella = it;
      try { if (PPRO && PPRO.FolderItem && PPRO.FolderItem.cast) cartella = PPRO.FolderItem.cast(it) || it; }
      catch (e) { perche = "cast: " + mess(e); }
      try { figli = await cartella.getItems(); }
      catch (e) { perche = perche || mess(e); }

      if (figli && figli.length) {
        for (var i = 0; i < figli.length; i++) coda.push([figli[i], dove + "/" + n]);
        continue;
      }
      // Il primo che non si apre si annota, ma si racconta solo se la
      // ricerca poi fallisce: una sequenza non e' una cartella, e dirlo
      // mentre tutto funziona sarebbe rumore che nasconde il resto.
      if (!raccontato && perche && !/\./.test(n)) {
        raccontato = "“" + n + "” non si apre: " + perche + "\n   espone: " + metodiDi(it);
      }
    }
    return { errore: "non trovo “" + nomeFile + "” fra i " + visti + " elementi del progetto",
             nota: raccontato };
  }

  // Serve solo quando la ricerca fallisce: elenca il primo piano del
  // progetto, per capire se l'albero e' davvero cosi' piatto o se e' la
  // discesa a non funzionare.
  async function raccontaProgetto(progetto) {
    try {
      var radice = await progetto.getRootItem();
      var cart = radice;
      try { if (PPRO && PPRO.FolderItem && PPRO.FolderItem.cast) cart = PPRO.FolderItem.cast(radice) || radice; } catch (e) {}
      var figli = await cart.getItems();
      dico("Primo piano del progetto (" + (figli ? figli.length : 0) + "):", "forse");
      for (var i = 0; figli && i < figli.length; i++) {
        var n = ""; try { n = figli[i].name || "(senza nome)"; } catch (e) {}
        var q = "?"; 
        try {
          var c = figli[i];
          if (PPRO && PPRO.FolderItem && PPRO.FolderItem.cast) c = PPRO.FolderItem.cast(figli[i]) || figli[i];
          var d = await c.getItems();
          q = d ? d.length + " dentro" : "non apribile";
        } catch (e) { q = "non apribile"; }
        dico("   · " + n + "  [" + q + "]");
      }
    } catch (e) { dico("Non elenco il progetto: " + mess(e), "no"); }
  }

  async function mettiMaschera(progetto, sequenza, ppro) {
    var m = window.Maschere.per(scelto.competizione);
    if (!m.file) {
      dico("Maschera: " + (m.manca ? "manca il PNG di " + m.manca : "competizione mai vista"), "no");
      return;
    }
    dico("Maschera da mettere: " + m.file);

    var trovato = await cercaNelProgetto(progetto, m.file);
    if (!trovato.pezzo) {
      dico(trovato.errore, "no");
      if (trovato.nota) dico("   " + trovato.nota, "forse");
      await raccontaProgetto(progetto);
      return;
    }
    dico("Trovata nel progetto.", "si");

    // Dove: sulla V2, all'attacco della maschera che c'e' adesso — cosi'
    // prende il posto di quella vecchia invece di aggiungersi.
    var quando = null, fine = null, vecchie = null;
    try {
      var v2 = await sequenza.getVideoTrack(1);
      var sopra = await v2.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      if (sopra && sopra.length) {
        vecchie = sopra;
        quando = await sopra[0].getStartTime();
        // Serve anche DOVE FINISCE. Un PNG entra in timeline con la durata
        // di default — cinque secondi — e se la maschera vecchia era piu'
        // lunga ne resta in coda un pezzo: due clip su V2 invece di una.
        // E' il "non aggiunge" che avevo promesso e che non mantenevo.
        try { fine = await sopra[sopra.length - 1].getEndTime(); } catch (e) {}
        dico("Prende il posto di quella che c'e' adesso.");
      }
    } catch (e) {}
    if (!quando) {
      try { quando = await sequenza.getPlayerPosition(); dico("La metto dove sta la testina."); }
      catch (e) { dico("Non so a che punto metterla: " + mess(e), "no"); return; }
    }

    var editor;
    try { editor = await ppro.SequenceEditor.getEditor(sequenza); }
    catch (e) {
      dico("Non ottengo l'editor della sequenza: " + mess(e), "no");
      dico("SequenceEditor espone: " + metodiDi(ppro.SequenceEditor));
      return;
    }

    // "Requires locked access": l'azione non va solo ESEGUITA dentro il
    // lucchetto, va anche COSTRUITA li' dentro. Fabbricarla fuori e portarla
    // dentro non basta — il progetto non si lascia leggere mentre e' libero.
    // Coprire non basta: la maschera vecchia va TOLTA. Allungare quella
    // nuova sopra l'altra lasciava due clip su V2 — il referto le elencava
    // tutte e due. Prima si svuota la traccia, poi si mette la nuova.
    if (vecchie && vecchie.length) await togliVecchie(progetto, editor, ppro, vecchie);

    try {
      await progetto.lockedAccess(function () {
        var azione = editor.createOverwriteItemAction(trovato.pezzo, quando, 1, -1);
        progetto.executeTransaction(function (gruppo) {
          gruppo.addAction(azione);
        }, "Como TV: maschera " + m.file);
      });
      dico("✓ messa su V2.", "si");
      await pareggiaDurata(progetto, sequenza, ppro, quando, fine);
      dico("Se non è dove volevi: Ctrl+Z.", "forse");
    } catch (e) {
      dico("Non riesco a metterla: " + mess(e), "no");
      dico("L'editor espone: " + metodiDi(editor));
    }
  }

  // ── Premiere ───────────────────────────────────────────────────────
  function premiere() {
    try { return require("premierepro"); }
    catch (e) { return null; }
  }

  // Percorre la sequenza e racconta che cosa c'e' dentro. Ogni passo e'
  // protetto: se un metodo non esiste o si chiama in un altro modo, si
  // stampa il perche' e i metodi disponibili, e si va avanti col resto.
  // Qui stavano "leggi la timeline" e le sue sonde: circa trecento righe
  // che servivano a rispondere a una domanda sola — si puo' scrivere il
  // testo dentro una grafica nativa? La risposta e' no, e' documentata nel
  // LEGGIMI con tutte le prove, e il codice che l'ha ottenuta ha finito il
  // suo lavoro. Tenerlo qui spento vorrebbe dire far credere a chi legge
  // che serva ancora a qualcosa.

  // ── portarmi il referto ────────────────────────────────────────────
  // Il pannello gira su un PC di montaggio e io leggo da un Mac: una foto
  // allo schermo perde proprio le righe lunghe, che sono quelle che
  // servono. Lo manda al ponte, che lo scrive in coda a un file.
  //
  // Non porta con se' nessuna chiave: dare a un plugin installato su sette
  // macchine una chiave del ponte, per spedire del testo, sarebbe uno
  // scambio pessimo. Dall'altra parte quell'operazione non tocca niente.
  function mandaReferto() {
    var b = el("btnCopia");
    b.textContent = "Mando…";
    fetch(PONTE, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ tipo: "referto", da: "pannello Premiere",
                             testo: testoDiario() })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        b.textContent = j.ok ? "Mandato ✓" : "Non è partito";
        setTimeout(function () { b.textContent = "Mandami il referto"; }, 3000);
      })
      .catch(function () {
        b.textContent = "Non è partito — fai uno screenshot";
      });
  }

  el("partita").addEventListener("change", mostra);
  el("btnCopia").addEventListener("click", mandaReferto);
  el("btnMask").addEventListener("click", function () {
    mettiTutto().catch(function (e) { dico("Errore: " + mess(e), "no"); });
  });

  caricaPartite();
})();
