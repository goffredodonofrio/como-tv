/**
 * ═══════════════════════════════════════════════════════════════════
 *  NAV — il menù unico di tutte le pagine grafiche
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Un solo file, incluso da ogni pagina: così il menù è IDENTICO ovunque
 *  e sta sempre su UNA riga. È lo specchio del Catalogo: per aggiungere un
 *  formato al menù di tutte le pagine si tocca solo l'elenco qui sotto.
 *
 *  I formati stanno dentro quattro tendine, con gli stessi gruppi del
 *  Catalogo. Prima erano ventuno voci in fila: la barra scorreva, e le
 *  ultime — Magazzino e Regia, cioè quelle che si usano di più — finivano
 *  fuori schermo. Restano fuori dalle tendine solo Home, Catalogo,
 *  Magazzino e Regia: si aprono cento volte al giorno e un clic in più
 *  ogni volta è un clic sprecato.
 *
 *  La pagina corrente si accende da sola, e con lei la tendina che la
 *  contiene (confronto sul nome del file).
 */
(function () {
  "use strict";

  // <script src="nav.js" data-senza-menu></script> monta SOLO l'orologio:
  // per le pagine di lavoro della regia, dove il menu' non serve.
  var SOLO_ORA = !!(document.currentScript && document.currentScript.dataset &&
                    document.currentScript.dataset.senzaMenu != null);

  // ordine e gruppi del menù — specchio del catalogo (classifiche.html).
  // Una coppia [indirizzo, nome] è una voce sola; un oggetto è una tendina.
  var VOCI = [
    ["../index.html",              "Home"],
    ["classifiche.html",           "Catalogo"],
    { nome: "Partita", voci: [
      ["formazioni-premium.html",    "Formazioni Premium"],
      ["formazioni.html",            "Formazioni"],
      ["cambi.html",                 "Cambi"],
      ["risultati.html",             "Risultati"],
      ["classifiche-campionati.html","Classifiche"],
      ["marcatori.html",             "Marcatori"],
      ["tiri.html",                  "Mappa dei tiri"],
      ["passaggi.html",              "Mappa dei passaggi"]
    ]},
    { nome: "Editoriali", voci: [
      ["statistiche.html",           "Statistiche"],
      ["scheda.html",                "Scheda"],
      ["focus.html",                 "Focus"],
      ["dichiarazioni.html",         "Dichiarazioni"],
      ["volti.html",                 "Volti"]
    ]},
    { nome: "Tabelloni", voci: [
      ["tabelloni.html",             "Tabelloni e gironi"],
      ["appuntamenti.html",          "Prossimi appuntamenti"]
    ]},
    { nome: "Crawl", voci: [
      ["ticker.html",                "Ticker"],
      ["sottopancia.html",           "Sottopancia"],
      ["contributi.html",            "Contributi video"]
    ]},
    ["magazzino.html",             "Magazzino"],
    ["regia.html",                 "Regia"]
  ];

  var qui = (location.pathname.split("/").pop() || "").toLowerCase();
  // le pagine "figlie" accendono comunque la voce del loro capofila
  var FIGLIE = { "magazzino-foto.html": "magazzino.html", "video.html": "magazzino.html",
                 "barra.html": "ticker.html",
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
    ".cnav a.qui{color:#E3C271;border-color:rgba(201,162,75,.5);background:rgba(201,162,75,.1);}" +
    // il tasto di una tendina e' fatto come una voce, cosi' la barra resta una
    ".cnav button{flex:1 0 auto;white-space:nowrap;cursor:pointer;" +
    "  font-family:'Mazzard',system-ui,sans-serif;font-size:10px;font-weight:700;letter-spacing:.2em;" +
    "  text-transform:uppercase;color:#D8D2C2;background:transparent;" +
    "  padding:8px 13px;border:1px solid rgba(245,241,230,.14);border-radius:5px;" +
    "  transition:color .12s,border-color .12s,background .12s;}" +
    ".cnav button:hover{color:#E3C271;border-color:rgba(201,162,75,.5);}" +
    ".cnav button.qui{color:#E3C271;border-color:rgba(201,162,75,.5);background:rgba(201,162,75,.1);}" +
    ".cnav button i{font-style:normal;margin-left:8px;opacity:.6;font-size:8px;" +
    "  display:inline-block;transition:transform .14s;}" +
    ".cnav button.aperto i{transform:rotate(180deg);}" +
    // La tendina e' FISSA e non figlia della barra: la barra ha overflow-x
    // per non andare mai a capo, e un overflow ritaglia anche in verticale —
    // una tendina figlia verrebbe tagliata a filo della barra e non si
    // vedrebbe niente. Cosi' invece la posizione la calcola il codice.
    ".cnav-giu{position:fixed;z-index:400;display:none;flex-direction:column;gap:4px;" +
    "  min-width:210px;padding:6px;border-radius:8px;background:rgba(10,15,36,.98);" +
    "  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);" +
    "  border:1px solid rgba(245,241,230,.16);box-shadow:0 16px 38px rgba(0,0,0,.55);}" +
    ".cnav-giu.aperto{display:flex;}" +
    ".cnav-giu a{display:block;text-align:left;white-space:nowrap;" +
    "  font-family:'Mazzard',system-ui,sans-serif;font-size:10px;font-weight:700;letter-spacing:.2em;" +
    "  text-transform:uppercase;color:#D8D2C2;text-decoration:none;" +
    "  padding:9px 12px;border:1px solid transparent;border-radius:5px;}" +
    ".cnav-giu a:hover{color:#E3C271;background:rgba(201,162,75,.12);}" +
    ".cnav-giu a.qui{color:#E3C271;border-color:rgba(201,162,75,.5);background:rgba(201,162,75,.1);}";

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

    function nomeFile(indirizzo) { return indirizzo.split("/").pop().toLowerCase(); }
    function collegamento(v) {
      var attivo = (nomeFile(v[0]) === qui) ? ' class="qui"' : "";
      return '<a href="' + esc(v[0]) + '"' + attivo + '>' + esc(v[1]) + '</a>';
    }

    var tendine = [];                       // le tendine da appendere al body
    nav.innerHTML = VOCI.map(function (v, i) {
      if (!v.voci) return collegamento(v);
      // il tasto si accende se la pagina aperta sta qui dentro: cosi' si vede
      // dove ci si trova senza doverla aprire
      var dentro = v.voci.some(function (u) { return nomeFile(u[0]) === qui; });
      tendine.push({ i: i, voci: v.voci });
      return '<button type="button" data-giu="' + i + '"' + (dentro ? ' class="qui"' : '') + '>' +
             esc(v.nome) + '<i>&#9660;</i></button>';
    }).join("");

    if (document.body.firstChild) document.body.insertBefore(nav, document.body.firstChild);
    else document.body.appendChild(nav);

    tendine.forEach(function (t) {
      var d = document.createElement("div");
      d.className = "cnav-giu";
      d.dataset.giu = t.i;
      d.innerHTML = t.voci.map(collegamento).join("");
      document.body.appendChild(d);
    });

    // Si apre col clic, non col passaggio del mouse: qui si lavora in fretta e
    // una tendina che si apre da sola mentre si punta a un altro tasto e' un
    // modo di aprire la pagina sbagliata in diretta.
    function chiudi() {
      nav.querySelectorAll("button.aperto").forEach(function (b) { b.classList.remove("aperto"); });
      document.querySelectorAll(".cnav-giu.aperto").forEach(function (d) { d.classList.remove("aperto"); });
    }
    nav.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("button[data-giu]") : null;
      if (!b) return;
      var gia = b.classList.contains("aperto");
      chiudi();
      if (gia) return;
      var d = document.querySelector('.cnav-giu[data-giu="' + b.dataset.giu + '"]');
      if (!d) return;
      var r = b.getBoundingClientRect();
      d.style.top = Math.round(r.bottom + 6) + "px";
      d.classList.add("aperto");
      b.classList.add("aperto");
      // se la tendina sborda a destra la si tira dentro: sulle pagine strette
      // finirebbe mezza fuori schermo
      var largo = d.offsetWidth;
      var x = Math.min(Math.round(r.left), window.innerWidth - largo - 12);
      d.style.left = Math.max(12, x) + "px";
    });
    document.addEventListener("click", function (ev) {
      if (!ev.target.closest || !ev.target.closest(".cnav, .cnav-giu")) chiudi();
    });
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") chiudi(); });
    window.addEventListener("resize", chiudi);

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
