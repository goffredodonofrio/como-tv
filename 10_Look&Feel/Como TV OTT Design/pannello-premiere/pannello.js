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

  // getStartValue() non restituisce il valore: restituisce il KEYFRAME che
  // lo contiene, e stampandolo si ottiene "[object Object]". Il valore va
  // tirato fuori da li', e non so ancora per quale via: si provano quelle
  // plausibili e, se falliscono tutte, si dice che cosa il keyframe espone —
  // cosi' la volta dopo la via giusta si legge invece di indovinarla.
  var kfRaccontato = false;
  async function valoreDi(par) {
    var k;
    try { k = await par.getStartValue(); }
    catch (e) { return { nota: "non leggibile (" + e.message + ")" }; }
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
          if (v !== undefined && typeof v !== "object" && String(v) !== "[object Object]") {
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
      var righe = [], inciampo = "";
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

          if (/source text|^text$|testo/i.test(pn)) {
            testi.push({ dove: nome, comp: etichetta, nome: pn, param: par });
          }
        } catch (e) { if (!inciampo) inciampo = e.message || String(e); }
      }

      if (righe.length) {
        // Il testo va a capo per riga: 22 parametri su una riga sola non si
        // leggono. I filtri restano compatti, sono solo nomi.
        if (eTesto) {
          dico(rientro + "  " + etichetta + ":", "si");
          righe.forEach(function (r) { dico(rientro + "    " + r); });
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

    // createSetValueAction non vuole il testo nudo: vuole un keyframe, che
    // si fabbrica dal valore. E' il passaggio che mi era sfuggito.
    try {
      var kf = b.param.createKeyframe(testo);
      var azione = b.param.createSetValueAction(kf, true);
      await progetto.lockedAccess(function () {
        progetto.executeTransaction(function (gruppo) {
          gruppo.addAction(azione);
        }, "Como TV: competizione");
      });
      dico("✓ scritto (keyframe + transazione)", "si");
      return;
    } catch (e) { dico("· via 1 no: " + e.message, "forse"); }

    // via 2: la transazione presa dal progetto senza lockedAccess intorno
    try {
      var kf2 = b.param.createKeyframe(testo);
      var az2 = b.param.createSetValueAction(kf2, true);
      await progetto.executeTransaction(function (gruppo) {
        gruppo.addAction(az2);
      }, "Como TV: competizione");
      dico("✓ scritto (transazione senza lock)", "si");
      return;
    } catch (e) { dico("· via 2 no: " + e.message, "forse"); }

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

  caricaPartite();
})();
