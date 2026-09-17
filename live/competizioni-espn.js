/**
 * COMPETIZIONI ESPN — la tendina delle competizioni, raggruppata per paese.
 *
 * Una sola lista per tutte le pagine che scelgono una competizione ESPN
 * senza passare da una partita (Talent Hunters, Marcatori piu' giovani):
 * quelle delle formazioni (formazioni-espn.js: campionati, coppe, coppe
 * europee) piu' quelle che servono allo scouting e li' non stanno.
 *
 * Un gruppo per paese, Italia per prima e poi in ordine alfabetico, le
 * internazionali in fondo. Dentro il paese: i campionati per serie, poi le
 * coppe, poi le supercoppe.
 *
 * Uso:
 *   CompetizioniEspn.riempi(select, function () { ...pronta... });
 *   CompetizioniEspn.info("ita.1")  -> { code, nome, band, paese }
 */
window.CompetizioniEspn = (function () {
  "use strict";

  var IN_PIU = [
    { band: "🇪🇸", nome: "LaLiga 2", code: "esp.2" },
    { band: "🇪🇸", nome: "Supercopa de España", code: "esp.super_cup" },
    { band: "🇩🇪", nome: "Supercoppa di Germania", code: "ger.super_cup" },
    { band: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", nome: "Community Shield", code: "eng.charity" },
    { band: "🇫🇷", nome: "Trophée des Champions", code: "fra.super_cup" },
    { band: "🇳🇱", nome: "KNVB Beker", code: "ned.cup" },
    { band: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", nome: "Scottish Cup", code: "sco.tennents" },
    { band: "🇬🇷", nome: "Super League Grecia", code: "gre.1" },
    { band: "🇧🇪", nome: "Pro League Belgio", code: "bel.1" },
    { band: "🇹🇷", nome: "Süper Lig", code: "tur.1" },
    { band: "🇩🇰", nome: "Superliga Danimarca", code: "den.1" },
    { band: "🇨🇭", nome: "Super League Svizzera", code: "sui.1" },
    { band: "🇸🇪", nome: "Allsvenskan", code: "swe.1" },
    { band: "🇳🇴", nome: "Eliteserien", code: "nor.1" },
    { band: "🇷🇺", nome: "Premier League Russia", code: "rus.1" },
    { band: "🇧🇷", nome: "Copa do Brasil", code: "bra.copa_do_brazil" },
    { band: "🇨🇴", nome: "Primera A Colombia", code: "col.1" },
    { band: "🇺🇾", nome: "Primera División Uruguay", code: "uru.1" },
    { band: "🇨🇱", nome: "Primera División Cile", code: "chi.1" },
    { band: "🇪🇨", nome: "LigaPro Ecuador", code: "ecu.1" },
    { band: "🇵🇾", nome: "Primera División Paraguay", code: "par.1" },
    { band: "🇵🇪", nome: "Liga 1 Perù", code: "per.1" },
    { band: "🇲🇽", nome: "Liga MX", code: "mex.1" },
    { band: "🇺🇸", nome: "US Open Cup", code: "usa.open" },
    { band: "🇯🇵", nome: "J.League", code: "jpn.1" },
    { band: "🇨🇳", nome: "Super League Cina", code: "chn.1" },
    { band: "🇦🇺", nome: "A-League", code: "aus.1" },
    { band: "🌍", nome: "Mondiale per club", code: "fifa.cwc" }
  ];
  var PAESE = { ita: "Italia", esp: "Spagna", ger: "Germania", eng: "Inghilterra", fra: "Francia",
    ned: "Paesi Bassi", por: "Portogallo", sco: "Scozia", ksa: "Arabia Saudita", arg: "Argentina",
    bra: "Brasile", aut: "Austria", usa: "Stati Uniti", gre: "Grecia", bel: "Belgio", tur: "Turchia",
    den: "Danimarca", sui: "Svizzera", swe: "Svezia", nor: "Norvegia", rus: "Russia", col: "Colombia",
    uru: "Uruguay", chi: "Cile", ecu: "Ecuador", par: "Paraguay", per: "Perù", mex: "Messico",
    jpn: "Giappone", chn: "Cina", aus: "Australia" };
  var INTERNAZIONALI = [["uefa", "🇪🇺 Europa · UEFA"], ["conmebol", "🌎 Sudamerica · CONMEBOL"], ["fifa", "🌍 Mondo · FIFA"]];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function tutte() {
    var visti = {}, lista = [];
    ((window.FormazioniEspn && FormazioniEspn.competizioni) || []).concat(IN_PIU).forEach(function (c) {
      if (!c.code || visti[c.code]) return;
      visti[c.code] = 1;
      lista.push(c);
    });
    return lista;
  }
  function info(code) {
    var c = tutte().filter(function (x) { return x.code === code; })[0];
    if (!c) return null;
    return { code: c.code, nome: c.nome, band: c.band || "", paese: PAESE[c.code.split(".")[0]] || "" };
  }

  function disegna(sel) {
    var perPaese = {};
    tutte().forEach(function (c, n) {
      var k = c.code.split(".")[0];
      (perPaese[k] = perPaese[k] || []).push({ c: c, n: n });
    });
    function peso(x) {
      var m = x.c.code.match(/\.(\d)$/);
      return m ? +m[1] : /super|charity/.test(x.c.code) ? 30 : 20;
    }
    function gruppo(k, etichetta) {
      var lista = (perPaese[k] || []).sort(function (a, b) { return peso(a) - peso(b) || a.n - b.n; });
      if (!lista.length) return "";
      return '<optgroup label="' + esc(etichetta) + '">' + lista.map(function (x) {
        return '<option value="' + esc(x.c.code) + '">' + esc((x.c.band ? x.c.band + " " : "") + x.c.nome) + "</option>";
      }).join("") + "</optgroup>";
    }
    var paesi = Object.keys(perPaese).filter(function (k) { return PAESE[k]; }).sort(function (a, b) {
      return (a === "ita" ? -1 : b === "ita" ? 1 : PAESE[a].localeCompare(PAESE[b], "it"));
    });
    // un codice di un paese che non e' nella tabella non deve sparire: va in fondo col suo prefisso
    var ignoti = Object.keys(perPaese).filter(function (k) {
      return !PAESE[k] && !INTERNAZIONALI.some(function (x) { return x[0] === k; });
    });
    sel.innerHTML = '<option value="">—</option>' +
      paesi.map(function (k) { return gruppo(k, perPaese[k][0].c.band + " " + PAESE[k]); }).join("") +
      ignoti.map(function (k) { return gruppo(k, k.toUpperCase()); }).join("") +
      INTERNAZIONALI.map(function (x) { return gruppo(x[0], x[1]); }).join("");
  }

  // formazioni-espn.js puo' non esserci ancora: si carica, e la tendina si
  // riempie comunque (al peggio con le sole competizioni di qui)
  function riempi(sel, fatto) {
    function via() { disegna(sel); if (fatto) fatto(); }
    if (window.FormazioniEspn) return via();
    var s = document.createElement("script");
    s.src = "formazioni-espn.js";
    s.onload = via; s.onerror = via;
    document.head.appendChild(s);
  }

  return { riempi: riempi, info: info };
})();
