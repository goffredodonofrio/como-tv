/* La chiave delle Grafiche Live — modulo condiviso
 * -------------------------------------------------
 * Prima la chiave stava scritta dentro ogni pagina, e le pagine sono
 * pubblicate su un repo pubblico: chiunque la leggesse poteva comandare
 * qualsiasi canale. Ora non e' piu' nel codice: si digita UNA VOLTA per
 * dispositivo e resta li'.
 *
 * Due livelli soltanto:
 *   contributo  manda grafiche e contributi in scaletta, carica materiale.
 *               Lo hanno gli inviati e i giornalisti, anche da fuori.
 *   comando     mette in onda, toglie, cancella, svuota. Solo la regia.
 *               Chi ha la chiave di comando puo' fare anche il resto.
 *
 *   var TOKEN = ChiaveComoTV.valore();            // pagine di lavoro
 *   var TOKEN = ChiaveComoTV.valore("comando");   // console di regia
 *
 * Se la chiave e' sbagliata il ponte risponde "chiave non valida": la
 * pagina lo dice e con ChiaveComoTV.cambia() se ne mette un'altra.
 */
(function () {
  "use strict";

  var DOVE = { contributo: "comotv.chiave.contributo", comando: "comotv.chiave.comando" };

  function leggi(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  // Se il prompt non c'e' (browser incorporati, chioschi) la pagina non deve
  // morire: si va avanti senza chiave e l'invio dira' che manca.
  function chiedi(testo, preimpostato) {
    try { return (window.prompt(testo, preimpostato || "") || "").trim(); }
    catch (e) { return ""; }
  }
  function scrivi(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function domanda(profilo) {
    return profilo === "comando"
      ? "Chiave di COMANDO della regia.\n\n" +
        "Serve per mandare in onda, togliere e svuotare.\n" +
        "Si digita una volta sola su questo computer."
      : "Chiave delle Grafiche Live.\n\n" +
        "Serve per mandare grafiche e contributi in scaletta.\n" +
        "Si digita una volta sola su questo dispositivo.";
  }

  function valore(profilo) {
    profilo = profilo === "comando" ? "comando" : "contributo";
    // in regia vale anche la sola chiave di comando; in una pagina di lavoro
    // va bene tutte e due, cosi' chi sta in regia non ne digita una seconda
    var mia = leggi(DOVE[profilo]);
    if (!mia && profilo === "contributo") mia = leggi(DOVE.comando);
    if (mia) return mia;
    var v = chiedi(domanda(profilo));
    if (v) scrivi(DOVE[profilo], v);
    return v;
  }

  function cambia(profilo) {
    profilo = profilo === "comando" ? "comando" : "contributo";
    var attuale = leggi(DOVE[profilo]);
    var v = chiedi(domanda(profilo), attuale);
    if (v) { scrivi(DOVE[profilo], v); return v; }
    return attuale;
  }

  function scorda(profilo) {
    try { localStorage.removeItem(DOVE[profilo === "comando" ? "comando" : "contributo"]); } catch (e) {}
  }

  // Due rifiuti diversi, che non vanno confusi:
  //
  //   "chiave non valida"  → la chiave e' sbagliata. Si richiede: riscrivendola
  //                          bene il lavoro riprende.
  //   "richiede la chiave di comando"  → la chiave e' giusta, ma quel gesto
  //                          non spetta a chi lo sta facendo. Richiederla non
  //                          serve a niente: chi non ce l'ha non ce l'ha, e
  //                          insistere lo lascerebbe a girare a vuoto. In
  //                          regia invece ha senso, perche' li' la chiave di
  //                          comando ci deve stare.
  function serveComando(errore) {
    return /richiede la chiave di comando/i.test(String(errore || ""));
  }

  function rifiutata(errore, profilo) {
    var e = String(errore || "");
    var sbagliata = /chiave non valida|token non valido/i.test(e);
    var manca = serveComando(e) && profilo === "comando";
    if (!sbagliata && !manca) return false;
    window.alert(sbagliata
      ? "La chiave non e' valida per questa operazione.\n\n" +
        "Controlla di averla scritta giusta: te la richiedo adesso."
      : "Per questo comando serve la chiave di COMANDO della regia.\n\n" +
        "Te la chiedo adesso.");
    scorda(profilo);
    return !!cambia(profilo);
  }

  window.ChiaveComoTV = { valore: valore, cambia: cambia, scorda: scorda,
                          rifiutata: rifiutata, serveComando: serveComando };
})();
