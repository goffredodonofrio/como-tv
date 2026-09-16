/**
 * TALENT HUNTERS — la base dei due grafici trasparenti, torta e radar.
 *
 * Nei video sono due ProRes con l'alfa, da mettere sopra le immagini: qui
 * il fondo della pagina e' trasparente come gli altri motori con alpha.
 * Vestiti come le altre grafiche di casa: anelli avorio sottili, etichette
 * Mazzard, oro per il giocatore.
 * Il cerchio sta a sinistra come nei video, un po' piu' al centro (le
 * etichette in Mazzard sono piu' larghe), centro (600, 540); la scala va
 * da 0 a 100 con un anello ogni 20.
 */
window.THGrafico = (function () {
  "use strict";
  var CX = 600, CY = 540, K = 3.23;          // raggio per punto di scala
  var el = TH.el;

  function r(v) { return Math.max(0, Math.min(100, +v || 0)) * K; }
  function punto(ang, rad) { var a = ang * Math.PI / 180; return [CX + Math.cos(a) * rad, CY + Math.sin(a) * rad]; }

  // le etichette lunghe vanno su due righe, spezzate allo spazio piu' centrale
  function righe(t, soglia) {
    t = String(t == null ? "" : t).trim();
    if (t.indexOf("\n") >= 0) return t.split("\n").slice(0, 2);
    if (t.length <= (soglia || 11) || t.indexOf(" ") < 0) return [t];
    var meta = t.length / 2, best = -1;
    for (var i = 0; i < t.length; i++) if (t[i] === " " && (best < 0 || Math.abs(i - meta) < Math.abs(best - meta))) best = i;
    return [t.slice(0, best), t.slice(best + 1)];
  }

  // gli anelli, i numeri della scala e (se servono) i raggi
  function scala(svg, o) {
    var g = el("g", {}, svg);
    var anelli = [];
    [[20, 1.5, 0.22], [40, 1.5, 0.22], [60, 2, 0.28], [80, 2, 0.32], [100, 3, 0.6]].forEach(function (a) {
      anelli.push(el("circle", { cx: CX, cy: CY, r: r(a[0]), fill: "none", stroke: TH.C.avorio, "stroke-opacity": a[2], "stroke-width": a[1],
                                 transform: "rotate(-90 " + CX + " " + CY + ")" }, g));
    });
    var numeri = el("g", {}, svg);
    [0, 20, 40, 60, 80].forEach(function (v) {
      TH.testo(numeri, CX, v ? CY - r(v) - 8 : CY - 6, String(v),
               { anchor: "middle", font: "DM Sans", peso: 500, size: 17, fill: TH.C.oro });
    });
    return { g: g, anelli: anelli, numeri: numeri };
  }

  function etichette(svg, nomi, angoli, raggio, soglia, corpo) {
    corpo = corpo || 42;
    var g = el("g", {}, svg), tutte = [];
    nomi.forEach(function (nome, i) {
      var a = angoli[i] * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
      var p = [CX + cs * raggio, CY + sn * raggio];
      var anc = cs > 0.25 ? "start" : cs < -0.25 ? "end" : "middle";
      var rr = righe(nome, soglia), alt = Math.round(corpo * 0.95);
      // sopra il cerchio le righe salgono, sotto scendono, ai lati stanno a meta'
      var y0 = p[1] + (sn < -0.5 ? -(rr.length - 1) * alt : sn > 0.95 ? corpo * 0.5 : sn > 0.5 ? -corpo * 0.1 : corpo * 0.33 - (rr.length - 1) * alt / 2);
      var e = el("g", {}, g);
      rr.forEach(function (riga, k) {
        TH.testo(e, p[0], y0 + k * alt, TH.maiuscolo(riga), { anchor: anc, peso: 700, size: corpo, fill: TH.C.avorio, ls: corpo * 0.06 });
      });
      tutte.push(e);
    });
    return tutte;
  }

  function fonte(svg, testo, x, y, colore) {
    if (testo === "") return null;
    return TH.testo(svg, x, y, TH.maiuscolo(testo || "fonte DataMB"), { font: "DM Sans", peso: 500, size: 17, fill: colore || TH.C.avorioSpento, ls: 3 });
  }

  // entrata comune: gli anelli si disegnano, poi numeri ed etichette
  function entraScala(sc, eti) {
    if (TH.STILL) return;
    sc.anelli.forEach(function (c, i) { TH.traccia(c, 0.7, 0.05 + i * 0.07); });
    TH.anima(sc.numeri, [{ opacity: 0 }, { opacity: 1 }], 0.4, 0.55, "ease-out");
    eti.forEach(function (e, i) { TH.anima(e, [{ opacity: 0 }, { opacity: 1 }], 0.35, 0.7 + i * 0.05, "ease-out"); });
  }

  // un valore che cresce nel tempo, con la sua curva; chiama fn(v) a ogni fotogramma
  function cresci(da, a, inizio, durata, fn) {
    if (TH.STILL) { fn(a); return; }
    var t0 = null;
    fn(da);
    function passo(ora) {
      if (t0 === null) t0 = ora;
      var u = ((ora - t0) / 1000 - inizio) / durata;
      if (u < 0) { requestAnimationFrame(passo); return; }
      u = Math.min(1, u);
      var e = 1 - Math.pow(1 - u, 3);
      fn(da + (a - da) * e);
      if (u < 1) requestAnimationFrame(passo);
    }
    requestAnimationFrame(passo);
    // rete di sicurezza: se i fotogrammi non girano, il valore arriva lo stesso
    setTimeout(function () { fn(a); }, (inizio + durata) * 1000 + 400);
  }

  return { CX: CX, CY: CY, r: r, punto: punto, scala: scala, etichette: etichette,
           fonte: fonte, entraScala: entraScala, cresci: cresci };
})();
