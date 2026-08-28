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

  function url(nome) {
    if (!MAP || !nome) return "";
    var mio = slugS(nome);
    if (MAP[mio]) return MAP[mio];
    var meglio = "", lungo = 0;
    for (var chiave in MAP) {
      if (chiave.length < 4) continue;
      var mioC = "-" + mio + "-", kC = "-" + chiave + "-";
      if (mioC.indexOf(kC) < 0 && kC.indexOf(mioC) < 0
          && mio.indexOf(chiave) !== 0 && chiave.indexOf(mio) !== 0) continue;
      if (chiave.length > lungo) { lungo = chiave.length; meglio = MAP[chiave]; }
    }
    return meglio;
  }

  return { carica: carica, url: url };
})();
