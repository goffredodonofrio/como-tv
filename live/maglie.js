/**
 * MAGLIE — le divise vere del magazzino, per nome di squadra.
 *
 * Nel magazzino del ponte le divise si chiamano maglia-<squadra>-casa.png,
 * -trasferta, -terza, -quarta. I nomi ESPN non sono quelli dell'archivio
 * ("Internazionale" contro "inter"): l'aggancio e le eccezioni sono gli
 * stessi di formazioni.html, formazioni-premium.html e cambi.html (li'
 * copiati a mano: una riga nuova in ALIAS_MAGLIA va messa anche qui).
 *
 * Uso:
 *   Maglie.carica(function () { ... });        // l'elenco, una volta
 *   Maglie.url("Como", "casa")                  // "" se non c'e'
 *   Maglie.quali("Como")                        // ["casa", "trasferta", ...]
 */
window.Maglie = (function () {
  "use strict";
  var MAGLIE = {}, pronto = false, attese = [], chiesto = false;
  function ponte() {
    return location.pathname.indexOf("/como-tv-dev/") === 0 ? "/como-tv-dev/api" : "/api";
  }
  function slugM(nome) {
    return String(nome || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  }
  var MARCATORE_GIOVANILE = /-(primavera|women|femminile|(under|u)-?(1[4-9]|2[0-3]))$/;
  // Quando il nome che usiamo in onda e' l'italiano e l'archivio tiene
  // l'originale, nessun aggancio elastico puo' salvarci: "rb-lipsia" e
  // "rb-leipzig" non si contengono. Qui la corrispondenza si dichiara, una
  // riga per squadra: e' esatta, quindi non allarga la soglia del
  // contenimento (che resta com'e', per non far vestire all'Estudiantes la
  // maglia dell'Estudiantes de Rio Cuarto).
  var ALIAS_MAGLIA = {
    "rb-lipsia": "rb-leipzig",
    // In 2. Bundesliga ESPN scrive il nome per intero e l'archivio tiene il
    // nome corto: fra "1-fc-nurnberg" e "nurnberg" ci sono due parole di
    // differenza, oltre la soglia del contenimento. La soglia resta com'e',
    // la corrispondenza si dichiara.
    "1-fc-heidenheim-1846": "heidenheim",
    "1-fc-magdeburg": "magdeburg",
    "1-fc-nurnberg": "nurnberg",
    "sv-darmstadt-98": "darmstadt",
    // Controllo del 16/09/2026 su tutte le squadre ESPN delle competizioni in
    // pagina: queste avevano la maglia in archivio ma non la trovavano, o la
    // trovavano solo per l'inizio del nome (Internazionale -> inter, che e'
    // anche l'inizio di Lillestrom -> lille).
    "internazionale": "inter",
    "brighton-hove-albion": "brighton",
    "1-fc-union-berlin": "union-berlin",
    "sc-paderborn-07": "paderborn",
    "fc-cologne": "koln",
    "independiente-medellin": "independiente-med",
    "athletico-pr": "athletico-paranaense",
    "athletic-club": "athletic-bilbao",
    "america-de-cali": "america-cali",
    "2-de-mayo": "2-mayo",
    "remo": "clube-do-remo",
    "estudiantes-de-la-plata": "estudiantes",
    // Vuoto = nessuna maglia: l'aggancio elastico le vestiva con quella di un
    // club dal nome simile (Nacional Asuncion con Atletico Nacional, Libertad
    // dell'Ecuador col Libertad paraguaiano...). Meglio la maglia disegnata.
    "nacional-asuncion": "",
    "nacional-potosi": "",
    "libertad-ecuador": "",
    "independiente-petrolero": "",
    "alianza-atletico": "",
    "universitario": "",
    // ESPN chiama cosi' il Deportivo La Coruna (LaLiga)
    "deportivo": "deportivo-coruna"
  };
  function magliaUrl(nome, dove) {
    var mio = slugM(nome);
    // la corrispondenza dichiarata vince: anche quando dice "nessuna"
    if (ALIAS_MAGLIA.hasOwnProperty(mio)) return ALIAS_MAGLIA[mio] ? magliaDi(ALIAS_MAGLIA[mio], dove) : "";
    var sua = magliaDi(mio, dove);
    if (sua) return sua;
    var club = mio.replace(MARCATORE_GIOVANILE, "");
    if (club === mio) return "";
    sua = magliaDi(club, dove);
    if (sua) return sua;
    return ALIAS_MAGLIA[club] ? magliaDi(ALIAS_MAGLIA[club], dove) : "";
  }
  // L'inizio del nome vale solo quando uno dei due e' stato tagliato a 48
  // caratteri: altrimenti "lille" veste il Lillestrom e "inter" l'Internazionale.
  function troncato(a, b) {
    return Math.max(a.length, b.length) >= 48 && (a.indexOf(b) === 0 || b.indexOf(a) === 0);
  }
  function magliaDi(mio, dove) {
    var k = "maglia-" + mio + "-" + dove;
    if (MAGLIE[k]) return MAGLIE[k];
    if (mio.length < 4) return "";   // slug corto/vuoto: mai l'aggancio elastico
    var fine = "-" + dove, meglio = "", lungo = 0;
    for (var chiave in MAGLIE) {
      if (chiave.slice(-fine.length) !== fine) continue;
      var squadra = chiave.slice(7, -fine.length);
      if (squadra.length < 4) continue;
      var mioC = "-" + mio + "-", sqC = "-" + squadra + "-";
      if (mioC.indexOf(sqC) < 0 && sqC.indexOf(mioC) < 0
          && !troncato(mio, squadra)) continue;
      // omonimi lontani: "estudiantes" NON deve vestire l'Estudiantes de
      // Rio Cuarto. Se le due chiavi differiscono per piu' di una parola,
      // meglio nessuna maglia che quella di un altro club.
      if (Math.abs(mio.split("-").length - squadra.split("-").length) > 1) continue;
      if (squadra.length > lungo) { lungo = squadra.length; meglio = MAGLIE[chiave]; }
    }
    return meglio;
  }
  function carica(poi) {
    if (pronto) { if (poi) poi(); return; }
    if (poi) attese.push(poi);
    if (chiesto) return;
    chiesto = true;
    fetch(ponte() + "?loghi=1", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        (j.loghi || []).forEach(function (x) { if (/^maglia-/.test(x.chiave)) MAGLIE[x.chiave] = x.url; });
      })
      .catch(function () {})
      .then(function () {
        pronto = true;
        var a = attese; attese = [];
        a.forEach(function (f) { try { f(); } catch (e) {} });
      });
  }
  var DOVE = ["casa", "trasferta", "terza", "quarta"];
  return {
    carica: carica,
    url: function (nome, dove) { return pronto && nome && dove ? magliaUrl(nome, dove) : ""; },
    quali: function (nome) { return DOVE.filter(function (d) { return !!(pronto && nome && magliaUrl(nome, d)); }); }
  };
})();
