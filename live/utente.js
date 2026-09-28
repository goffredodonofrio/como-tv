/**
 * UTENTE — nella barra di ogni pagina: chi e' entrato (accesso con Google),
 * il Registro di controllo per il super utente, ed Esci. (Goffredo, 27/09/2026)
 * Chiede /auth/chi: se non c'e' sessione mette "Accedi". Le pagine -vmix (in
 * onda) non lo caricano. Si include da nav.js, nav-mam.js e dalla home.
 */
(function () {
  "use strict";
  if (window.__UTENTE || /-vmix\.html$/i.test(location.pathname)) return;
  window.__UTENTE = 1;
  var CSS =
    ".utente-nav{flex:0 0 auto;margin-left:10px;position:relative;display:flex;align-items:center;}" +
    ".utente-nav.solo{margin-left:auto;}" +
    ".un-chi{display:inline-flex;align-items:center;gap:8px;background:transparent;border:1px solid rgba(201,162,75,.35);border-radius:9px;padding:6px 10px 6px 6px;" +
    "cursor:pointer;color:#E3C271;font:700 10.5px/1 'Mazzard',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;}" +
    ".un-chi:hover,.un-chi[aria-expanded=true]{border-color:#C9A24B;background:rgba(201,162,75,.1);}" +
    ".un-chi i{font-style:normal;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:#C9A24B;color:#10131c;font-size:10px;letter-spacing:0;}" +
    ".un-menu{position:fixed;z-index:1000;min-width:240px;background:#141826;border:1px solid rgba(201,162,75,.45);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.55);padding:8px;" +
    "display:flex;flex-direction:column;gap:2px;font:500 13px/1.4 'DM Sans',system-ui,sans-serif;}" +
    ".un-menu[hidden]{display:none;}" +
    ".un-menu .un-mail{padding:8px 10px 10px;color:#9A9CA4;font-size:12px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:4px;word-break:break-all;}" +
    ".un-menu .un-mail b{display:block;color:#EDEDEE;font-size:13px;}" +
    ".un-menu a{display:block;padding:9px 10px;border-radius:8px;color:#EDEDEE;text-decoration:none;}" +
    ".un-menu a:hover,.un-menu a:focus-visible{background:rgba(201,162,75,.14);outline:none;}" +
    ".un-menu a.esci{color:#FF9A9C;}" +
    ".un-entra{border:1px solid rgba(201,162,75,.35);border-radius:9px;padding:8px 12px;color:#E3C271;text-decoration:none;font:700 10.5px/1 'Mazzard',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;}";

  function esc(s) { return String(s || "").replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function iniziali(email) { var p = email.split("@")[0].split(/[._-]+/); return ((p[0] || "")[0] + ((p[1] || "")[0] || "")).toUpperCase(); }

  var tentativi = 0;
  function monta(j) {
    // nel menu' unico (menu-sito.js) il posto e' l'angolo destro della barra: si
    // aspetta che la barra sia disegnata (nav.js la monta a pagina pronta, e il
    // disegno riscrive la barra: un nome messo prima sparirebbe)
    var ms = document.querySelector("nav.ms-bar");
    if ((!ms || !ms.querySelector(".ms-marchio")) && tentativi < 40) { tentativi++; setTimeout(function () { monta(j); }, 150); return; }
    var barra = (ms && ms.querySelector(".ms-destra")) || document.querySelector(".nav-content") || document.querySelector(".sito") || document.querySelector("nav");
    if (!barra) return;
    if (barra.querySelector(".utente-nav")) return;
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    var box = document.createElement("div"); box.className = "utente-nav";
    if (!j || !j.email) {
      var torna = location.pathname + location.search + location.hash;
      box.innerHTML = '<a class="un-entra" href="/auth/entra?torna=' + encodeURIComponent(torna) + '">Accedi</a>';
    } else {
      var nome = j.email.split("@")[0].replace(/[._]+/g, " ");
      box.innerHTML = '<button type="button" class="un-chi" aria-haspopup="true" aria-expanded="false" title="' + esc(j.email) + '"><i>' + esc(iniziali(j.email)) + "</i>" + esc(nome) + "</button>" +
        '<div class="un-menu" role="menu" hidden><div class="un-mail"><b>' + esc(nome) + "</b>" + esc(j.email) + (j.admin ? " · super utente" : "") + "</div>" +
        (j.admin ? '<a role="menuitem" href="/auth/registro">Registro di controllo</a><a role="menuitem" href="/como-tv/area-personale.html">Area personale</a>' : "") +
        '<a role="menuitem" class="esci" href="/auth/esci">Esci</a></div>';
      var b = box.querySelector(".un-chi"), m = box.querySelector(".un-menu");
      // la tendina sta fuori dalla barra: la barra (sfocata e scorrevole) la taglierebbe
      document.body.appendChild(m);
      var chiudi = function () { m.hidden = true; b.setAttribute("aria-expanded", "false"); };
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!m.hidden) return chiudi();
        var r = b.getBoundingClientRect();
        m.style.top = (r.bottom + 6) + "px"; m.style.right = Math.max(8, window.innerWidth - r.right) + "px";
        m.hidden = false; b.setAttribute("aria-expanded", "true");
      });
      document.addEventListener("click", function (e) { if (!box.contains(e.target) && !m.contains(e.target)) chiudi(); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") chiudi(); });
      window.addEventListener("scroll", chiudi, true);
    }
    // dopo "Area personale" se c'e' (che ha gia' margin-left:auto), se no in fondo a destra
    var mia = barra.querySelector(".nav-mia");
    if (barra.classList.contains("ms-destra")) barra.appendChild(box);
    else if (mia) mia.insertAdjacentElement("afterend", box); else { box.classList.add("solo"); barra.appendChild(box); }
  }
  // il lucchetto "Area personale" della home e' solo del super utente
  function areaPersonale(j) {
    var a = document.querySelector(".area-personale"); if (a && !(j && j.admin)) a.style.display = "none";
    // il club (@comofootball.com): in home solo i blocchi "Guida" e "MAM e Magazzino Como 1907"
    if (j && j.ruolo === "club") [].forEach.call(document.querySelectorAll(".hub-blocco"), function (b) {
      var t = b.querySelector(".hub-titolo"); if (!t || !/1907|^\s*Guida\s*$/.test(t.textContent)) b.style.display = "none";
    });
    return j;
  }
  fetch("/auth/chi", { cache: "no-store", credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : {}; }).then(areaPersonale).then(monta).catch(function () {});
})();
