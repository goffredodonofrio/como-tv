/**
 * ═══════════════════════════════════════════════════════════════════
 *  AVVIO — da che punto dell'animazione parte una grafica
 * ═══════════════════════════════════════════════════════════════════
 *
 *  La regia sceglie col cursore, sotto l'Anteprima, da dove deve partire
 *  una grafica quando va in onda: dall'inizio, a meta' dell'ingresso, o
 *  gia' composta. Il punto viaggia nei dati della voce come "_da" (secondi)
 *  e il playout ne tiene conto al TAKE.
 *
 *  I motori non sanno niente di tutto questo, e non devono. Quasi tutti si
 *  animano con animazioni CSS: il browser le espone con getAnimations(), e
 *  chi sta sulla pagina che li ospita — stessa origine — puo' fermarle,
 *  spostarle e farle ripartire da fuori. Cosi' vale per tutte le grafiche
 *  insieme, invece che motore per motore.
 *
 *  Cosa NON copre, e va saputo: le parti mosse a mano da un timer
 *  (setTimeout, requestAnimationFrame) non sono animazioni del browser.
 *  Quelle partono comunque dal loro tempo — la grafica non si rompe, fa solo
 *  quel pezzo come farebbe senza punto di partenza.
 *
 *  Le animazioni infinite (la polvere d'oro, gli aloni, i crawl) restano
 *  fuori da tutto: non hanno una fine, non contano per la durata e non si
 *  fermano quando si scorre.
 */
window.AvvioGrafica = (function () {
  "use strict";

  function animazioni(doc) {
    if (!doc || typeof doc.getAnimations !== "function") return [];
    var tutte;
    try { tutte = doc.getAnimations(); } catch (e) { return []; }
    return tutte.filter(function (a) {
      try {
        var fine = a.effect && a.effect.getComputedTiming().endTime;
        return isFinite(fine);
      } catch (e) { return false; }
    });
  }
  function fineDi(a) {
    try { return a.effect.getComputedTiming().endTime || 0; } catch (e) { return 0; }
  }

  // quanto dura l'animazione della grafica, in secondi: la fine dell'ultima
  function durata(doc) {
    var ms = 0;
    animazioni(doc).forEach(function (a) { ms = Math.max(ms, fineDi(a)); });
    return ms / 1000;
  }

  // ferma tutto al secondo t: e' quello che si vede trascinando il cursore
  function ferma(doc, t) {
    var ms = Math.max(0, t || 0) * 1000;
    animazioni(doc).forEach(function (a) {
      try { a.pause(); a.currentTime = Math.min(ms, fineDi(a)); } catch (e) {}
    });
  }

  // fa ripartire tutto dal secondo t: e' il tasto play dell'anteprima
  function riparti(doc, t) {
    var ms = Math.max(0, t || 0) * 1000;
    animazioni(doc).forEach(function (a) {
      try { a.currentTime = Math.min(ms, fineDi(a)); a.play(); } catch (e) {}
    });
  }

  // In onda: tutta la grafica avanti di t secondi, mentre gira. Ogni
  // animazione si sposta una volta sola; si ripassa qualche volta nei primi
  // istanti perche' certi motori creano pezzi dopo il caricamento (quando
  // arriva un'immagine, quando scatta un timer) e anche quelli vanno avanti.
  function parti(doc, t, win) {
    var ms = Math.max(0, t || 0) * 1000;
    if (!ms || !doc) return;
    var visti = (typeof WeakSet === "function") ? new WeakSet() : null;
    function passa() {
      animazioni(doc).forEach(function (a) {
        if (visti) { if (visti.has(a)) return; visti.add(a); }
        try { a.currentTime = Math.min((a.currentTime || 0) + ms, fineDi(a)); } catch (e) {}
      });
    }
    passa();
    if (!visti) return;            // senza memoria un secondo giro sposterebbe due volte
    var w = win || window;
    [80, 250, 700, 1500].forEach(function (dopo) {
      try { w.setTimeout(passa, dopo); } catch (e) { setTimeout(passa, dopo); }
    });
  }

  return { durata: durata, ferma: ferma, riparti: riparti, parti: parti,
           funziona: function (doc) { return !!(doc && typeof doc.getAnimations === "function"); } };
})();
