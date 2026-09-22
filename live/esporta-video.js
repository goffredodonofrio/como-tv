/**
 * ESPORTA VIDEO — il tasto che trasforma una grafica in un file video.
 *
 * Lo stesso servizio di Talent Hunters (13_Server_VM/esporta): la VM apre
 * il motore della grafica in un Chrome senza schermo con un orologio finto
 * e la registra fotogramma per fotogramma, senza perderne uno. Qui c'e' solo
 * il tasto, uguale per tutti gli editor che lo usano: risultati, classifiche,
 * tabelloni.
 *
 * Il video e' esattamente l'anteprima: i dati li prepara la stessa funzione
 * che l'editor usa per l'anteprima. Il tasto compare solo se il servizio
 * risponde (su GitHub, o dove non e' installato, non si vede). Non va usato
 * durante una diretta: pesa sulla macchina delle grafiche per circa un minuto.
 *
 * Uso:
 *   EsportaVideo.tasto({
 *     dopo: document.getElementById("btnPrevG"),   // accanto a quale tasto
 *     motore: "risultati-vmix.html",                // o una funzione
 *     dati: function () { return { d: {...}, nome: "..." }; },   // o { err: "..." }
 *     messaggio: function (tipo, html) { ... }      // tipo: "", "ok", "err"
 *   });
 */
window.EsportaVideo = (function () {
  "use strict";

  // il servizio sta sullo stesso dominio: /como-tv-dev/esporta/ in dev,
  // /esporta/ in prod
  function base() {
    return location.pathname.indexOf("/como-tv-dev/") === 0 ? "/como-tv-dev/esporta/" : "/esporta/";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 25 o 50 fotogrammi al secondo: quelli della sequenza di Premiere. La
  // scelta vale per tutti i tasti Esporta (anche Talent Hunters) e si ricorda.
  var CHIAVE_FPS = "comotv.esporta.fps";
  function fpsScelto() {
    try { return localStorage.getItem(CHIAVE_FPS) === "50" ? 50 : 25; } catch (e) { return 25; }
  }
  function tastoFps(dopo, classe) {
    var f = document.createElement("button");
    f.type = "button"; f.hidden = true; f.className = classe || "";
    f.style.whiteSpace = "nowrap";
    function scrivi() { f.textContent = fpsScelto() + " fps"; }
    f.title = "Fotogrammi al secondo del video: 25 o 50, come la sequenza di Premiere. Clicca per cambiare.";
    f.addEventListener("click", function () {
      try { localStorage.setItem(CHIAVE_FPS, fpsScelto() === 50 ? "25" : "50"); } catch (e) {}
      scrivi();
    });
    scrivi();
    dopo.parentNode.insertBefore(f, dopo.nextSibling);
    return f;
  }

  function tasto(opz) {
    if (!opz || !opz.dopo || !window.fetch) return null;
    var B = base();
    var dire = opz.messaggio || function () {};
    var b = document.createElement("button");
    b.type = "button"; b.hidden = true; b.className = opz.classe || "";
    b.style.whiteSpace = "nowrap";
    b.innerHTML = "&#11015; Esporta video";
    b.title = "Video per la post-produzione: la stessa grafica dell'anteprima, con davanti la wipe Como TV " +
              "(MOV trasparente, si mette sopra il pezzo prima). " +
              "Non durante una diretta: pesa sulla macchina delle grafiche.";
    opz.dopo.parentNode.insertBefore(b, opz.dopo.nextSibling);
    var f = tastoFps(b, opz.classe);
    fetch(B + "salute", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { b.hidden = false; f.hidden = false; } })
      .catch(function () {});

    function scarica(id) {
      var a = document.createElement("a");
      a.href = B + "file?id=" + encodeURIComponent(id);
      a.download = ""; document.body.appendChild(a); a.click(); a.remove();
    }
    function segui(id) {
      fetch(B + "stato?id=" + encodeURIComponent(id), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          if (!s.ok) throw new Error(s.errore || "esportazione persa");
          if (s.stato === "coda") {
            dire("", "In fila per l'esportazione" + (s.posto > 1 ? ": " + s.posto + "ª" : "") + "…");
          } else if (s.stato === "lavoro") {
            dire("", "Preparo il video… " + String(s.secondi).replace(".", ",") +
                     ' s pronti <span style="opacity:.6">· non durante una diretta</span>');
          } else if (s.stato === "pronto") {
            b.disabled = false;
            scarica(id);
            dire("ok", "Video pronto: <b>" + esc(s.nome) + '</b> &middot; <a href="' + B + "file?id=" +
                       encodeURIComponent(id) + '" download>scaricalo di nuovo</a> (resta disponibile due ore)');
            return;
          } else {
            throw new Error(s.errore || "esportazione non riuscita");
          }
          setTimeout(function () { segui(id); }, 1000);
        })
        .catch(function (e) { b.disabled = false; dire("err", "Video non esportato: " + esc(e.message)); });
    }
    b.addEventListener("click", function () {
      var x = opz.dati ? opz.dati() : null;
      if (!x || x.err || !x.d) {
        dire("err", (x && x.err) || "Prima prepara la grafica: il video e' quello dell'anteprima.");
        return;
      }
      var motore = typeof opz.motore === "function" ? opz.motore() : opz.motore;
      b.disabled = true;
      dire("", "Mando la grafica all'esportazione…");
      fetch(B + "avvia", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motore: motore, d: x.d, nome: x.nome || "", fps: fpsScelto() })
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.errore || "non partita");
          segui(res.id);
        })
        .catch(function (e) { b.disabled = false; dire("err", "Video non esportato: " + esc(e.message)); });
    });
    return b;
  }

  return { tasto: tasto, tastoFps: tastoFps, fps: fpsScelto };
})();
