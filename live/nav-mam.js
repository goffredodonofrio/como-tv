/**
 * NAV-MAM — la barra delle pagine del MAM (Goffredo, 25/09/2026)
 *
 * La stessa testata della home — stemma, COMO TV — con le porte del
 * MAM: Home, MAM, Raccolte, MAM Live, Editing, Magazzino. Un file solo, incluso dal
 * MAM (tutte le viste) e dal Magazzino, cosi' la barra e' identica ovunque.
 * La voce della pagina aperta si accende da sola; il MAM, che cambia vista
 * senza ricaricare, la riaccende con NAV_MAM.accendi("editing").
 *
 * <script src="nav-mam.js"></script> subito dopo <body>.
 */
(function () {
  "use strict";
  var VOCI = [
    ["home", "../index.html", "Home"],
    ["mam", "mam2.html", "MAM"],
    // le raccolte hanno una pagina loro (Goffredo, 26/09/2026)
    ["raccolte", "mam2.html?raccolte=1", "Raccolte / Macchie"],
    ["live", "mam2.html?live=1", "MAM Live"],
    ["editing", "mam2.html?montaggio=1", "Editing"],
    // il materiale del club (QNAP COMOTV - FRAME), 27/09/2026
    ["1907", "mam-1907.html", "MAM Como 1907"],
    ["magazzino", "magazzino.html", "Magazzino"]
  ];
  function quale() {
    var f = (location.pathname.split("/").pop() || "").toLowerCase(), q = location.search;
    if (f === "magazzino.html" || f === "magazzino-foto.html" || f === "video.html") return "magazzino";
    if (f === "mam-1907.html" || /[?&]ambito=1907/.test(q)) return "1907";
    if (/[?&]live=1/.test(q)) return "live";
    if (/[?&](raccolte=1|rac=)/.test(q)) return "raccolte";
    if (/[?&](montaggio=1|seq=)/.test(q)) return "editing";
    return "mam";
  }
  var CSS =
    ".sito{flex:0 0 auto;min-height:64px;display:flex;align-items:center;gap:8px;padding:0 clamp(16px,3vw,40px);" +
    "background:rgba(10,15,36,.94);border-bottom:1px solid rgba(245,241,230,.1);position:relative;z-index:60;" +
    "overflow-x:auto;scrollbar-width:none;box-sizing:border-box;}" +
    ".sito::-webkit-scrollbar{display:none;}" +
    ".sito[hidden]{display:none !important;}" +
    ".sito-marchio{display:flex;align-items:center;gap:12px;text-decoration:none;padding:8px 18px 8px 0;margin-right:10px;" +
    "border-right:1px solid rgba(245,241,230,.12);flex:0 0 auto;}" +
    ".sito-marchio img{width:32px;height:auto;display:block;}" +
    ".sito-marchio span{font:700 11px/1 'Mazzard',system-ui,sans-serif;letter-spacing:.28em;text-transform:uppercase;color:#C9A24B;white-space:nowrap;}" +
    ".sito-voce{flex:0 0 auto;padding:10px 14px;border:1px solid transparent;border-radius:8px;text-decoration:none;white-space:nowrap;" +
    "font:700 11px/1 'Mazzard',system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#D8D2C2;transition:all .2s ease;}" +
    ".sito-voce:hover{color:#E3C271;border-color:rgba(201,162,75,.3);background:rgba(201,162,75,.08);}" +
    ".sito-voce.qui{color:#C9A24B;background:rgba(201,162,75,.12);border-color:rgba(201,162,75,.3);letter-spacing:.28em;padding:10px 18px;}" +
    ".sito-destra{margin-left:auto;display:flex;align-items:center;gap:8px;flex:0 0 auto;}" +
    "@media (max-width:640px){.sito-marchio span{display:none;}.sito-voce{padding:9px 8px;letter-spacing:.06em;}}";
  // IL MENU' UNICO (27/09/2026): la barra e' quella di tutto il sito (menu-sito.js).
  // Qui si crea subito il suo posto, con #sitoDestra (il MAM ci sposta i suoi tasti
  // appena parte), e la barra si riempie appena arriva menu-sito.js.
  var nav = document.createElement("nav");
  nav.className = "ms-bar"; nav.id = "sitoNav";
  nav.innerHTML = '<span class="ms-destra sito-destra" id="sitoDestra"></span>';
  var s = document.currentScript;
  if (s && s.parentNode) s.parentNode.insertBefore(nav, s); else document.body.insertBefore(nav, document.body.firstChild);
  // le viste del MAM -> la voce del menu'
  var MAPPA = { mam: ["mam", "live/mam2.html"], raccolte: ["mam", "live/mam2.html?raccolte=1"], live: ["mam", "live/mam2.html?live=1"],
                editing: ["mam", "live/mam2.html?montaggio=1"], magazzino: ["mam", "live/magazzino.html"], "1907": ["1907", "live/mam-1907.html"] };
  var voluta = quale();
  function accendi(nome) {
    voluta = nome;
    var m = MAPPA[nome] || MAPPA.mam;
    if (nome === "editing" && /[?&]ambito=1907/.test(location.search)) m = ["1907", "live/mam2.html?montaggio=1&ambito=1907"];
    if (window.MENU_SITO) window.MENU_SITO.accendi(m[0], m[1]);
  }
  window.NAV_MAM = { accendi: accendi, destra: document.getElementById("sitoDestra") };
  var sc = document.createElement("script");
  sc.src = s && s.src ? s.src.replace(/[^\/]*$/, "menu-sito.js") : "menu-sito.js";
  sc.onload = function () { accendi(voluta); };
  document.head.appendChild(sc);
})();

// LA GUIDA DENTRO LE PAGINE (27/09/2026): coach.js monta la linguetta GUIDA e
// accompagna passo passo. Si carica una volta sola, dopo la pagina, e se non
// arriva la pagina resta com'era. Le pagine -vmix (in onda) non la vedono.
(function () {
  try {
    if (window.__COACH_CARICATO || /-vmix\.html$/i.test(location.pathname)) return;
    window.__COACH_CARICATO = 1;
    var qui = document.currentScript && document.currentScript.src;
    var s = document.createElement("script");
    s.src = qui ? qui.replace(/[^\/]*$/, "coach.js") : "coach.js"; s.async = true;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();

// CHI E' ENTRATO (27/09/2026): utente.js mette nella barra la persona, il
// Registro (super utente) ed Esci. Come la guida: si carica una volta sola.
(function () {
  try {
    if (window.__UTENTE_CARICATO || /-vmix\.html$/i.test(location.pathname)) return;
    window.__UTENTE_CARICATO = 1;
    var qui = document.currentScript && document.currentScript.src;
    var s = document.createElement("script");
    s.src = qui ? qui.replace(/[^\/]*$/, "utente.js") : "utente.js"; s.async = true;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();
