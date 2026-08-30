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
    // Rosa Como Primavera 26/27 copiata da Transfermarkt il 29/08/2026.
    { nome: "Primavera 1", code: "giovanili.primavera1", squadre: [
      { id: "como-primavera", n: "Como Primavera", tid: "2572", rosa: [
        { num: "33", nome: "Nicol\u00f2",  cognome: "Bensi",            ruolo: "G" },
        { num: "1",  nome: "Mattia",       cognome: "Damioli",          ruolo: "G" },
        { num: "24", nome: "Lorenzo Luigi", cognome: "Ginelli",          ruolo: "G" },
        { num: "42", nome: "Dylan",        cognome: "Sgarbi",           ruolo: "G" },
        { num: "",   nome: "Davide",       cognome: "Mezzanotte",       ruolo: "D" },
        { num: "23", nome: "Cristiano",    cognome: "De Paoli",         ruolo: "D" },
        { num: "2",  nome: "Almamy",       cognome: "Soumah",           ruolo: "D" },
        { num: "6",  nome: "Federico",     cognome: "Grilli",           ruolo: "D" },
        { num: "4",  nome: "Jo\u00e3o",    cognome: "Gabriel",          ruolo: "D" },
        { num: "",   nome: "Lorenzo",      cognome: "Canepari",         ruolo: "D" },
        { num: "15", nome: "Edoardo",      cognome: "Franzosi",         ruolo: "D" },
        { num: "25", nome: "Fabio",        cognome: "Ronchetti",        ruolo: "D" },
        { num: "26", nome: "Adam",         cognome: "Asfour",           ruolo: "D" },
        { num: "45", nome: "Lorenzo",      cognome: "Epifani",          ruolo: "D" },
        { num: "66", nome: "Lorenzo",      cognome: "de Paula",         ruolo: "D" },
        { num: "73", nome: "Matteo",       cognome: "Albini",           ruolo: "D" },
        { num: "74", nome: "Mattia",       cognome: "Arioli",           ruolo: "D" },
        { num: "",   nome: "Lyfe",         cognome: "Oldenstam",        ruolo: "D" },
        { num: "46", nome: "Matteo",       cognome: "Zanaria",          ruolo: "D" },
        { num: "13", nome: "Levente",      cognome: "B\u0151sze",       ruolo: "M" },
        { num: "8",  nome: "Francesco",    cognome: "Andrealli",        ruolo: "M" },
        { num: "",   nome: "Alessandro",   cognome: "Licata",           ruolo: "M" },
        { num: "",   nome: "Salvatore",    cognome: "Mastriani",        ruolo: "M" },
        { num: "5",  nome: "Alessio",      cognome: "Baralla",          ruolo: "M" },
        { num: "22", nome: "Sebastian",    cognome: "Burlacu",          ruolo: "M" },
        { num: "29", nome: "Stefano",      cognome: "Arui",             ruolo: "M" },
        { num: "70", nome: "Andrea",       cognome: "Ballone",          ruolo: "M" },
        { num: "21", nome: "Matteo",       cognome: "Papaccioli",       ruolo: "M" },
        { num: "49", nome: "Riccardo",     cognome: "Cassano",          ruolo: "M" },
        { num: "10", nome: "Cristian",     cognome: "Mazzara",          ruolo: "M" },
        { num: "",   nome: "Michael",      cognome: "La Monaca",        ruolo: "M" },
        { num: "77", nome: "Thomas",       cognome: "Boccia",           ruolo: "M" },
        { num: "",   nome: "Miguel",       cognome: "Silva",            ruolo: "F" },
        { num: "",   nome: "Mohamed",      cognome: "el Fezani",        ruolo: "F" },
        { num: "14", nome: "Achille",      cognome: "Tigano",           ruolo: "F" },
        { num: "17", nome: "Italo",        cognome: "Bulgheroni",       ruolo: "F" },
        { num: "11", nome: "Lorenzo",      cognome: "Bonsignori",       ruolo: "F" },
        { num: "",   nome: "Ettore",       cognome: "Broggian",         ruolo: "F" },
        { num: "",   nome: "Pedro",        cognome: "Demiddi",          ruolo: "F" },
        { num: "27", nome: "Samuele",      cognome: "Pisati",           ruolo: "F" },
        { num: "9",  nome: "Robin",        cognome: "Thiland-Herard",   ruolo: "F" },
        { num: "",   nome: "Zebedee",      cognome: "Kennedy",          ruolo: "F" },
        { num: "19", nome: "Kevin",        cognome: "Fustini",          ruolo: "F" },
        { num: "41", nome: "Leonardo",     cognome: "Casati",           ruolo: "F" },
        { num: "51", nome: "Mattia",       cognome: "Terranova",        ruolo: "F" },
        { num: "78", nome: "Francesco",    cognome: "Lembo",            ruolo: "F" },
        { num: "79", nome: "Diego",        cognome: "Martinez",         ruolo: "F" }
      ] },
      // le avversarie del girone: solo nome (rose scritte a mano),
      // servono per menu' e magliette dal magazzino
      { id: "albinoleffe-primavera", n: "AlbinoLeffe Primavera", rosa: [] },
      { id: "atalanta-primavera", n: "Atalanta Primavera", tid: "105", rosa: [] },
      { id: "bologna-primavera", n: "Bologna Primavera", tid: "107", rosa: [] },
      { id: "cagliari-primavera", n: "Cagliari Primavera", tid: "2925", rosa: [] },
      { id: "cesena-primavera", n: "Cesena Primavera", tid: "3337", rosa: [] },
      { id: "empoli-primavera", n: "Empoli Primavera", tid: "2574", rosa: [] },
      { id: "fiorentina-primavera", n: "Fiorentina Primavera", tid: "109", rosa: [] },
      { id: "genoa-primavera", n: "Genoa Primavera", tid: "3263", rosa: [] },
      { id: "hellas-verona-primavera", n: "Hellas Verona Primavera", tid: "119", rosa: [] },
      { id: "inter-primavera", n: "Inter Primavera", tid: "110", rosa: [] },
      { id: "juventus-primavera", n: "Juventus Primavera", tid: "111", rosa: [] },
      { id: "lazio-primavera", n: "Lazio Primavera", tid: "112", rosa: [] },
      { id: "lecce-primavera", n: "Lecce Primavera", tid: "113", rosa: [] },
      { id: "milan-primavera", n: "Milan Primavera", tid: "103", rosa: [] },
      { id: "monza-primavera", n: "Monza Primavera", tid: "4007", rosa: [] },
      { id: "parma-primavera", n: "Parma Primavera", tid: "115", rosa: [] },
      { id: "roma-primavera", n: "Roma Primavera", tid: "104", rosa: [] },
      { id: "sassuolo-primavera", n: "Sassuolo Primavera", tid: "3997", rosa: [] },
      { id: "torino-primavera", n: "Torino Primavera", tid: "239", rosa: [] }
    ] },
    { nome: "Under 17", code: "giovanili.u17", squadre: [
      { id: "como-u17", n: "Como Under 17", tid: "2572", rosa: [
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
      ] },
      { id: "atalanta-under-17", n: "Atalanta Under 17", rosa: [] },
      { id: "cagliari-under-17", n: "Cagliari Under 17", rosa: [] },
      { id: "hellas-verona-under-17", n: "Hellas Verona Under 17", rosa: [] },
      { id: "inter-under-17", n: "Inter Under 17", rosa: [] },
      { id: "mantova-under-17", n: "Mantova Under 17", rosa: [] },
      { id: "milan-under-17", n: "Milan Under 17", rosa: [] },
      { id: "monza-under-17", n: "Monza Under 17", rosa: [] },
      { id: "padova-under-17", n: "Padova Under 17", rosa: [] },
      { id: "sudtirol-under-17", n: "Südtirol Under 17", rosa: [] },
      { id: "udinese-under-17", n: "Udinese Under 17", rosa: [] },
      { id: "venezia-under-17", n: "Venezia Under 17", rosa: [] },
      { id: "vicenza-under-17", n: "Vicenza Under 17", rosa: [] }
    ] },
    { nome: "Under 18", code: "giovanili.u18", squadre: [
      // Rosa dalla distinta ufficiale Hellas Verona-Como del 30/08/2026
      // Rosa dal \"Gruppo squadra U18 ss 26-27\" ufficiale (30/08/2026):
      // 26 giocatori, numeri definitivi. Esterni (ED/ES) come centrocampisti.
      // Allenatore: Giovanni Fietta (staff: vice Le Noci).
      { id: "como-u18", n: "Como Under 18", tid: "2572", rosa: [
        { num: "1",  nome: "Lorenzo Luigi",  cognome: "Ginelli",            ruolo: "G" },
        { num: "23", nome: "Lorenzo",        cognome: "Femia",              ruolo: "G" },
        { num: "33", nome: "Nicol\u00f2",    cognome: "Bensi",              ruolo: "G" },
        { num: "42", nome: "Dylan",          cognome: "Sgarbi",             ruolo: "G" },
        { num: "2",  nome: "Edoardo",        cognome: "Franzosi",           ruolo: "D" },
        { num: "3",  nome: "Tommaso",        cognome: "Sportoletti",        ruolo: "D" },
        { num: "5",  nome: "Adam",           cognome: "Asfour",             ruolo: "D" },
        { num: "6",  nome: "Lorenzo",        cognome: "Canepari",           ruolo: "D" },
        { num: "18", nome: "Matteo",         cognome: "Zanaria",            ruolo: "D" },
        { num: "22", nome: "Mattia",         cognome: "Arioli",             ruolo: "D" },
        { num: "25", nome: "Angelo",         cognome: "Pisani",             ruolo: "D" },
        { num: "4",  nome: "Stefano",        cognome: "Arui",               ruolo: "M" },
        { num: "8",  nome: "Pedro",          cognome: "Demiddi Gaido",      ruolo: "M" },
        { num: "11", nome: "Miguel",         cognome: "Da Silva Joao",      ruolo: "M" },
        { num: "14", nome: "Achille",        cognome: "Tigano",             ruolo: "M" },
        { num: "17", nome: "Mattia",         cognome: "Terranova",          ruolo: "M" },
        { num: "19", nome: "Davide",         cognome: "Mezzanotte",         ruolo: "M" },
        { num: "20", nome: "Pietro",         cognome: "Mornati",            ruolo: "M" },
        { num: "21", nome: "Francesco",      cognome: "Mascetti",           ruolo: "M" },
        { num: "23", nome: "Filippo",        cognome: "Zanoletti",          ruolo: "M" },
        { num: "49", nome: "Riccardo",       cognome: "Cassano",            ruolo: "M" },
        { num: "79", nome: "Diego Manuel",   cognome: "Martinez Esparrago", ruolo: "M" },
        { num: "7",  nome: "Francesco Paolo", cognome: "Lembo",             ruolo: "F" },
        { num: "9",  nome: "Marco",          cognome: "Colugnat",           ruolo: "F" },
        { num: "10", nome: "Thomas",         cognome: "Boccia",             ruolo: "F" },
        { num: "11", nome: "Leonardo",       cognome: "Casati",             ruolo: "F" }
      ] },
      { id: "atalanta-under-18", n: "Atalanta Under 18", rosa: [] },
      { id: "bologna-under-18", n: "Bologna Under 18", rosa: [] },
      { id: "cagliari-under-18", n: "Cagliari Under 18", rosa: [] },
      { id: "cesena-under-18", n: "Cesena Under 18", rosa: [] },
      { id: "fiorentina-under-18", n: "Fiorentina Under 18", rosa: [] },
      { id: "frosinone-under-18", n: "Frosinone Under 18", rosa: [] },
      { id: "genoa-under-18", n: "Genoa Under 18", rosa: [] },
      { id: "hellas-verona-under-18", n: "Hellas Verona Under 18", rosa: [] },
      { id: "inter-under-18", n: "Inter Under 18", rosa: [] },
      { id: "juventus-under-18", n: "Juventus Under 18", rosa: [] },
      { id: "lazio-under-18", n: "Lazio Under 18", rosa: [] },
      { id: "lecce-under-18", n: "Lecce Under 18", rosa: [] },
      { id: "milan-under-18", n: "Milan Under 18", rosa: [] },
      { id: "monza-under-18", n: "Monza Under 18", rosa: [] },
      { id: "napoli-under-18", n: "Napoli Under 18", rosa: [] },
      { id: "parma-under-18", n: "Parma Under 18", rosa: [] },
      { id: "roma-under-18", n: "Roma Under 18", rosa: [] },
      { id: "sassuolo-under-18", n: "Sassuolo Under 18", rosa: [] },
      { id: "torino-under-18", n: "Torino Under 18", rosa: [] }
    ] }
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
  function tid(code, id) {
    var c = comp(code);
    if (!c) return "";
    for (var i = 0; i < c.squadre.length; i++)
      if (c.squadre[i].id === String(id)) return c.squadre[i].tid || "";
    return "";
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

  return { COMPS: COMPS, mia: mia, squadre: squadre, rosa: rosa, tid: tid };
})();
