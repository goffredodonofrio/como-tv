/**
 * ═══════════════════════════════════════════════════════════════════
 *  GIOVANILI — il database interno dei campionati senza ESPN
 * ═══════════════════════════════════════════════════════════════════
 *
 *  ESPN non copre Primavera 1, Under 17 e Under 18: squadre e rose
 *  vivono qui, mantenute a mano dalla redazione (fonte: Transfermarkt).
 *  Le pagine li riconoscono dal codice "giovanili.*" e pescano da
 *  questo file invece che dalla rete.
 *
 *  Ruoli con le sigle ESPN, per lo schieramento automatico delle
 *  formazioni: G portiere · D difesa · M centrocampo · F attacco.
 *
 *  Rosa Como Under 17 copiata da Transfermarkt il 29/08/2026
 *  (niente numeri di maglia sulla fonte: si scrivono in pagina).
 */
window.GIOVANILI = (function () {
  "use strict";

  var COMPS = [
    { nome: "Primavera 1", code: "giovanili.primavera1", squadre: [] },
    { nome: "Under 17", code: "giovanili.u17", squadre: [
      { id: "como-u17", n: "Como Under 17", rosa: [
        { num: "", nome: "Tommaso",   cognome: "Vischi",          ruolo: "G" },
        { num: "", nome: "Alessandro",cognome: "Posocco",         ruolo: "G" },
        { num: "", nome: "Matteo",    cognome: "Visentin",        ruolo: "G" },
        { num: "", nome: "Simone",    cognome: "Bossi",           ruolo: "G" },
        { num: "", nome: "Nicolò",    cognome: "Pessina",         ruolo: "G" },
        { num: "", nome: "Denis",     cognome: "Nikolli",         ruolo: "D" },
        { num: "", nome: "Tommaso",   cognome: "Vernile",         ruolo: "D" },
        { num: "", nome: "William Carlo", cognome: "Cascella",    ruolo: "D" },
        { num: "", nome: "Matteo",    cognome: "Moscato",         ruolo: "D" },
        { num: "", nome: "Michael",   cognome: "Parodi",          ruolo: "D" },
        { num: "", nome: "Davide",    cognome: "Perna",           ruolo: "D" },
        { num: "", nome: "Alessandro",cognome: "Tondini",         ruolo: "D" },
        { num: "", nome: "Angelo",    cognome: "Pisani",          ruolo: "D" },
        { num: "", nome: "Manuel",    cognome: "Ortelli",         ruolo: "M" },
        { num: "", nome: "Oliver",    cognome: "Nilsson Galic",   ruolo: "M" },
        { num: "", nome: "Filippo",   cognome: "Briccola",        ruolo: "M" },
        { num: "", nome: "Gabriele",  cognome: "Gardanini",       ruolo: "M" },
        { num: "", nome: "Riccardo",  cognome: "Battista",        ruolo: "M" },
        { num: "", nome: "Leonardo",  cognome: "Tiozzo",          ruolo: "M" },
        { num: "", nome: "Rayan",     cognome: "Allaraj",         ruolo: "M" },
        { num: "", nome: "Francesco", cognome: "De Blasio",       ruolo: "M" },
        { num: "", nome: "Mattia",    cognome: "Perugini",        ruolo: "M" },
        { num: "", nome: "Riccardo",  cognome: "Rottigni",        ruolo: "M" },
        { num: "", nome: "Edoardo",   cognome: "Bonzi",           ruolo: "M" },
        { num: "", nome: "Gabriele",  cognome: "Farsaci",         ruolo: "M" },
        { num: "", nome: "Ilias",     cognome: "Khoubaba",        ruolo: "M" },
        { num: "", nome: "Giovanni",  cognome: "Lopes",           ruolo: "F" },
        { num: "", nome: "Achille",   cognome: "Cauli",           ruolo: "F" },
        { num: "", nome: "Matteo",    cognome: "Manfredini",      ruolo: "F" },
        { num: "", nome: "Filippo",   cognome: "Gussoni",         ruolo: "F" },
        { num: "", nome: "Samuele Filippo", cognome: "Insinga",   ruolo: "F" }
      ] }
    ] },
    { nome: "Under 18", code: "giovanili.u18", squadre: [] }
  ];

  function mia(code) { return String(code || "").indexOf("giovanili.") === 0; }
  function comp(code) {
    for (var i = 0; i < COMPS.length; i++) if (COMPS[i].code === code) return COMPS[i];
    return null;
  }
  function squadre(code) {
    var c = comp(code);
    return c ? c.squadre.map(function (q) { return { id: q.id, name: q.n }; }) : [];
  }
  function rosa(code, id) {
    var c = comp(code);
    if (!c) return [];
    for (var i = 0; i < c.squadre.length; i++) {
      if (c.squadre[i].id === String(id)) {
        return c.squadre[i].rosa.map(function (p, k) {
          return { idx: k, num: p.num, nome: p.nome, cognome: p.cognome, ruolo: p.ruolo };
        });
      }
    }
    return [];
  }

  return { COMPS: COMPS, mia: mia, squadre: squadre, rosa: rosa };
})();
