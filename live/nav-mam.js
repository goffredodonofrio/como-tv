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
    ["magazzino", "magazzino.html", "Magazzino"]
  ];
  function quale() {
    var f = (location.pathname.split("/").pop() || "").toLowerCase(), q = location.search;
    if (f === "magazzino.html" || f === "magazzino-foto.html" || f === "video.html") return "magazzino";
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
  var st = document.createElement("style");
  st.id = "nav-mam-stile";
  st.textContent = CSS;
  document.head.appendChild(st);

  var nav = document.createElement("nav");
  nav.className = "sito";
  nav.id = "sitoNav";
  nav.setAttribute("aria-label", "MAM Como TV");
  nav.innerHTML = '<a class="sito-marchio" href="../index.html"><img src="/loghi/como-tv-logo.png" alt=""><span>Como TV</span></a>' +
    VOCI.map(function (v) { return '<a class="sito-voce" data-voce="' + v[0] + '" href="' + v[1] + '">' + v[2] + '</a>'; }).join("") +
    '<span class="sito-destra" id="sitoDestra"></span>';
  var s = document.currentScript;
  if (s && s.parentNode) s.parentNode.insertBefore(nav, s); else document.body.insertBefore(nav, document.body.firstChild);

  function accendi(nome) {
    Array.prototype.forEach.call(nav.querySelectorAll(".sito-voce"), function (a) {
      a.classList.toggle("qui", a.getAttribute("data-voce") === nome);
    });
  }
  accendi(quale());
  window.NAV_MAM = { accendi: accendi, destra: document.getElementById("sitoDestra") };
})();
