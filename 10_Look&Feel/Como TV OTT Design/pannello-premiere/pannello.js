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

  // Quando qualcosa non risponde come previsto, la domanda vera e'
  // "che cosa sa fare questo oggetto?". La risposta sta nel prototipo.
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
    el("btnScrivi").disabled = false;
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
    var ppro = premiere();
    if (!ppro) { dico("Non trovo l'API di Premiere (require).", "no"); return; }
    dico("API di Premiere: c'e'.", "si");

    var progetto, sequenza;
    try {
      progetto = await ppro.Project.getActiveProject();
      if (!progetto) { dico("Nessun progetto aperto.", "no"); return; }
      dico("Progetto: " + (progetto.name || "(senza nome)"));
      sequenza = await progetto.getActiveSequence();
      if (!sequenza) { dico("Nessuna sequenza aperta.", "no"); return; }
      dico("Sequenza: " + (sequenza.name || "(senza nome)"), "si");
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

  // Di un singolo elemento in timeline interessa una cosa sola: se
  // dentro la sua catena c'e' un parametro di TESTO scrivibile.
  async function raccontaPezzo(pezzo, rientro) {
    var nome = "(senza nome)";
    try {
      var vp = await pezzo.getProjectItem();
      nome = (vp && vp.name) || pezzo.name || nome;
    } catch (e) { try { nome = pezzo.name || nome; } catch (e2) {} }
    dico(rientro + "· " + nome);

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

    for (var c = 0; c < n; c++) {
      var comp, etichetta = "?";
      try {
        comp = await catena.getComponentAtIndex(c);
        etichetta = (await comp.getMatchName()) || "";
      } catch (e) { continue; }

      var quanti = 0;
      try { quanti = await comp.getParamCount(); } catch (e) {}
      if (!quanti) continue;

      var righe = [];
      for (var p = 0; p < quanti; p++) {
        try {
          var par = await comp.getParam(p);
          var pn = await par.getDisplayName();
          righe.push("[" + p + "] " + pn);
          // Un campo che si chiama "Source Text", "Testo" o simili e' il
          // candidato: viene messo da parte per il pulsante "Scrivi", che
          // altrimenti non saprebbe dove mettere le mani.
          if (/text|testo|sorgente/i.test(pn)) {
            testi.push({ dove: nome, comp: etichetta, nome: pn, param: par });
          }
        } catch (e) {}
      }
      if (righe.length) {
        dico(rientro + "  " + etichetta + " → " + righe.join(" · "));
      }
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

    // via 1: l'azione dentro una transazione — la strada documentata
    try {
      var azione = b.param.createSetValueAction(testo, true);
      await progetto.lockedAccess(function () {
        progetto.executeTransaction(function (gruppo) {
          gruppo.addAction(azione);
        }, "Como TV: competizione");
      });
      dico("✓ scritto (azione + transazione)", "si");
      return;
    } catch (e) { dico("· via 1 no: " + e.message, "forse"); }

    // via 2: dritto per dritto, senza transazione
    try {
      await b.param.setValue(testo, true);
      dico("✓ scritto (setValue diretto)", "si");
      return;
    } catch (e) { dico("· via 2 no: " + e.message, "forse"); }

    dico("");
    dico("Non sono riuscito a scrivere. Il parametro espone:", "no");
    dico(metodiDi(b.param));
  }

  // ── portarmi il referto ────────────────────────────────────────────
  // Ricopiare a mano un elenco lungo da un PC all'altro e' il modo piu'
  // sicuro di perdere per strada proprio la riga che serve.
  function copiaReferto() {
    var testo = el("diario").textContent;
    var b = el("btnCopia");
    function bene() { b.textContent = "Copiato ✓"; setTimeout(function () { b.textContent = "Copia il referto"; }, 2000); }
    try {
      var uxp = require("uxp");
      if (uxp && uxp.clipboard && uxp.clipboard.setContent) {
        uxp.clipboard.setContent({ "text/plain": testo });
        bene(); return;
      }
    } catch (e) {}
    try {
      navigator.clipboard.writeText(testo).then(bene, function () {
        b.textContent = "Non ci riesco — fai uno screenshot";
      });
    } catch (e) { b.textContent = "Non ci riesco — fai uno screenshot"; }
  }

  el("partita").addEventListener("change", mostra);
  el("btnLeggi").addEventListener("click", function () {
    leggiTimeline().catch(function (e) { dico("Errore: " + e.message, "no"); });
  });
  el("btnScrivi").addEventListener("click", function () {
    scrivi().catch(function (e) { dico("Errore: " + e.message, "no"); });
  });
  el("btnCopia").addEventListener("click", copiaReferto);

  caricaPartite();
})();
