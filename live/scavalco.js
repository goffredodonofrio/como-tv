/**
 * ═══════════════════════════════════════════════════════════════════
 *  SCAVALCO LOGHI — il magazzino vince su ESPN
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Alcuni stemmi ESPN sono illeggibili sul fondo navy (la Juventus e'
 *  nera piena). Caricando nel magazzino del ponte una versione buona
 *  col nome della squadra, le pagine la preferiscono a quella ESPN.
 *
 *  L'aggancio e' lo stesso delle maglie: prima il nome esatto, poi il
 *  contenimento fra slug (ESPN dice "AC Milan", l'archivio "milan"),
 *  preferendo la chiave piu' lunga e ignorando le chiavi corte sotto i
 *  4 caratteri. Le chiavi "maglia-*" e "foto-*" restano fuori: sono
 *  maglie e volti, non stemmi.
 *
 *  Le giovanili portano lo stemma della prima squadra: il Napoli Primavera
 *  ha il logo del Napoli. Quindi se col nome intero non si trova niente si
 *  riprova col nome del club, tolta la coda. Serve davvero: la regola che
 *  impedisce di vestire un omonimo ("piu' di una parola di differenza")
 *  lasciava passare "Juventus Primavera" — due parole contro una — ma non
 *  "Juventus Under 17", che di parole ne ha tre. Il logo c'era, e la
 *  Primavera lo trovava mentre l'Under no.
 */
window.Scavalco = (function () {
  "use strict";
  var MAP = null;

  function slugS(n) {
    n = String(n || "").toLowerCase();
    try { n = n.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) {}
    return n.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  }

  function carica(ponte) {
    return fetch(ponte + "?loghi=1", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        MAP = {};
        (j.loghi || []).forEach(function (x) {
          if (/^(maglia|foto)-/.test(x.chiave)) return;
          MAP[x.chiave] = x.url;
        });
      })
      .catch(function () { MAP = {}; });
  }

  // la coda che fa di una squadra la giovanile o la femminile di un club:
  // e' la stessa espressione che usano le formazioni premium
  var CODA = /-(primavera|women|femminile|(under|u)-?(1[4-9]|2[0-3]))$/;

  function cerca(mio) {
    if (!mio) return "";
    if (MAP[mio]) return MAP[mio];
    // slug corto o vuoto ("-", "FT", orari): niente aggancio elastico.
    // La stringa vuota e' prefisso di tutto e farebbe vincere una chiave
    // qualsiasi (e' successo: Match Status "-" pescava la Juventus).
    if (mio.length < 4) return "";
    var meglio = "", lungo = 0;
    for (var chiave in MAP) {
      if (chiave.length < 4) continue;
      var mioC = "-" + mio + "-", kC = "-" + chiave + "-";
      if (mioC.indexOf(kC) < 0 && kC.indexOf(mioC) < 0
          && mio.indexOf(chiave) !== 0 && chiave.indexOf(mio) !== 0) continue;
      // omonimi lontani (piu' di una parola di differenza): meglio niente
      // che lo stemma di un altro club
      if (Math.abs(mio.split("-").length - chiave.split("-").length) > 1) continue;
      if (chiave.length > lungo) { lungo = chiave.length; meglio = MAP[chiave]; }
    }
    return meglio;
  }

  function url(nome) {
    if (!MAP || !nome) return "";
    var mio = slugS(nome);
    var suo = cerca(mio);
    if (suo) return suo;
    // niente col nome intero: se e' una giovanile si riprova col club
    var club = mio.replace(CODA, "");
    return club !== mio ? cerca(club) : "";
  }

  return { carica: carica, url: url };
})();
