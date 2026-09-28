/**
 * PAESI — i nomi delle nazionali in italiano, per le grafiche.
 *
 * ESPN scrive i paesi in inglese ("Italy", "Northern Ireland U21"). In onda
 * vanno in italiano e in maiuscolo, entro i 16 caratteri delle grafiche.
 * Lo usano i Risultati e le Classifiche: un elenco solo, cosi' lo stesso
 * paese non si chiama in due modi in due grafiche.
 *
 *   PaesiIt.nome("Italy U21")  -> "ITALIA U21"
 *   PaesiIt.nome("Juventus")   -> null   (non e' un paese: decide la pagina)
 */
window.PaesiIt = (function () {
  "use strict";
  // Le nazionali: ESPN scrive i paesi in inglese. In grafica vanno in
  // italiano, gia' entro i 16 caratteri; le Under tengono il loro suffisso
  // ("Italy U21" -> "ITALIA U21"). I club non c'entrano: un nome che non e'
  // un paese passa com'e'.
  var PAESI = {
    "Italy": "ITALIA", "France": "FRANCIA", "Spain": "SPAGNA", "Germany": "GERMANIA", "England": "INGHILTERRA",
    "Portugal": "PORTOGALLO", "Netherlands": "OLANDA", "Belgium": "BELGIO", "Croatia": "CROAZIA",
    "Switzerland": "SVIZZERA", "Austria": "AUSTRIA", "Denmark": "DANIMARCA", "Sweden": "SVEZIA",
    "Norway": "NORVEGIA", "Finland": "FINLANDIA", "Iceland": "ISLANDA", "Poland": "POLONIA",
    "Czechia": "REP. CECA", "Czech Republic": "REP. CECA", "Slovakia": "SLOVACCHIA", "Slovenia": "SLOVENIA",
    "Hungary": "UNGHERIA", "Romania": "ROMANIA", "Bulgaria": "BULGARIA", "Serbia": "SERBIA",
    "Montenegro": "MONTENEGRO", "Bosnia-Herzegovina": "BOSNIA", "Bosnia and Herzegovina": "BOSNIA",
    "North Macedonia": "MACEDONIA NORD", "Albania": "ALBANIA", "Kosovo": "KOSOVO", "Greece": "GRECIA",
    "Turkey": "TURCHIA", "Türkiye": "TURCHIA", "Cyprus": "CIPRO", "Malta": "MALTA", "Georgia": "GEORGIA",
    "Armenia": "ARMENIA", "Azerbaijan": "AZERBAIGIAN", "Ukraine": "UCRAINA", "Belarus": "BIELORUSSIA",
    "Moldova": "MOLDAVIA", "Russia": "RUSSIA", "Lithuania": "LITUANIA", "Latvia": "LETTONIA",
    "Estonia": "ESTONIA", "Scotland": "SCOZIA", "Wales": "GALLES", "Northern Ireland": "IRLANDA DEL NORD",
    "Republic of Ireland": "IRLANDA", "Ireland": "IRLANDA", "Luxembourg": "LUSSEMBURGO",
    "Liechtenstein": "LIECHTENSTEIN", "Andorra": "ANDORRA", "San Marino": "SAN MARINO",
    "Gibraltar": "GIBILTERRA", "Faroe Islands": "FAROE", "Kazakhstan": "KAZAKISTAN", "Israel": "ISRAELE",
    "Brazil": "BRASILE", "Argentina": "ARGENTINA", "Uruguay": "URUGUAY", "Colombia": "COLOMBIA",
    "Chile": "CILE", "Peru": "PERÙ", "Ecuador": "ECUADOR", "Paraguay": "PARAGUAY", "Bolivia": "BOLIVIA",
    "Venezuela": "VENEZUELA", "Mexico": "MESSICO", "United States": "STATI UNITI", "USA": "STATI UNITI",
    "Canada": "CANADA", "Costa Rica": "COSTA RICA", "Panama": "PANAMA", "Jamaica": "GIAMAICA",
    "Honduras": "HONDURAS", "Morocco": "MAROCCO", "Senegal": "SENEGAL", "Nigeria": "NIGERIA",
    "Ghana": "GHANA", "Ivory Coast": "COSTA D'AVORIO", "Cote d'Ivoire": "COSTA D'AVORIO",
    "Côte d'Ivoire": "COSTA D'AVORIO", "Cameroon": "CAMERUN", "Algeria": "ALGERIA", "Tunisia": "TUNISIA",
    "Egypt": "EGITTO", "South Africa": "SUDAFRICA", "Congo DR": "RD CONGO", "Mali": "MALI",
    "DR Congo": "RD CONGO", "Congo": "CONGO", "Burkina Faso": "BURKINA FASO", "Guinea": "GUINEA",
    "Guinea-Bissau": "GUINEA-BISSAU", "Equatorial Guinea": "GUINEA EQUAT.", "Gabon": "GABON",
    "Central African Republic": "CENTRAFRICA", "Chad": "CIAD", "Niger": "NIGER", "Benin": "BENIN",
    "Togo": "TOGO", "Sierra Leone": "SIERRA LEONE", "Liberia": "LIBERIA", "Gambia": "GAMBIA",
    "The Gambia": "GAMBIA", "Mauritania": "MAURITANIA", "Cape Verde": "CAPO VERDE",
    "Cape Verde Islands": "CAPO VERDE", "Cabo Verde": "CAPO VERDE", "Libya": "LIBIA", "Sudan": "SUDAN",
    "South Sudan": "SUD SUDAN", "Ethiopia": "ETIOPIA", "Eritrea": "ERITREA", "Somalia": "SOMALIA",
    "Djibouti": "GIBUTI", "Kenya": "KENYA", "Uganda": "UGANDA", "Tanzania": "TANZANIA",
    "Rwanda": "RUANDA", "Burundi": "BURUNDI", "Angola": "ANGOLA", "Zambia": "ZAMBIA",
    "Zimbabwe": "ZIMBABWE", "Malawi": "MALAWI", "Mozambique": "MOZAMBICO", "Namibia": "NAMIBIA",
    "Botswana": "BOTSWANA", "Lesotho": "LESOTHO", "Eswatini": "ESWATINI", "Madagascar": "MADAGASCAR",
    "Comoros": "COMORE", "Mauritius": "MAURITIUS", "Seychelles": "SEYCHELLES",
    "Sao Tome and Principe": "SÃO TOMÉ", "São Tomé and Príncipe": "SÃO TOMÉ",
    "Japan": "GIAPPONE", "South Korea": "COREA DEL SUD", "Korea Republic": "COREA DEL SUD",
    "Australia": "AUSTRALIA", "Iran": "IRAN", "Saudi Arabia": "ARABIA SAUDITA", "Qatar": "QATAR",
    "United Arab Emirates": "EMIRATI ARABI", "Iraq": "IRAQ", "China PR": "CINA", "China": "CINA",
    "New Zealand": "NUOVA ZELANDA", "Uzbekistan": "UZBEKISTAN", "Jordan": "GIORDANIA"
  };
  var CORTI = { "IRLANDA DEL NORD": "IRLANDA NORD", "MACEDONIA NORD": "MACEDONIA N.", "COREA DEL SUD": "COREA SUD",
                "ARABIA SAUDITA": "ARABIA S.", "NUOVA ZELANDA": "N. ZELANDA", "COSTA D'AVORIO": "C. D'AVORIO",
                "STATI UNITI": "USA", "LIECHTENSTEIN": "LIECHTENST.", "EMIRATI ARABI": "EMIRATI",
                "LUSSEMBURGO": "LUSSEMB.", "INGHILTERRA": "INGHILTERRA" };
  function nomePaese(s) {
    var m = String(s || "").trim().match(/^(.+?)(\s+(U\d{2}|Women|Olympic))?$/);
    if (!m || !PAESI[m[1]]) return null;
    var suff = m[3] ? (m[3] === "Women" ? " F" : m[3] === "Olympic" ? " OLIMPICA" : " " + m[3]) : "";
    var base = PAESI[m[1]];
    // col suffisso i nomi lunghi sforano i 16 caratteri della grafica:
    // "IRLANDA DEL NORD U21" diventa "IRLANDA NORD U21"
    if ((base + suff).length > 16) base = CORTI[base] || base.slice(0, Math.max(3, 15 - suff.length)) + ".";
    return base + suff;
  }
  // Il nome intero con le minuscole, per i campi e le grafiche che non
  // scrivono tutto maiuscolo: "Northern Ireland U21" -> "Irlanda del Nord U21".
  // Qui non si accorcia: il limite dei 16 caratteri e' delle linguette.
  var PICCOLE = { "DEL": "del", "DELLA": "della", "E": "e", "DI": "di" };
  function proprio(s) {
    var m = String(s || "").trim().match(/^(.+?)(\s+(U\d{2}|Women|Olympic))?$/);
    if (!m || !PAESI[m[1]]) return null;
    var base = PAESI[m[1]].split(" ").map(function (w, i) {
      if (i && PICCOLE[w]) return PICCOLE[w];
      if (/^(RD|USA)$/.test(w)) return w;                      // sigle
      if (/^D'/.test(w)) return "d'" + w.charAt(2) + w.slice(3).toLowerCase();
      return w.charAt(0) + w.slice(1).toLowerCase();
    }).join(" ");
    var suff = m[3] ? (m[3] === "Women" ? " femminile" : m[3] === "Olympic" ? " olimpica" : " " + m[3]) : "";
    return base + suff;
  }
  // il nome di una squadra ESPN: se e' una nazionale in italiano, se no com'e'
  function squadra(s) { return proprio(s) || s; }
  return { nome: nomePaese, proprio: proprio, squadra: squadra };
})();
// scorciatoia per le pagine: (window.sqIt || String)(nomeEspn)
window.sqIt = function (n) { return window.PaesiIt ? window.PaesiIt.squadra(n) : n; };
