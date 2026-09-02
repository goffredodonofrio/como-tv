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
    var v = (window.prompt(domanda(profilo), "") || "").trim();
    if (v) scrivi(DOVE[profilo], v);
    return v;
  }

  function cambia(profilo) {
    profilo = profilo === "comando" ? "comando" : "contributo";
    var attuale = leggi(DOVE[profilo]);
    var v = (window.prompt(domanda(profilo), attuale) || "").trim();
    if (v) { scrivi(DOVE[profilo], v); return v; }
    return attuale;
  }

  function scorda(profilo) {
    try { localStorage.removeItem(DOVE[profilo === "comando" ? "comando" : "contributo"]); } catch (e) {}
  }

  // Da chiamare quando il ponte risponde "chiave non valida": invece di
  // lasciare l'operatore davanti a un errore muto, gli si richiede la chiave.
  function rifiutata(errore, profilo) {
    if (!/chiave non valida|token non valido|richiede la chiave/i.test(String(errore || ""))) return false;
    window.alert("La chiave non e' valida per questa operazione.\n\n" +
                 "Controlla di averla scritta giusta: te la richiedo adesso.");
    scorda(profilo);
    return !!cambia(profilo);
  }

  window.ChiaveComoTV = { valore: valore, cambia: cambia, scorda: scorda, rifiutata: rifiutata };
})();
