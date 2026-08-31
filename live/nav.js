/**
 * ═══════════════════════════════════════════════════════════════════
 *  NAV — il menù unico di tutte le pagine grafiche
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Un solo file, incluso da ogni pagina: così il menù è IDENTICO ovunque
 *  e sta sempre su UNA riga (se non ci sta, scorre in orizzontale invece
 *  di andare a capo). È lo specchio del Catalogo: per aggiungere un
 *  formato al menù di tutte le pagine si tocca solo l'elenco qui sotto.
 *
 *  La pagina corrente si accende da sola (confronto sul nome del file).
 */
(function () {
  "use strict";

  // ordine e formati del menù — specchio del catalogo (classifiche.html)
  var VOCI = [
    ["../index.html",              "Home"],
    ["classifiche.html",           "Catalogo"],
    ["formazioni.html",            "Formazioni"],
    ["formazioni-premium.html",    "Premium"],
    ["risultati.html",             "Risultati"],
    ["classifiche-campionati.html","Classifiche"],
    ["marcatori.html",             "Marcatori"],
    ["statistiche.html",           "Statistiche"],
    ["tabelloni.html",             "Tabelloni"],
    ["focus.html",                 "Focus"],
    ["scheda.html",                "Scheda"],
    ["volti.html",                 "Volti"],
    ["sottopancia.html",           "Sottopancia"],
    ["ticker.html",                "Ticker"],
    ["regia.html",                 "Regia"]
  ];

  var qui = (location.pathname.split("/").pop() || "").toLowerCase();

  // stile autonomo (colori cablati: il menù è identico su ogni pagina, non
  // eredita variabili che potrebbero cambiare da una pagina all'altra)
  var CSS =
    ".cnav{position:sticky;top:0;z-index:300;display:flex;align-items:stretch;gap:8px;" +
    "  padding:8px clamp(12px,2.2vw,28px);background:rgba(10,15,36,.82);" +
    "  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);" +
    "  border-bottom:1px solid rgba(245,241,230,.14);" +
    "  flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none;}" +
    ".cnav::-webkit-scrollbar{height:0;display:none;}" +
    ".cnav a{flex:1 0 auto;text-align:center;white-space:nowrap;" +
    "  font-family:'Mazzard',system-ui,sans-serif;font-size:10px;font-weight:700;letter-spacing:.2em;" +
    "  text-transform:uppercase;color:#D8D2C2;text-decoration:none;" +
    "  padding:8px 13px;border:1px solid rgba(245,241,230,.14);border-radius:5px;" +
    "  transition:color .12s,border-color .12s,background .12s;}" +
    ".cnav a:hover{color:#E3C271;border-color:rgba(201,162,75,.5);}" +
    ".cnav a.qui{color:#E3C271;border-color:rgba(201,162,75,.5);background:rgba(201,162,75,.1);}";

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function monta() {
    if (document.getElementById("cnav-stile") == null) {
      var st = document.createElement("style");
      st.id = "cnav-stile";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var nav = document.createElement("nav");
    nav.className = "cnav";
    nav.innerHTML = VOCI.map(function (v) {
      var file = v[0].split("/").pop().toLowerCase();
      var attivo = (file && file === qui) ? ' class="qui"' : "";
      return '<a href="' + esc(v[0]) + '"' + attivo + '>' + esc(v[1]) + '</a>';
    }).join("");
    if (document.body.firstChild) document.body.insertBefore(nav, document.body.firstChild);
    else document.body.appendChild(nav);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", monta);
  else monta();
})();
