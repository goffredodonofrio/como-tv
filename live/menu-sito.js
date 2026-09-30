/**
 * MENU-SITO — il menu' unico di projects-cloud.it (Goffredo, 27/09/2026:
 * "sistema tutti i menu' interni con lo stesso principio della home").
 *
 * Home, poi le sei aree della home, nello stesso ordine, ognuna con la sua
 * tendina che si apre al clic: Live · Grafiche statiche e Social Media ·
 * MAM e Magazzino Como TV · MAM e Magazzino Como 1907 · Dipendenti e documenti
 * VMIX · Guida. "Live" e' una tendina larga a colonne con tutte le grafiche
 * (Partita, Editoriali, Data Viz, Tabelloni, Crawl) e gli strumenti.
 * A destra c'e' il posto per chi e' entrato (utente.js) e per i tasti della
 * pagina (il MAM ci mette i suoi: window.NAV_MAM.destra).
 *
 * Si usa cosi': un <nav class="ms-bar"> (anche vuoto, o con dentro un
 * <span class="ms-destra">) e questo script. Lo includono la home, nav.js
 * (tutte le pagine grafiche), nav-mam.js (MAM, Magazzino, MAM 1907) e il
 * Registro di controllo. Le tendine si aprono col clic, mai col passaggio del
 * mouse: in diretta una tendina che si apre da sola fa aprire la pagina sbagliata.
 *
 * NB: l'elenco delle grafiche sta anche in nav.js (window.COMO_NAV, che il MAM
 * mostra nel suo menu' "Como TV"): se si aggiunge un formato, va messo in tutti e due.
 */
