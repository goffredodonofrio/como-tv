/**
 * CLUB — Guida e Palestra per chi entra con una mail @comofootball.com: solo la
 * parte sul Como 1907. (Goffredo, 28/09/2026)
 *
 * Lo aggiunge il server (nginx, sub_filter) alle pagine di /guida/, cosi' vale
 * anche quando la guida viene rigenerata. Chiede /auth/chi: se il ruolo e'
 * "club", nella Guida resta solo la scheda "MAM Como 1907" e nella Palestra
 * solo l'area del Como 1907. Per tutti gli altri non fa niente.
 */
(function () {
  "use strict";
  var radice = document.documentElement;
  radice.style.visibility = "hidden";                 // niente lampo delle altre schede
  var mostra = function () { radice.style.visibility = ""; };
  var scadenza = setTimeout(mostra, 2000);
  function soloClub() {
    // la Guida: schede #t-<id>, viste #v-<id>; il Como 1907 e' la scheda "club"
    var schede = document.getElementById("schede");
    if (schede) {
      [].forEach.call(schede.querySelectorAll("[id^='t-']"), function (b) { if (b.id !== "t-club") b.style.display = "none"; });
      [].forEach.call(document.querySelectorAll("section.vista[id^='v-']"), function (v) { if (v.id !== "v-club") v.style.display = "none"; });
      var alClub = function () { if (!/^#club(\/|$)/.test(location.hash)) location.replace("#club"); };
      alClub(); window.addEventListener("hashchange", alClub);
    }
    // la Palestra: un'area per strumento; resta quella del Como 1907
    var aree = function () {
      [].forEach.call(document.querySelectorAll("section.area"), function (a) {
        var t = a.querySelector(".area-testa"); a.style.display = t && /1907/.test(t.textContent) ? "" : "none";
      });
    };
    aree();
    var guarda = new MutationObserver(aree); guarda.observe(document.body, { childList: true, subtree: true });
  }
  fetch("/auth/chi", { cache: "no-store", credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) {
    if (j && j.ruolo === "club") {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { soloClub(); clearTimeout(scadenza); mostra(); });
      else { soloClub(); clearTimeout(scadenza); mostra(); }
    } else { clearTimeout(scadenza); mostra(); }
  }).catch(function () { clearTimeout(scadenza); mostra(); });
})();
