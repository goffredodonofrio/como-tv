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
        } catch (e) {}
      }
      if (righe.length) {
        dico(rientro + "  " + etichetta + " → " + righe.join(" · "));
      }
    }
  }

  // ── scrivere ───────────────────────────────────────────────────────
  // Milestone 0. Finche' il "Leggi la timeline" non dice dove sta il
  // parametro di testo, questo non puo' sapere dove scrivere: quindi
  // per adesso spiega che cosa gli manca invece di provare a caso e
  // fallire in un modo che non insegna niente.
  function scrivi() {
    if (!scelto) return;
    pulisci();
    dico("Da scrivere: “" + (scelto.competizione || "") + "”");
    dico("");
    dico("Manca il passo che decide il progetto: dove.", "forse");
    dico("Premi 'Leggi la timeline' con il master aperto e mandami");
    dico("quello che esce. Da li' si sa se il testo si scrive dentro");
    dico("la grafica nativa o se serve passare dal modello di grafica");
    dico("animata esportato da Premiere.");
  }

  el("partita").addEventListener("change", mostra);
  el("btnLeggi").addEventListener("click", function () {
    leggiTimeline().catch(function (e) { dico("Errore: " + e.message, "no"); });
  });
  el("btnScrivi").addEventListener("click", scrivi);

  caricaPartite();
})();
