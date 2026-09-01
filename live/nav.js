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

  // <script src="nav.js" data-senza-menu></script> monta SOLO l'orologio:
  // per le pagine di lavoro della regia, dove il menu' non serve.
  var SOLO_ORA = !!(document.currentScript && document.currentScript.dataset &&
                    document.currentScript.dataset.senzaMenu != null);

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
    ["dichiarazioni.html",         "Dichiarazioni"],
    ["scheda.html",                "Scheda"],
    ["volti.html",                 "Volti"],
    ["sottopancia.html",           "Sottopancia"],
    ["ticker.html",                "Ticker"],
    ["magazzino.html",             "Magazzino"],
    ["regia.html",                 "Regia"]
  ];

  var qui = (location.pathname.split("/").pop() || "").toLowerCase();
  // le pagine "figlie" accendono comunque la voce del loro capofila
  var FIGLIE = { "magazzino-foto.html": "magazzino.html", "video.html": "magazzino.html",
                 "classifiche-campionati.html": "classifiche-campionati.html" };
  if (FIGLIE[qui]) qui = FIGLIE[qui];

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
    if (SOLO_ORA) { montaOrologio(); return; }
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
    montaOrologio();
  }

  // orologio in alto a destra della testata: ora ITALIANA (Europe/Rome),
  // HH:MM:SS, su ogni pagina. Se la pagina ha la testata <header class="page">
  // ci si ancora dentro (a destra); altrimenti resta fisso in alto a destra.
  function montaOrologio() {
    if (document.getElementById("cnav-ora")) return;
    var stile = document.createElement("style");
    stile.textContent =
      "#cnav-ora{font-family:'Mazzard',system-ui,sans-serif;font-weight:800;" +
      "  font-size:clamp(40px,5.5vw,66px);line-height:1;letter-spacing:.04em;" +
      "  color:#E3C271;font-variant-numeric:tabular-nums;" +
      "  text-shadow:0 2px 10px rgba(0,0,0,.55);pointer-events:none;z-index:290;}";
    document.head.appendChild(stile);
    var o = document.createElement("div");
    o.id = "cnav-ora";
    var header = document.querySelector("header.page");
    if (header) {
      if (getComputedStyle(header).position === "static") header.style.position = "relative";
      o.style.position = "absolute";
      o.style.transform = "translateY(-50%)";
      o.style.right = "0";
      header.appendChild(o);
      // in linea col TITOLO, non col centro della testata (che comprende
      // anche occhiello e sottotitolo): si misura l'h1 e ci si allinea.
      var titolo = header.querySelector("h1");
      var allinea = function () {
        o.style.top = titolo ? (titolo.offsetTop + titolo.offsetHeight / 2) + "px" : "50%";
      };
      allinea();
      window.addEventListener("resize", allinea);
      // i caratteri Mazzard arrivano dopo e cambiano l'altezza del titolo
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(allinea);
      setTimeout(allinea, 600);
    } else {
      o.style.position = "fixed";
      o.style.top = "58px";      // sotto il menù
      o.style.right = "22px";
      document.body.appendChild(o);
    }
    function tic() {
      var t;
      try {
        t = new Date().toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour12: false,
          hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch (e) {
        var d = new Date();
        function due(n) { return (n < 10 ? "0" : "") + n; }
        t = due(d.getHours()) + ":" + due(d.getMinutes()) + ":" + due(d.getSeconds());
      }
      o.textContent = t;
    }
    tic();
    setInterval(tic, 1000);
  }

  // ── segnale d'ambiente ──────────────────────────────────────────────
  // Dev e produzione sono identiche a vedersi e si distinguono solo dal
  // "-dev" nell'indirizzo: e' bastato per perderci progetti e foto,
  // creati di qua e cercati di la'. In dev lo si vede a colpo d'occhio;
  // in produzione non compare nulla.
  function segnalaDev() {
    if (location.pathname.indexOf("/como-tv-dev/") < 0) return;
    if (document.getElementById("cnav-dev")) return;
    var st = document.createElement("style");
    st.textContent =
      "#cnav-dev-riga{position:fixed;left:0;right:0;top:0;height:4px;z-index:9998;" +
      "  background:repeating-linear-gradient(90deg,#FF7A1A 0 22px,#0A0F24 22px 44px);pointer-events:none;}" +
      "#cnav-dev{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:9999;" +
      "  font-family:'Mazzard',system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:.2em;" +
      "  text-transform:uppercase;color:#0A0F24;background:#FF7A1A;padding:5px 16px 4px;" +
      "  border-radius:0 0 8px 8px;box-shadow:0 3px 12px rgba(0,0,0,.5);pointer-events:none;}";
    document.head.appendChild(st);
    var riga = document.createElement("div"); riga.id = "cnav-dev-riga";
    var b = document.createElement("div"); b.id = "cnav-dev";
    b.textContent = "DEV · ambiente di prova";
    document.body.appendChild(riga);
    document.body.appendChild(b);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ monta(); segnalaDev(); });
  else { monta(); segnalaDev(); }
})();
