/**
 * ═══════════════════════════════════════════════════════════════════
 *  TALENT HUNTERS — i pezzi comuni delle grafiche in onda
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Le grafiche Talent Hunters nascono come video montati a mano, una
 *  puntata alla volta. Qui diventano motori come gli altri del catalogo:
 *  stessi disegni e stessi tempi dei video, ma coi dati che arrivano da
 *  ?d= invece che scritti nel montaggio.
 *
 *  Il vestito e' quello delle altre grafiche Como TV — campo navy, oro,
 *  Mazzard — perche' in onda stanno una accanto all'altra. Del format
 *  restano i segni che lo fanno riconoscere: la card della foto, la cornice,
 *  la fascia a quadretti del campo in basso, il soprannome a macchina,
 *  l'impronta e il timbro, il campo in prospettiva. Il feltro dei video c'e'
 *  ancora, ma come trama appena percettibile sotto il navy.
 *
 *  Tre grafiche (carta d'identita', approved, heatmap) hanno il fondo pieno;
 *  torta e radar sono trasparenti, da mettere sopra un video.
 */
window.TH = (function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var Q = new URLSearchParams(location.search);
  var STILL = Q.get("still") === "1";
  // i token del design system Como TV Live
  var C = { navy: "#0A0F24", navy85: "#0E1430", navy8: "#141B3C", navy7: "#20284E",
            oro: "#C9A24B", oroChiaro: "#E3C271", oroScuro: "#A67C2E", rosso: "#E51B20",
            avorio: "#F5F1E6", avorioSpento: "#D8D2C2", grigio: "#8A8B96" };
  var CREMA = C.avorio, NERO = C.navy;

  function dati(demo, valido) {
    var q = Q.get("d");
    if (!q) return demo;
    try {
      var d = JSON.parse(decodeURIComponent(escape(atob(q.replace(/-/g, "+").replace(/_/g, "/")))));
      return (!valido || valido(d)) ? d : null;
    } catch (e) { return null; }
  }

  function fit() {
    var st = document.getElementById("stage");
    if (!st) return;
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    st.style.transform = "translate(-50%,-50%) scale(" + s + ")";
  }
  window.addEventListener("resize", fit);

  function el(tag, attr, padre) {
    var e = document.createElementNS(NS, tag);
    for (var k in attr) if (attr[k] != null) e.setAttribute(k, attr[k]);
    if (padre) padre.appendChild(e);
    return e;
  }

  // Testo SVG: il contorno scuro dei video si fa col tratto dietro al
  // riempimento (paint-order), che nel testo HTML i Chromium vecchi di vMix
  // non conoscono. Se il testo e' piu' largo di maxW si stringe il corpo.
  function testo(padre, x, y, str, o) {
    o = o || {};
    var t = el("text", {
      x: x, y: y, "text-anchor": o.anchor || "start",
      "font-family": o.font || "Mazzard", "font-weight": o.peso || 800,
      "font-size": o.size || 46, fill: o.fill || CREMA,
      "letter-spacing": o.ls != null ? o.ls : null
    }, padre);
    if (o.stroke) {
      t.setAttribute("stroke", o.stroke);
      t.setAttribute("stroke-width", o.sw || 6);
      t.setAttribute("stroke-linejoin", "round");
      t.setAttribute("paint-order", "stroke");
    }
    t.textContent = str == null ? "" : String(str);
    // i numeroni dei video sono stretti e altissimi: li' si stringono le
    // lettere invece di rimpicciolire il corpo
    if (o.maxW && o.comprimi) comprimi(t, o.maxW);
    else if (o.maxW) stringi(t, o.maxW, o.size || 46, o.minSize);
    return t;
  }
  function comprimi(t, maxW) {
    var w = 0;
    try { w = t.getComputedTextLength(); } catch (e) { return; }
    if (w > maxW) { t.setAttribute("textLength", maxW); t.setAttribute("lengthAdjust", "spacingAndGlyphs"); }
  }
  function stringi(t, maxW, size, minSize) {
    var w = 0;
    try { w = t.getComputedTextLength(); } catch (e) { return; }
    if (w <= maxW || !w) return;
    var nuovo = Math.max(minSize || size * 0.55, size * maxW / w);
    t.setAttribute("font-size", nuovo);
    try { w = t.getComputedTextLength(); } catch (e) { return; }
    // sotto il corpo minimo si stringono le lettere, non si esce dal riquadro
    if (w > maxW) { t.setAttribute("textLength", maxW); t.setAttribute("lengthAdjust", "spacingAndGlyphs"); }
  }

  // ── animazioni ─────────────────────────────────────────────────────
  // Lo stato di riposo e' quello finale, come nelle altre grafiche: se il
  // browser non fa girare le animazioni (iframe nascosto, input fuori
  // programma) la grafica c'e' lo stesso. Passato il tempo si impone.
  function anima(e, frames, dur, ritardo, easing) {
    if (!e || STILL) return;
    var fin = frames[frames.length - 1];
    var a = e.animate(frames, { duration: dur * 1000, delay: (ritardo || 0) * 1000,
                                easing: easing || "cubic-bezier(.2,.7,.3,1)", fill: "both" });
    setTimeout(function () {
      try { a.cancel(); } catch (x) {}
      for (var k in fin) if (k !== "offset" && k !== "easing") e.style[k] = fin[k];
    }, ((ritardo || 0) + dur) * 1000 + 250);
    return a;
  }
  function dopo(sec, fn) { if (STILL) fn(); else setTimeout(fn, sec * 1000); }

  // la macchina da scrivere dei nomi: FLACO entra una lettera alla volta
  function macchina(t, parola, inizio, passo) {
    if (STILL) { t.textContent = parola; return; }
    t.textContent = "";
    var i = 0;
    setTimeout(function batti() {
      i++;
      t.textContent = parola.slice(0, i);
      if (i < parola.length) setTimeout(batti, passo * 1000);
    }, inizio * 1000);
  }

  // una linea che si disegna: la cornice e i contorni dei riquadri
  function traccia(e, dur, ritardo) {
    if (STILL || !e.getTotalLength) return;
    var L = e.getTotalLength();
    e.style.strokeDasharray = L;
    anima(e, [{ strokeDashoffset: L }, { strokeDashoffset: 0 }], dur, ritardo, "cubic-bezier(.45,0,.2,1)");
  }

  // ── il fondo: trama del feltro, fascia a quadretti, cornice, segni ────
  function fondo(scena, o) {
    o = o || {};
    var img = document.createElement("img");
    img.className = "th-feltro"; img.alt = "";
    img.src = "talent-hunters/feltro.jpg";
    scena.appendChild(img);

    var s = el("svg", { "class": "th-fondo", width: 1920, height: 1080, viewBox: "0 0 1920 1080" });
    scena.appendChild(s);
    var defs = el("defs", {}, s);
    var pat = el("pattern", { id: "thQuadretti", width: 19.5, height: 19.5, patternUnits: "userSpaceOnUse", x: 25, y: 694 }, defs);
    el("path", { d: "M19.5 0H0V19.5", fill: "none", stroke: C.avorio, "stroke-opacity": 0.05, "stroke-width": 1 }, pat);
    var filo = el("linearGradient", { id: "thFilo", x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
    [["0", 0], [".25", 0.75], [".75", 0.75], ["1", 0]].forEach(function (st) {
      el("stop", { offset: st[0], "stop-color": C.oro, "stop-opacity": st[1] }, filo);
    });

    // la fascia in basso: il campo visto dall'alto, come nei video, ma in
    // navy e a filo sottile
    var fascia = el("g", { "class": "th-fascia" }, s);
    el("rect", { x: 0, y: 612, width: 1920, height: 468, fill: "#070B1D", "fill-opacity": 0.55 }, fascia);
    el("rect", { x: 0, y: 612, width: 1920, height: 468, fill: "url(#thQuadretti)" }, fascia);
    var croci = "";
    for (var cx = 25; cx < 1920; cx += 156)
      for (var cy = 694; cy < 1080; cy += 156)
        croci += "M" + (cx - 6) + " " + cy + "H" + (cx + 6) + "M" + cx + " " + (cy - 6) + "V" + (cy + 6);
    el("path", { d: croci, stroke: C.avorio, "stroke-opacity": 0.16, "stroke-width": 1.5, fill: "none" }, fascia);
    el("path", { d: "M34 616V1052H1886V616M34 942A110 110 0 0 1 144 1052M1776 1052A110 110 0 0 1 1886 942",
                 fill: "none", stroke: C.avorio, "stroke-opacity": 0.12, "stroke-width": 4 }, fascia);
    el("rect", { x: 0, y: 611, width: 1920, height: 2, fill: "url(#thFilo)" }, fascia);

    var segni = el("g", { "class": "th-segni", fill: C.oro }, s);
    for (var i = 0; i < 6; i++) el("rect", { x: 100, y: 632 + i * 10, width: 6, height: 4 }, segni);
    for (i = 0; i < 6; i++) el("rect", { x: 1780 + i * 19, y: 632, width: 10, height: 6 }, segni);

    var cornice = null;
    if (o.cornice !== false) {
      cornice = el("path", { d: "M94 32H1290V568H94Z", fill: "none", stroke: C.oro, "stroke-opacity": 0.55, "stroke-width": 2 }, s);
    }

    if (!STILL) {
      anima(fascia, [{ transform: "translateY(480px)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], 0.8, o.tFascia || 0.9);
      if (cornice) traccia(cornice, 1.1, o.tCornice || 1.0);
      anima(segni, [{ opacity: 0 }, { opacity: 1 }], 0.3, (o.tFascia || 0.9) + 0.6, "steps(3,end)");
    }
    return { svg: s, defs: defs, cornice: cornice };
  }

  // Ingresso comune: come nei video la scena entra sfocata e ingrandita e si
  // mette a fuoco (il lampo azzurro dei video qui non c'e': in onda, fra una
  // grafica navy e l'altra, sembrava un difetto).
  function ingresso(scena, lampo) {
    if (lampo) lampo.style.display = "none";
    if (STILL) return;
    anima(scena, [{ filter: "blur(22px)", transform: "scale(1.16)" },
                  { filter: "blur(0px)", transform: "scale(1)" }], 0.85, 0.1, "cubic-bezier(.25,.6,.3,1)");
  }

  function pronto(fn) {
    fit();
    var f = document.fonts;
    var fatto = false;
    function via() { if (fatto) return; fatto = true; fn(); }
    // i testi si misurano: prima deve esserci il font vero, non quello di ripiego
    if (f && f.load) {
      Promise.all([f.load('800 46px "Mazzard"'), f.load('700 40px "Mazzard"'), f.load('500 24px "DM Sans"')])
        .then(via, via);
      setTimeout(via, 1500);
    } else via();
  }

  function replay() { location.reload(); }
  document.addEventListener("keydown", function (e) { if (e.key === "r" || e.key === "R") replay(); });
  document.addEventListener("dblclick", replay);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function maiuscolo(s) { return String(s == null ? "" : s).toLocaleUpperCase("it-IT"); }

  return { STILL: STILL, C: C, CREMA: CREMA, NERO: NERO, dati: dati, fit: fit, el: el, testo: testo,
           stringi: stringi, anima: anima, dopo: dopo, macchina: macchina, traccia: traccia,
           fondo: fondo, ingresso: ingresso, pronto: pronto, esc: esc, maiuscolo: maiuscolo };
})();
