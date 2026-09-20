/**
 * SQUADRE ESPN — l'elenco delle squadre di una competizione.
 *
 * Le squadre si prendono dalla CLASSIFICA, non dall'elenco /teams: quello
 * ESPN non manda l'intestazione CORS e il browser non lo lascia leggere.
 * Stesse squadre, stessi id. I campionati a gironi hanno piu' classifiche:
 * si uniscono senza doppioni.
 *
 * Le COPPE (e qualche campionato, Svizzera ed Ecuador) la classifica non
 * ce l'hanno: allora l'elenco viene dall'API "core", che il CORS lo manda
 * ma da' solo gli id. I nomi si cercano nelle classifiche dei campionati
 * dello stesso paese (eng.fa -> eng.1..4) e i pochi che restano si
 * chiedono uno per uno.
 *
 * Uso:
 *   SquadreEspn.elenco("ger.1", function (t) { ...avviso... })
 *     -> Promise([{ id, nome, sigla }])  in ordine alfabetico
 *   SquadreEspn.colore("ger.1", "124")
 *     -> Promise("#FDE100")              il colore sociale, per la grafica
 */
window.SquadreEspn = (function () {
  "use strict";

  var CACHE = {}, TINTE = {};

  function classifica(code) {
    return fetch("https://site.api.espn.com/apis/v2/sports/soccer/" + code + "/standings")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var sq = {};
        (function raccogli(nodo) {
          if (!nodo) return;
          ((nodo.standings || {}).entries || []).forEach(function (e) {
            var t = e.team || {};
            if (t.id) sq[t.id] = { nome: t.displayName || t.name || "", sigla: t.abbreviation || "" };
          });
          (nodo.children || []).forEach(raccogli);
        })(j);
        return sq;
      })
      .catch(function () { return {}; });
  }

  // i campionati dello stesso paese: e' li' che stanno i nomi delle
  // squadre che giocano la coppa nazionale
  function cugini(code) {
    var paese = code.split(".")[0], v = [];
    for (var n = 1; n <= 4; n++) v.push(paese + "." + n);
    return v.filter(function (c) { return c !== code; });
  }

  function daCore(code, avviso) {
    return fetch("https://sports.core.api.espn.com/v2/sports/soccer/leagues/" + code + "/teams?limit=400")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var ids = (j.items || []).map(function (x) {
          return ((x.$ref || "").match(/\/teams\/(\d+)/) || [])[1];
        }).filter(Boolean);
        if (!ids.length) return {};
        return Promise.all(cugini(code).map(classifica)).then(function (tutte) {
          var nomi = Object.assign.apply(null, [{}].concat(tutte)), sq = {}, mancano = [];
          ids.forEach(function (id) { if (nomi[id]) sq[id] = nomi[id]; else mancano.push(id); });
          if (mancano.length && avviso) avviso("Cerco i nomi di " + mancano.length + " squadre…");
          function blocco(i) {
            if (i >= mancano.length) return Promise.resolve(sq);
            return Promise.all(mancano.slice(i, i + 12).map(function (id) {
              return fetch("https://sports.core.api.espn.com/v2/sports/soccer/leagues/" + code + "/teams/" + id)
                .then(function (r) { return r.json(); })
                .then(function (t) {
                  sq[id] = { nome: t.displayName || t.name || ("Squadra " + id), sigla: t.abbreviation || "" };
                  if (t.color) TINTE[code + "/" + id] = "#" + String(t.color).replace("#", "");
                })
                .catch(function () {});
            })).then(function () { return blocco(i + 12); });
          }
          return blocco(0);
        });
      })
      .catch(function () { return {}; });
  }

  function elenco(code, avviso) {
    if (CACHE[code]) return Promise.resolve(CACHE[code]);
    return classifica(code)
      .then(function (sq) { return Object.keys(sq).length ? sq : daCore(code, avviso); })
      .then(function (mappa) {
        var v = Object.keys(mappa).map(function (id) {
          return { id: id, nome: mappa[id].nome, sigla: mappa[id].sigla };
        });
        v.sort(function (a, b) { return a.nome.localeCompare(b.nome, "it"); });
        if (v.length) CACHE[code] = v;
        return v;
      });
  }

  // il colore sociale non sta nelle classifiche: si chiede alla squadra,
  // una volta sola, e resta in tasca
  function colore(code, id) {
    var k = code + "/" + id;
    if (TINTE[k]) return Promise.resolve(TINTE[k]);
    return fetch("https://sports.core.api.espn.com/v2/sports/soccer/leagues/" + code + "/teams/" + id)
      .then(function (r) { return r.json(); })
      .then(function (t) {
        var c = "#" + String(t.color || "").replace("#", "");
        if (c.length !== 7) return "";
        TINTE[k] = c;
        return c;
      })
      .catch(function () { return ""; });
  }

  return { elenco: elenco, colore: colore };
})();
