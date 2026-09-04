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

  // Quello che la lettura della timeline ha trovato e che somiglia a un
  // campo di testo. Serve al pulsante "Scrivi": senza aver guardato prima,
  // non c'e' modo di sapere dove scrivere.
  var testi = [];

  function el(id) { return document.getElementById(id); }

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
  async function scriviTesti(progetto, sequenza, ppro) {
    var valori = [el("t1").value.trim(), el("t2").value.trim(), el("sott").value.trim()];
    if (!valori[0] && !valori[1] && !valori[2]) { dico("Nessun testo da mettere."); return; }

    var campi = await campiScrivibili(sequenza, ppro);
    if (!campi.length) {
      dico("I testi non li so ancora mettere.", "no");
      dico("Le grafiche native tengono il testo in un formato che UXP non", "forse");
      dico("sa scrivere — verificato, non supposto. Serve il modello di", "forse");
      dico("grafica animata: in timeline seleziona le tre grafiche, poi", "forse");
      dico("Grafica → Esporta come modello di grafica animata. Fatto una", "forse");
      dico("volta, da li' in poi i testi li mette il pannello.", "forse");
      return;
    }

    dico("Campi di testo scrivibili: " + campi.length, "si");
    for (var i = 0; i < campi.length && i < valori.length; i++) {
      if (!valori[i]) continue;
      try {
        await progetto.lockedAccess(function () {
          var az = campi[i].par.createSetValueAction(valori[i], true);
          progetto.executeTransaction(function (g) { g.addAction(az); }, "Como TV: testo");
        });
        dico("✓ " + campi[i].nome + " ← “" + valori[i] + "”", "si");
      } catch (e) {
        dico("· " + campi[i].nome + ": " + mess(e), "forse");
      }
    }
  }

  // Un campo scrivibile e' un parametro di testo che NON sia di quelli
  // arbitrari: si riconoscono perche' il loro valore si lascia leggere.
  async function campiScrivibili(sequenza, ppro) {
    var fuori = [];
    var quante = 0;
    try { quante = await sequenza.getVideoTrackCount(); } catch (e) { return fuori; }
    for (var i = 0; i < quante; i++) {
      var pezzi = [];
      try {
        var tr = await sequenza.getVideoTrack(i);
        pezzi = await tr.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      } catch (e) { continue; }
      for (var k = 0; k < (pezzi || []).length; k++) {
        var catena;
        try { catena = await pezzi[k].getComponentChain(); } catch (e) { continue; }
        var n = 0;
        try { n = await catena.getComponentCount(); } catch (e) { continue; }
        for (var c = 0; c < n; c++) {
          var comp;
          try { comp = await catena.getComponentAtIndex(c); } catch (e) { continue; }
          var q = 0;
          try { q = await comp.getParamCount(); } catch (e) {}
          for (var p = 0; p < q; p++) {
            try {
              var par = await comp.getParam(p);
              var pn = par.displayName || "";
              if (!/text|testo/i.test(pn)) continue;
              // La prova del nove: un parametro arbitrario non si lascia
              // leggere. Se il valore torna, e' una stringa vera.
              var v = await par.getStartValue();
              if (v === null || v === undefined) continue;
              fuori.push({ par: par, nome: "V" + (i + 1) + " · " + pn });
            } catch (e) {}
          }
        }
      }
    }
    return fuori;
  }

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
    if (!/DATA|PARTITA|NOME/.test(modello)) return "";
    return modello.replace(/DATA/g, data).replace(/PARTITA/g, partita).replace(/NOME/g, comp);
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
    var quando = null;
    try {
      var v2 = await sequenza.getVideoTrack(1);
      var sopra = await v2.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      if (sopra && sopra.length) {
        quando = await sopra[0].getStartTime();
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
    try {
      await progetto.lockedAccess(function () {
        var azione = editor.createOverwriteItemAction(trovato.pezzo, quando, 1, -1);
        progetto.executeTransaction(function (gruppo) {
          gruppo.addAction(azione);
        }, "Como TV: maschera " + m.file);
      });
      dico("✓ messa su V2.", "si");
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
  async function leggiTimeline() {
    pulisci();
    testi = [];
    kfRaccontato = false;
    var ppro = premiere();
    if (!ppro) { dico("Non trovo l'API di Premiere (require).", "no"); return; }
    dico("API di Premiere: c'e'.", "si");

    // La domanda "esiste un modo per toccare le grafiche?" non ha risposta
    // nella documentazione pubblica. Ma l'ha qui: queste sono le classi che
    // la versione installata espone davvero. Vale piu' di qualsiasi pagina.
    try {
      dico("Classi dell'API: " + Object.keys(ppro).sort().join(", "));
      dico("");
    } catch (e) { dico("Non elenco le classi: " + e.message, "forse"); }

    var progetto, sequenza;
    try {
      progetto = await ppro.Project.getActiveProject();
      if (!progetto) { dico("Nessun progetto aperto.", "no"); return; }
      dico("Progetto: " + (progetto.name || "(senza nome)"));
      sequenza = await progetto.getActiveSequence();
      if (!sequenza) { dico("Nessuna sequenza aperta.", "no"); return; }
      dico("Sequenza: " + (sequenza.name || "(senza nome)"), "si");
      SEQ = sequenza; PPRO = ppro;
    } catch (e) {
      dico("Non arrivo alla sequenza: " + e.message, "no");
      dico("Project espone: " + metodiDi(ppro.Project));
      return;
    }

    var quante;
    try { quante = await sequenza.getVideoTrackCount(); }
    catch (e) {
      dico("Non conto le tracce: " + e.message, "no");
      dico("La sequenza espone: " + metodiDi(sequenza));
      return;
    }
    dico("Tracce video: " + quante);
    dico("");

    for (var i = 0; i < quante; i++) {
      var traccia, pezzi = [];
      try {
        traccia = await sequenza.getVideoTrack(i);
        pezzi = await traccia.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      } catch (e) {
        dico("V" + (i + 1) + ": non leggo gli elementi (" + e.message + ")", "forse");
        if (traccia) dico("   la traccia espone: " + metodiDi(traccia));
        continue;
      }
      if (!pezzi || !pezzi.length) { dico("V" + (i + 1) + ": vuota"); continue; }
      dico("V" + (i + 1) + ": " + pezzi.length + " element" + (pezzi.length === 1 ? "o" : "i"), "si");

      for (var k = 0; k < pezzi.length; k++) await raccontaPezzo(pezzi[k], "   ");
      dico("");
    }
    dico("— fine —", "si");
    dico("Serve la riga di un parametro di testo su V2/V3/V4/V5:", "forse");
    dico("e' li' che il pannello andra' a scrivere.", "forse");
  }

  // ── la sonda sul "Testo sorgente" ──────────────────────────────────
  // createKeyframe("Eredivisie") risponde "Illegal Parameter type": il testo
  // di una grafica non e' una stringa. Per sapere che cosa sia, si legge
  // quello che c'e' adesso — il valore vero dice il tipo meglio di qualunque
  // documentazione, e finora ha avuto ragione ogni volta.
  //
  // getStartValue() su questo parametro torna vuoto, quindi si passa da
  // getValueAtTime, che pero' vuole un tempo: e i modi di fabbricarne uno
  // sono piu' d'uno. Si provano in fila e si dice quale ha risposto.
  // I modi di fabbricare un tempo sono piu' d'uno e non tutti valgono per
  // tutti i parametri: si preparano tutti e si prova in fila.
  async function tempiPossibili(pezzo, sequenza, ppro) {
    var tempi = [];
    function aggiungi(come, f) { try { tempi.push([come, f()]); } catch (e) {} }
    aggiungi("TIME_ZERO", function () { return ppro.TickTime.TIME_ZERO; });
    aggiungi("0 secondi", function () { return ppro.TickTime.createWithSeconds(0); });
    var extra = [["inizio clip", "getInPoint"], ["attacco clip", "getStartTime"]];
    for (var i = 0; i < extra.length; i++) {
      try { tempi.push([extra[i][0], await pezzo[extra[i][1]]()]); } catch (e) {}
    }
    try { tempi.push(["testina", await sequenza.getPlayerPosition()]); } catch (e) {}
    return tempi;
  }

  // Il keyframe che TIENE il valore. Non si crea — createKeyframe su questo
  // parametro risponde sempre "Illegal Parameter type", perche' il testo non
  // si anima — si prende quello che c'e' gia'. Lo dice l'API stessa, dentro
  // l'errore di getValueAtTime: "Use GetKeyframeAtTime to get a keyframe
  // object at time. The value can be extracted from the keyframe object."
  async function keyframeDi(par, pezzo, sequenza, ppro, racconta) {
    var tempi = await tempiPossibili(pezzo, sequenza, ppro);

    // Il tempo migliore non lo indovino: lo chiedo. Se il parametro sa
    // elencare i tempi dei suoi keyframe, quelli sono giusti per definizione.
    try {
      var suoi = await par.getKeyframeListAsTickTimes();
      if (racconta) racconta("tempi suoi: " + (suoi && suoi.length ? suoi.length : "nessuno"));
      if (suoi && suoi.length) {
        for (var q = 0; q < suoi.length; q++) tempi.unshift(["suo #" + q, suoi[q]]);
      }
    } catch (e) { if (racconta) racconta("non elenca i suoi tempi: " + mess(e)); }

    // ...e comunque non e' detto che voglia un TickTime: puo' volere i
    // secondi, o i tick nudi. Si prova ogni forma di ogni tempo.
    var forme = [];
    tempi.forEach(function (t) {
      forme.push([t[0], t[1]]);
      try { if (t[1] && typeof t[1].seconds === "number") forme.push([t[0] + " (secondi)", t[1].seconds]); } catch (e) {}
      try { if (t[1] && typeof t[1].ticks !== "undefined") forme.push([t[0] + " (tick)", t[1].ticks]); } catch (e) {}
    });
    forme.push(["zero nudo", 0]);

    var ultimo = "";
    for (var f = 0; f < forme.length; f++) {
      try {
        var k = await par.getKeyframePtr(forme[f][1]);
        if (k) return { kf: k, come: forme[f][0] };
        ultimo = "risposta vuota";
      } catch (e) { ultimo = mess(e); }
    }
    return { errore: ultimo || "nessuna forma di tempo ha funzionato",
             provate: forme.length };
  }

  async function sondaTesto(par, pezzo, sequenza, ppro, rientro) {
    var tempi = await tempiPossibili(pezzo, sequenza, ppro);

    var preso = await keyframeDi(par, pezzo, sequenza, ppro, function (r) {
      dico(rientro + "  " + r, "forse");
    });
    if (preso.kf) {
      dico(rientro + "  keyframe preso (" + preso.come + ")", "si");
      dico(rientro + "    contiene: “" + String(preso.kf.value).replace(/\s+/g, " ").slice(0, 90) + "”", "si");
      dico(rientro + "    espone: " + metodiDi(preso.kf));
      return;
    }
    dico(rientro + "  keyframe non preso dopo " + preso.provate +
         " forme di tempo — ultimo: " + preso.errore, "no");
    // Se nemmeno cosi' si prende, la strada corta e' chiusa e si passa al
    // modello di grafica animata. Ma prima: che cosa risponde il parametro
    // alle altre domande? Sono le ultime rimaste.
    try { dico(rientro + "    varia nel tempo: " + await par.isTimeVarying()); } catch (e) { dico(rientro + "    varia nel tempo: " + mess(e)); }
    try { var v0 = await par.getStartValue(); dico(rientro + "    valore d'attacco: " + (v0 === null ? "nullo" : v0 === undefined ? "assente" : String(v0))); }
    catch (e) { dico(rientro + "    valore d'attacco: " + mess(e)); }

    // "Illegal Parameter type" puo' voler dire due cose molto diverse: che
    // gli passo il tipo sbagliato, o che QUESTO parametro non accetta
    // keyframe affatto. La prima si aggiusta, la seconda chiude la strada e
    // manda al modello di grafica animata. Le distingue una domanda sola.
    try { dico(rientro + "  accetta keyframe: " + (await par.areKeyframesSupported() ? "sì" : "NO"), "si"); }
    catch (e) { dico(rientro + "  accetta keyframe: non risponde (" + mess(e) + ")", "forse"); }

    // E se li accetta, di che tipo li vuole: si offrono valori di specie
    // diversa e si guarda quale non viene rifiutato.
    var assaggi = [["testo", "Eredivisie"], ["numero", 0], ["vero/falso", true], ["oggetto vuoto", {}]];
    for (var a = 0; a < assaggi.length; a++) {
      try { par.createKeyframe(assaggi[a][1]); dico(rientro + "    keyframe da " + assaggi[a][0] + ": accettato", "si"); }
      catch (e) { dico(rientro + "    keyframe da " + assaggi[a][0] + ": " + mess(e), "forse"); }
    }

    if (!tempi.length) { dico(rientro + "  non riesco a fabbricare un tempo", "no"); return; }

    for (var t = 0; t < tempi.length; t++) {
      var v;
      try { v = await par.getValueAtTime(tempi[t][1]); }
      catch (e) { dico(rientro + "  (" + tempi[t][0] + ") no: " + mess(e), "forse"); continue; }

      var tipo = typeof v;
      var classe = v && v.constructor ? v.constructor.name : "";
      dico(rientro + "  (" + tempi[t][0] + ") tipo: " + tipo + (classe ? " / " + classe : ""), "si");
      if (v === null || v === undefined) { dico(rientro + "    vuoto"); continue; }
      if (tipo !== "object") { dico(rientro + "    valore: “" + String(v).slice(0, 120) + "”", "si"); return; }

      try { dico(rientro + "    campi: " + Object.keys(v).join(", ")); } catch (e) {}
      dico(rientro + "    espone: " + metodiDi(v));
      try {
        var j = JSON.stringify(v);
        if (j && j !== "{}") dico(rientro + "    dentro: " + j.slice(0, 400));
      } catch (e) {}
      return;
    }
  }

  // getStartValue() non restituisce il valore: restituisce il KEYFRAME che
  // lo contiene, e stampandolo si ottiene "[object Object]". Il valore va
  // tirato fuori da li', e non so ancora per quale via: si provano quelle
  // plausibili e, se falliscono tutte, si dice che cosa il keyframe espone —
  // cosi' la volta dopo la via giusta si legge invece di indovinarla.
  var kfRaccontato = false;
  async function valoreDi(par) {
    var k;
    try { k = await par.getStartValue(); }
    catch (e) { return { nota: "non leggibile (" + mess(e) + ")" }; }
    if (k === undefined || k === null) return {};

    if (typeof k === "string" || typeof k === "number" || typeof k === "boolean") {
      return { testo: String(k).replace(/\s+/g, " ").slice(0, 70) };
    }
    if (k.value !== undefined && typeof k.value !== "object") {
      return { testo: String(k.value).replace(/\s+/g, " ").slice(0, 70) };
    }
    for (var i = 0; i < 3; i++) {
      var via = ["getValue", "value", "toString"][i];
      try {
        if (typeof k[via] === "function") {
          var v = await k[via]();
          if (v !== undefined && typeof v !== "object" && !/^\[object /.test(String(v))) {
            return { testo: String(v).replace(/\s+/g, " ").slice(0, 70) };
          }
        }
      } catch (e) {}
    }
    if (!kfRaccontato) { kfRaccontato = true; return { nota: "il keyframe espone: " + metodiDi(k) }; }
    return {};
  }

  // Di un singolo elemento in timeline interessa una cosa sola: se
  // dentro la sua catena c'e' un parametro di TESTO scrivibile.
  async function raccontaPezzo(pezzo, rientro) {
    // Le grafiche native non hanno un elemento nel progetto — sono nate in
    // timeline — quindi getProjectItem() non da' un nome e prima uscivano
    // tutte come "(senza nome)". Il nome vero sta altrove: si prova in fila.
    var nome = "";
    try { var vp = await pezzo.getProjectItem(); nome = (vp && vp.name) || ""; } catch (e) {}
    if (!nome) { try { nome = await pezzo.getName(); } catch (e) {} }
    if (!nome) { try { nome = pezzo.name || ""; } catch (e) {} }
    dico(rientro + "· " + (nome || "(senza nome)"));

    var catena;
    try { catena = await pezzo.getComponentChain(); }
    catch (e) {
      dico(rientro + "  niente catena (" + e.message + ")", "forse");
      dico(rientro + "  l'elemento espone: " + metodiDi(pezzo));
      return;
    }

    var n = 0;
    try { n = await catena.getComponentCount(); }
    catch (e) {
      dico(rientro + "  non conto i componenti: " + e.message, "forse");
      dico(rientro + "  la catena espone: " + metodiDi(catena));
      return;
    }
    dico(rientro + "  componenti: " + n);
    // Un elemento senza componenti non e' un silenzio da interpretare: e' la
    // risposta. Ma per capire se manca il contenuto o manca la strada per
    // arrivarci, serve sapere che cosa quell'elemento sa fare.
    if (!n) {
      dico(rientro + "  l'elemento espone: " + metodiDi(pezzo), "forse");
      return;
    }

    for (var c = 0; c < n; c++) {
      var comp, etichetta = "?";
      try {
        comp = await catena.getComponentAtIndex(c);
        etichetta = (await comp.getMatchName()) || "";
      } catch (e) { dico(rientro + "  [" + c + "] non leggibile: " + e.message, "forse"); continue; }

      var quanti = 0;
      try { quanti = await comp.getParamCount(); } catch (e) {}
      // Anche i componenti senza parametri vanno detti: il nome basta a
      // riconoscere una grafica, e prima li saltavo in silenzio.
      if (!quanti) { dico(rientro + "  " + etichetta + " (nessun parametro)"); continue; }

      // Del componente del testo interessa anche il CONTENUTO: e' l'unico
      // modo di capire quale delle grafiche e' il titolo, quale il
      // sottotitolo e quale la competizione. Dei filtri (opacita', movimento)
      // bastano i nomi.
      var eTesto = /text/i.test(etichetta);
      var righe = [], inciampo = "", sonde = [];
      for (var p = 0; p < quanti; p++) {
        try {
          var par = await comp.getParam(p);
          // displayName e' una PROPRIETA', non un metodo: chiamarlo come
          // funzione faceva fallire tutti e 22 i parametri in silenzio.
          var pn = par.displayName || "";
          var voce = "[" + p + "] " + pn;

          if (eTesto) {
            var v = await valoreDi(par);
            if (v.testo) voce += " = “" + v.testo + "”";
            else if (v.nota) voce += "  ← " + v.nota;
          }
          righe.push(voce);

          if (/source text|^text$|testo sorgente/i.test(pn)) {
            testi.push({ dove: nome, comp: etichetta, nome: pn, param: par, pezzo: pezzo });
            righe.push("   ↑ e' questo il campo del testo — lo sondo:");
            sonde.push(par);
          }
        } catch (e) { if (!inciampo) inciampo = e.message || String(e); }
      }

      if (righe.length) {
        // Il testo va a capo per riga: 22 parametri su una riga sola non si
        // leggono. I filtri restano compatti, sono solo nomi.
        if (eTesto) {
          dico(rientro + "  " + etichetta + ":", "si");
          righe.forEach(function (r) { dico(rientro + "    " + r); });
          for (var q = 0; q < sonde.length; q++) {
            await sondaTesto(sonde[q], pezzo, SEQ, PPRO, rientro + "  ");
          }
        } else {
          dico(rientro + "  " + etichetta + " → " + righe.join(" · "));
        }
        continue;
      }

      // Qui prima non stampavo niente, e il referto sembrava dire "questa
      // grafica non ha parametri" mentre diceva soltanto che io non ero
      // riuscito a leggerli. Sono due cose diverse: la prima chiude il
      // progetto, la seconda e' un mio errore di chiamata.
      dico(rientro + "  " + etichetta + ": dichiara " + quanti +
           " parametri ma non ne leggo nessuno", "forse");
      if (inciampo) dico(rientro + "    inciampo: " + inciampo, "forse");
      dico(rientro + "    il componente espone: " + metodiDi(comp));
    }
  }

  // ── scrivere ───────────────────────────────────────────────────────
  // Milestone 0. Prima guarda (se non l'ha gia' fatto), poi prova a
  // scrivere davvero nel primo campo di testo che ha trovato.
  //
  // Le vie per scrivere sono piu' d'una e non sono sicuro di quale sia
  // quella buona su Premiere 26: si provano in fila e si dice quale ha
  // funzionato. Se falliscono tutte si stampano i metodi che il
  // parametro espone davvero — che e' la risposta vera alla domanda.
  async function scrivi() {
    if (!scelto) return;
    var testo = scelto.competizione || "";

    if (!testi.length) {
      dico("Prima guardo la timeline, non so ancora dove scrivere.", "forse");
      await leggiTimeline();
      if (!testi.length) {
        dico("");
        dico("Nessun campo di testo trovato: non c'e' dove scrivere.", "no");
        dico("E' la risposta che cercavamo — vuol dire strada lunga:", "forse");
        dico("modello di grafica animata esportato da dentro Premiere.", "forse");
        return;
      }
    }

    var b = testi[0];
    dico("");
    dico("Provo a scrivere “" + testo + "”");
    dico("dentro: " + b.dove + " → " + b.comp + " → " + b.nome);
    dico("(se fa danni, Ctrl+Z annulla)", "forse");

    var ppro = premiere();
    var progetto = await ppro.Project.getActiveProject();

    // Il keyframe si PRENDE, non si crea: questo parametro non si anima, ma
    // il suo valore vive comunque dentro un keyframe. Si prende quello che
    // c'e', gli si cambia il valore, e si rimette dov'era.
    var preso = await keyframeDi(b.param, b.pezzo, SEQ, PPRO, function (r) { dico("· " + r); });
    if (!preso.kf) { dico("Non prendo il keyframe: " + preso.errore, "no"); return; }
    dico("· keyframe preso (" + preso.come + "), conteneva: “" +
         String(preso.kf.value).replace(/\s+/g, " ").slice(0, 60) + "”");

    try { preso.kf.value = testo; }
    catch (e) { dico("Non cambio il valore: " + mess(e), "no"); return; }

    try {
      var azione = b.param.createSetValueAction(preso.kf, true);
      await progetto.lockedAccess(function () {
        progetto.executeTransaction(function (gruppo) {
          gruppo.addAction(azione);
        }, "Como TV: competizione");
      });
      dico("✓ scritto (keyframe preso + transazione)", "si");
      return;
    } catch (e) { dico("· via 1 no: " + mess(e), "forse"); }

    // via 2: la transazione presa dal progetto senza lockedAccess intorno
    try {
      var az2 = b.param.createSetValueAction(preso.kf, true);
      await progetto.executeTransaction(function (gruppo) {
        gruppo.addAction(az2);
      }, "Como TV: competizione");
      dico("✓ scritto (transazione senza lock)", "si");
      return;
    } catch (e) { dico("· via 2 no: " + mess(e), "forse"); }

    dico("");
    dico("Non sono riuscito a scrivere. Il parametro espone:", "no");
    dico(metodiDi(b.param));
  }

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
  el("btnLeggi").addEventListener("click", function () {
    leggiTimeline().catch(function (e) { dico("Errore: " + e.message, "no"); });
  });
  el("btnScrivi").addEventListener("click", function () {
    scrivi().catch(function (e) { dico("Errore: " + e.message, "no"); });
  });
  el("btnCopia").addEventListener("click", mandaReferto);
  el("btnMask").addEventListener("click", function () {
    mettiTutto().catch(function (e) { dico("Errore: " + mess(e), "no"); });
  });

  caricaPartite();
})();