(function () {
  "use strict";
  var PRE = /^\/como-tv-dev\//.test(location.pathname) ? "/como-tv-dev/" : "/como-tv/";
  var OTT = "10_Look%26Feel/Como%20TV%20OTT%20Design/generatore.html";
  var AREE = [
    { k: "live", nome: "Live", largo: true, gruppi: [
      { nome: "Strumenti", voci: [["live/classifiche.html", "Catalogo grafiche"], ["live/vademecum.html", "Vademecum"], ["live/telecronaca.html", "Telecronaca"],
        ["live/redazione.html", "Controllo redazione"], ["live/regia.html", "Regia"]] },
      { nome: "Partita", voci: [["live/formazioni-premium.html", "Formazioni Premium con foto"], ["live/formazioni-premium.html?maglie=1", "Formazioni Premium solo maglie"],
        ["live/formazioni.html", "Formazioni"], ["live/cambi.html", "Cambi"], ["live/risultati.html", "Risultati"], ["live/classifiche-campionati.html", "Classifiche"],
        ["live/marcatori.html", "Marcatori"], ["live/marcatori-giovani.html", "Marcatori più giovani"], ["live/tiri.html", "Mappa dei tiri"],
        ["live/passaggi.html", "Mappa dei passaggi"], ["live/heatmap.html", "Heatmap"], ["live/precedenti.html", "I precedenti"], ["live/forma.html", "Come arrivano"]] },
      { nome: "Editoriali", voci: [["live/statistiche.html", "Statistiche"], ["live/scheda.html", "Scheda"], ["live/focus.html", "Focus"], ["live/dichiarazioni.html", "Dichiarazioni"],
        ["live/volti.html", "Volti"], ["live/talent-hunters.html", "Talent Hunters"], ["live/goleada.html", "Goleada"]] },
      { nome: "Data Viz", voci: [["live/dataviz.html?k=valore", "Valore di mercato"], ["live/dataviz.html?k=valori", "Valore a confronto"], ["live/dataviz.html?k=golpres", "Gol e presenze"],
        ["live/dataviz.html?k=stagioni", "Numeri per stagione"], ["live/dataviz.html?k=squadre", "Squadre a confronto"]] },
      { nome: "Tabelloni", voci: [["live/tabelloni.html", "Tabelloni e gironi"], ["live/appuntamenti.html", "Prossimi appuntamenti"]] },
      { nome: "Crawl", voci: [["live/ticker.html", "Ticker"], ["live/sottopancia.html", "Sottopancia"], ["live/sfondi.html", "Sfondi per i box"], ["live/contributi.html", "Contributi video"]] }
    ] },
    { k: "grafiche", nome: "Grafiche statiche e Social Media", voci: [[OTT, "Grafiche Statiche"], [OTT + "?solo=social", "Social Video e Maschere"], ["uefa-club-channel.html", "UEFA Club Channel"]] },
    { k: "mam", nome: "MAM e Magazzino Como TV", voci: [["live/mam2.html", "MAM Como TV"], ["live/mam2.html?raccolte=1", "Raccolte / Macchie"], ["live/mam2.html?live=1", "MAM Como TV | Live"],
      ["live/mam2.html?montaggio=1", "Editing"], ["live/magazzino.html", "Magazzino"]] },
    { k: "1907", nome: "MAM e Magazzino Como 1907", voci: [["live/mam-1907.html", "MAM Como 1907"], ["live/mam-1907.html#partite", "Partite del Como"], ["live/mam2.html?montaggio=1&ambito=1907", "Editor 1907"], ["live/mam-1907.html#raccolte", "Raccolte 1907"],
      ["live/cartelle-1907.html", "Cartelle 1907"], ["live/doppioni-1907.html", "Doppioni 1907"], [null, "Magazzino 1907", "in arrivo"]] },
    { k: "dipendenti", nome: "Dipendenti e documenti VMIX", voci: [["index.html#presenze-dipendenti", "Presenze Dipendenti"], ["live/turni.html", "Turni"], ["index.html#vmix", "Documenti VMIX"]] },
    { k: "guida", nome: "Guida", voci: [["guida/index.html", "Guida"], ["guida/palestra.html", "Palestra"]] }
  ];
  // le pagine "figlie" appartengono alla voce del capofila
  var FIGLIE = { "magazzino-foto.html": "magazzino.html", "video.html": "magazzino.html", "barra.html": "ticker.html",
    "th-carta.html": "talent-hunters.html", "th-approved.html": "talent-hunters.html", "th-not-approved.html": "talent-hunters.html", "th-heatmap.html": "talent-hunters.html",
    "th-heatmap-evidenza.html": "talent-hunters.html", "th-torta.html": "talent-hunters.html", "th-radar.html": "talent-hunters.html", "th-radar-confronto.html": "talent-hunters.html",
    "goleada-tabellone.html": "goleada.html", "goleada-10challenge.html": "goleada.html", "goleada-bonus.html": "goleada.html", "goleada-eleven.html": "goleada.html",
    "goleada-misterx.html": "goleada.html", "goleada-rivela.html": "goleada.html" };

  // dove siamo: il percorso dentro il sito, con la sua domanda
  var rel = location.pathname.indexOf(PRE) === 0 ? decodeURIComponent(location.pathname.slice(PRE.length)) : "";
  var file = (rel.split("/").pop() || "index.html").toLowerCase(); file = FIGLIE[file] || file;
  var cartella = rel.indexOf("/") > 0 ? rel.split("/")[0] : "";
  function areaQui() {
    var q = location.search;
    if (/^\/auth\//.test(location.pathname)) return "";
    if (file === "mam-1907.html" || file === "doppioni-1907.html" || file === "cartelle-1907.html" || (file === "mam2.html" && /[?&]ambito=1907/.test(q))) return "1907";
    if (file === "mam2.html" || file === "magazzino.html" || file === "qnap.html") return "mam";
    if (cartella === "guida") return "guida";
    if (cartella === "1. Contratti & HR") return "dipendenti";
    if (file === "turni.html") return "dipendenti";          // sta in live/, ma e' roba della redazione
    if (cartella === "10_Look&Feel" || file === "uefa-club-channel.html") return "grafiche";
    if (cartella === "live") return "live";
    return (file === "index.html" && !cartella) ? "home" : "";
  }
  var AREA = areaQui(), VOCE_ACCESA = "";
  function eQui(indirizzo) {
    if (!indirizzo) return false;
    var p = indirizzo.split("#")[0], f = decodeURIComponent(p.split("?")[0]).split("/").pop().toLowerCase(), d = p.indexOf("?") >= 0 ? p.slice(p.indexOf("?")) : "";
    if (f !== file) return false;
    if (VOCE_ACCESA) return indirizzo === VOCE_ACCESA;
    return !d ? !/[?&](raccolte|live|montaggio|ambito|solo|maglie|k)=/.test(location.search) : location.search.indexOf(d.slice(1)) >= 0;
  }

  var CSS =
    ".ms-bar{position:sticky;top:0;z-index:300;display:flex;align-items:center;gap:6px;min-height:64px;padding:0 clamp(12px,2.4vw,34px);box-sizing:border-box;" +
    "background:rgba(10,15,36,.94);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid rgba(245,241,230,.12);" +
    "overflow-x:auto;scrollbar-width:none;font-family:'Mazzard',system-ui,sans-serif;}" +
    ".ms-bar::-webkit-scrollbar{display:none;}" +
    ".ms-bar[hidden]{display:none!important;}" +
    ".ms-marchio{display:flex;align-items:center;gap:12px;text-decoration:none;padding:8px 14px 8px 0;margin-right:6px;flex:0 0 auto;border-right:1px solid rgba(245,241,230,.12);}" +
    ".ms-marchio img{width:30px;height:auto;display:block;}" +
    ".ms-marchio span{font:700 11px/1 'Mazzard',system-ui,sans-serif;letter-spacing:.28em;text-transform:uppercase;color:#C9A24B;white-space:nowrap;}" +
    ".ms-voce{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;padding:9px 10px;border:1px solid transparent;border-radius:8px;background:transparent;cursor:pointer;" +
    "text-decoration:none;white-space:nowrap;font:700 10px/1 'Mazzard',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#D8D2C2;transition:all .2s ease;}" +
    ".ms-voce:hover{color:#E3C271;border-color:rgba(201,162,75,.3);background:rgba(201,162,75,.08);}" +
    ".ms-voce:focus-visible{outline:2px solid #C9A24B;outline-offset:2px;}" +
    ".ms-voce.qui{color:#C9A24B;background:rgba(201,162,75,.12);border-color:rgba(201,162,75,.3);}" +
    ".ms-home{letter-spacing:.24em;padding:10px 16px;}" +
    ".ms-tendina::after{content:'';width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;opacity:.7;transition:transform .15s ease;}" +
    ".ms-tendina[aria-expanded=true]{color:#E3C271;border-color:rgba(201,162,75,.45);background:rgba(201,162,75,.1);}" +
    ".ms-tendina[aria-expanded=true]::after{transform:rotate(180deg);}" +
    ".ms-destra{margin-left:auto;display:flex;align-items:center;gap:8px;flex:0 0 auto;padding-left:10px;}" +
    // la tendina sta fuori dalla barra (che scorre in orizzontale e la taglierebbe)
    ".ms-sotto{position:fixed;z-index:1000;min-width:240px;max-width:calc(100vw - 24px);max-height:calc(100vh - 90px);overflow:auto;box-sizing:border-box;" +
    "padding:8px;background:#141826;border:1px solid rgba(201,162,75,.45);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.55);}" +
    ".ms-sotto[hidden]{display:none;}" +
    ".ms-sotto.largo{width:min(1080px,calc(100vw - 24px));display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:4px 12px;padding:14px;}" +
    ".ms-sotto.largo[hidden]{display:none;}" +
    ".ms-gruppo h6{margin:4px 10px 6px;font:700 9.5px/1 'Mazzard',system-ui,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#C9A24B;}" +
    ".ms-sotto a,.ms-sotto .ms-presto{display:block;padding:9px 10px;border-radius:8px;color:#EDEDEE;text-decoration:none;font:500 13.5px/1.3 'DM Sans',system-ui,sans-serif;}" +
    ".ms-sotto a:hover,.ms-sotto a:focus-visible{background:rgba(201,162,75,.14);color:#E3C271;outline:none;}" +
    ".ms-sotto a.qui{color:#E3C271;background:rgba(201,162,75,.1);}" +
    ".ms-sotto .ms-presto{color:#8A8B96;cursor:default;} .ms-sotto .ms-presto i{font-style:normal;font-size:11px;margin-left:6px;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:1px 7px;}" +
    "@media (max-width:1400px){.ms-marchio span{display:none;}.ms-voce{padding:9px 7px;letter-spacing:.04em;}}";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function link(v) {
    if (!v[0]) return '<span class="ms-presto">' + esc(v[1]) + (v[2] ? "<i>" + esc(v[2]) + "</i>" : "") + "</span>";
    return '<a href="' + esc(PRE + v[0]) + '"' + (eQui(v[0]) ? ' class="qui"' : "") + ">" + esc(v[1]) + "</a>";
  }

  var BARRE = [];
  function disegna(nav) {
    if (!nav || nav.__ms) return; nav.__ms = true;
    if (!document.getElementById("ms-stile")) { var st = document.createElement("style"); st.id = "ms-stile"; st.textContent = CSS; document.head.appendChild(st); }
    nav.classList.add("ms-bar"); nav.setAttribute("aria-label", "Menu Como TV");
    var destra = nav.querySelector(".ms-destra");
    if (!destra) { destra = document.createElement("span"); destra.className = "ms-destra"; }
    if (destra.parentNode) destra.parentNode.removeChild(destra);
    nav.innerHTML = '<a class="ms-marchio" href="' + PRE + 'index.html"><img src="/loghi/como-tv-logo.png" alt=""><span>Como TV</span></a>' +
      '<a class="ms-voce ms-home' + (AREA === "home" ? " qui" : "") + '" href="' + PRE + 'index.html">Home</a>' +
      AREE.map(function (a, i) { return '<button type="button" class="ms-voce ms-tendina' + (AREA === a.k ? " qui" : "") + '" data-ms="' + i + '" aria-expanded="false">' + esc(a.nome) + "</button>"; }).join("");
    nav.appendChild(destra);
    var sotto = AREE.map(function (a, i) {
      var d = document.createElement("div");
      d.className = "ms-sotto" + (a.largo ? " largo" : ""); d.hidden = true; d.dataset.ms = i;
      d.innerHTML = a.gruppi ? a.gruppi.map(function (g) { return '<div class="ms-gruppo"><h6>' + esc(g.nome) + "</h6>" + g.voci.map(link).join("") + "</div>"; }).join("") : a.voci.map(link).join("");
      document.body.appendChild(d); return d;
    });
    var bottoni = [].slice.call(nav.querySelectorAll(".ms-tendina"));
    function chiudi() { bottoni.forEach(function (b, i) { b.setAttribute("aria-expanded", "false"); sotto[i].hidden = true; }); }
    bottoni.forEach(function (b, i) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var era = !sotto[i].hidden; chiudi(); if (era) return;
        var r = b.getBoundingClientRect(), d = sotto[i];
        d.hidden = false; b.setAttribute("aria-expanded", "true");
        d.style.top = Math.round(r.bottom + 6) + "px";
        d.style.left = Math.max(12, Math.min(Math.round(r.left), window.innerWidth - d.offsetWidth - 12)) + "px";
        if (e.detail === 0) { var a = d.querySelector("a"); if (a) a.focus(); }
      });
    });
    sotto.forEach(function (d) { d.addEventListener("click", function (e) { if (e.target.closest("a")) chiudi(); }); });
    document.addEventListener("click", function (e) { if (!e.target.closest || !e.target.closest(".ms-bar, .ms-sotto")) chiudi(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") chiudi(); });
    window.addEventListener("resize", chiudi);
    window.addEventListener("scroll", function (e) { if (!(e.target && e.target.closest && e.target.closest(".ms-sotto"))) chiudi(); }, true);
    BARRE.push({ nav: nav, sotto: sotto });
    // IL CLUB (@comofootball.com) vede solo "MAM e Magazzino Como 1907" e la Guida: le altre
    // tendine spariscono (le pagine le blocca comunque il server)
    fetch("/auth/chi", { cache: "no-store", credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) {
      if (!j || j.ruolo !== "club") return;
      bottoni.forEach(function (x, i) { if (AREE[i].k !== "1907" && AREE[i].k !== "guida") { x.style.display = "none"; sotto[i].remove(); } });
    }).catch(function () {});
    return destra;
  }
  // il MAM cambia vista senza ricaricare: gli si riaccende la voce giusta
  function accendi(area, voce) {
    AREA = area || AREA; VOCE_ACCESA = voce || "";
    BARRE.forEach(function (b) {
      [].forEach.call(b.nav.querySelectorAll(".ms-tendina"), function (x, i) { x.classList.toggle("qui", AREE[i].k === AREA); });
      b.sotto.forEach(function (d) { [].forEach.call(d.querySelectorAll("a"), function (a) { a.classList.toggle("qui", a.getAttribute("href") === PRE + VOCE_ACCESA); }); });
    });
  }
  window.MENU_SITO = { disegna: disegna, accendi: accendi, aree: AREE };
  [].forEach.call(document.querySelectorAll("nav.ms-bar"), disegna);
})();
