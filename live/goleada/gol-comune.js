/**
 * ═══════════════════════════════════════════════════════════════════
 *  GOLEADA — i pezzi comuni delle grafiche in onda
 * ═══════════════════════════════════════════════════════════════════
 *
 *  I giochi di GOLEADA nascono come PNG preparati a mano, uno per ogni
 *  passo del gioco (la prima risposta, la seconda, la giusta…). Qui
 *  diventano motori come gli altri del catalogo, coi testi che arrivano da
 *  ?d= e il passo del gioco dentro i dati (k).
 *
 *  Sono pensati come un quiz televisivo vero: lo studio con i raggi di
 *  luce, i fari e il pavimento a griglia; le caselle a esagono allungato
 *  col bollino della lettera; le risposte che si girano con un lampo, la
 *  giusta che si accende d'oro, le lampade degli errori. I colori restano
 *  quelli Como TV — navy, oro, avorio, il rosso per gli errori — e del
 *  format resta l'asterisco di GOLEADA.
 *
 *  Tutte le grafiche hanno lo studio dietro; con {trasp:1} nei dati escono
 *  senza, da mettere sopra lo studio vero.
 *
 *  Un passo mostra fermo tutto quello che e' gia' uscito e fa entrare solo
 *  l'ultimo: in regia si manda in onda un passo alla volta senza che sparisca
 *  quello di prima.
 *
 *  Le animazioni continue (raggi, fari) sono trasformazioni CSS di gruppi
 *  SVG: le muove la scheda grafica, non la CPU delle macchine vMix.
 */
window.GOL = (function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var Q = new URLSearchParams(location.search);
  var STILL = Q.get("still") === "1";
  // i token del design system Como TV Live
  var C = { navy: "#0A0F24", navy85: "#0E1430", navy8: "#141B3C", navy7: "#20284E",
            oro: "#C9A24B", oroChiaro: "#E3C271", oroScuro: "#A67C2E", oroLuce: "#F1DE9E",
            rosso: "#E51B20", avorio: "#F5F1E6", avorioSpento: "#D8D2C2", grigio: "#8A8B96", blu: "#2B568A" };

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

  // ── lo stile dei motori: lo studio e le luci che si muovono ─────────
  (function () {
    var s = document.createElement("style");
    s.textContent =
      "@font-face{font-family:'Mazzard';src:url('../assets/fonts/MazzardM-ExtraBold.ttf') format('truetype');font-weight:800;font-style:normal;font-display:block;}" +
      "@font-face{font-family:'Mazzard';src:url('../assets/fonts/MazzardM-Bold.ttf') format('truetype');font-weight:700;font-style:normal;font-display:block;}" +
      "@font-face{font-family:'DM Sans';src:url('../assets/fonts/DMSans-Medium.ttf') format('truetype');font-weight:500;font-style:normal;font-display:block;}" +
      "*{margin:0;padding:0;box-sizing:border-box;}" +
      ":root{color-scheme:dark;}" +
      "html,body{width:100%;height:100%;overflow:hidden;background:transparent;}" +
      "#stage{position:absolute;left:50%;top:50%;width:1920px;height:1080px;overflow:hidden;transform-origin:center center;}" +
      "#stage.studio{background:radial-gradient(70% 60% at 50% 38%,#1C2A66 0%,#111A45 38%,#090E27 72%,#05081A 100%);}" +
      "#tela,.gol-studio{position:absolute;left:0;top:0;overflow:visible;}" +
      ".gol-raggi{transform-box:view-box;transform-origin:960px 430px;animation:golGira 120s linear infinite;}" +
      ".gol-faro{transform-box:view-box;animation:golFaro 9s ease-in-out infinite alternate;}" +
      ".gol-faro.b{animation-duration:11s;animation-direction:alternate-reverse;}" +
      ".gol-pulsa{animation:golPulsa 1.6s ease-in-out infinite;}" +
      "@keyframes golGira{to{transform:rotate(360deg)}}" +
      "@keyframes golFaro{from{transform:rotate(-14deg)}to{transform:rotate(14deg)}}" +
      "@keyframes golPulsa{0%,100%{opacity:.5}50%{opacity:1}}" +
      (STILL ? ".gol-raggi,.gol-faro,.gol-pulsa,.gol-ruota{animation:none!important}" : "");
    document.head.appendChild(s);
  })();

  // ── i materiali ────────────────────────────────────────────────────
  function materiali(svg) {
    var defs = el("defs", {}, svg);
    function grad(id, stops, o) {
      var g = el("linearGradient", Object.assign({ id: id, x1: 0, y1: 0, x2: 0, y2: 1 }, o || {}), defs);
      stops.forEach(function (x) { el("stop", { offset: x[0], "stop-color": x[1], "stop-opacity": x[2] == null ? 1 : x[2] }, g); });
      return g;
    }
    grad("golPannello", [["0", "#25306A"], [".48", "#141C48"], [".52", "#0F1638"], ["1", "#0A0F2A"]]);
    grad("golOro", [["0", "#FFF1C2"], [".35", "#F1D48A"], [".5", "#E3C271"], [".52", "#D2AE58"], ["1", "#A67C2E"]]);
    grad("golSpento", [["0", "#161C3C"], ["1", "#0B1029"]]);
    grad("golFilo", [["0", C.oro, 0], [".5", C.oroChiaro, 1], ["1", C.oro, 0]], { x2: 1, y2: 0 });
    grad("golBordo", [["0", "#FFF1C2"], [".5", "#C9A24B"], ["1", "#7A5A1E"]]);
    var rg = el("radialGradient", { id: "golLampo" }, defs);
    el("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": 1 }, rg);
    el("stop", { offset: "1", "stop-color": "#fff", "stop-opacity": 0 }, rg);
    var rosso = el("radialGradient", { id: "golRosso", cx: "40%", cy: "35%", r: "70%" }, defs);
    [["0", "#FF8A7A"], [".45", "#E51B20"], ["1", "#7A0A0E"]].forEach(function (x) { el("stop", { offset: x[0], "stop-color": x[1] }, rosso); });
    var ombra = el("filter", { id: "golOmbra", x: "-15%", y: "-40%", width: "130%", height: "190%" }, defs);
    el("feDropShadow", { dx: 0, dy: 12, stdDeviation: 14, "flood-color": "#000", "flood-opacity": 0.55 }, ombra);
    var alone = el("filter", { id: "golAlone", x: "-30%", y: "-80%", width: "160%", height: "260%" }, defs);
    el("feGaussianBlur", { stdDeviation: 18 }, alone);
    return defs;
  }

  // ── lo studio del quiz ─────────────────────────────────────────────
  // raggi che girano, due fari, pavimento a griglia in prospettiva, la luce
  // sull'orizzonte e l'asterisco di GOLEADA appena accennato
  function studio(stage) {
    stage.className = "studio";
    var s = el("svg", { "class": "gol-studio", width: 1920, height: 1080, viewBox: "0 0 1920 1080" });
    stage.insertBefore(s, stage.firstChild);
    var defs = el("defs", {}, s);
    var sf = el("radialGradient", { id: "golSfumaRaggi", cx: 960, cy: 430, r: 1100, gradientUnits: "userSpaceOnUse" }, defs);
    el("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": 1 }, sf);
    el("stop", { offset: "1", "stop-color": "#fff", "stop-opacity": 0 }, sf);
    var m = el("mask", { id: "golMascheraRaggi" }, defs);
    el("rect", { x: 0, y: 0, width: 1920, height: 1080, fill: "url(#golSfumaRaggi)" }, m);
    var cono = el("linearGradient", { id: "golCono", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "0", "stop-color": "#BFD4FF", "stop-opacity": 0.2 }, cono);
    el("stop", { offset: "1", "stop-color": "#BFD4FF", "stop-opacity": 0 }, cono);
    var pav = el("linearGradient", { id: "golPavimento", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "0", "stop-color": C.oro, "stop-opacity": 0.32 }, pav);
    el("stop", { offset: "1", "stop-color": C.oro, "stop-opacity": 0.03 }, pav);
    var orizz = el("radialGradient", { id: "golOrizzonte", cx: "50%", cy: "50%", r: "50%" }, defs);
    el("stop", { offset: "0", "stop-color": C.oroChiaro, "stop-opacity": 0.35 }, orizz);
    el("stop", { offset: "1", "stop-color": C.oroChiaro, "stop-opacity": 0 }, orizz);
    var filo = el("linearGradient", { id: "golFiloStudio", x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
    [["0", 0], [".5", 0.9], ["1", 0]].forEach(function (x) { el("stop", { offset: x[0], "stop-color": C.oroChiaro, "stop-opacity": x[1] }, filo); });

    // i raggi: 28 spicchi, uno d'oro e uno di blu
    var raggiM = el("g", { mask: "url(#golMascheraRaggi)" }, s);
    var raggi = el("g", { "class": "gol-raggi" }, raggiM);
    var n = 28, R = 1500;
    for (var i = 0; i < n; i++) {
      var a0 = (i / n) * Math.PI * 2, a1 = ((i + 0.5) / n) * Math.PI * 2;
      el("path", { d: "M960 430L" + (960 + Math.cos(a0) * R).toFixed(0) + " " + (430 + Math.sin(a0) * R).toFixed(0) +
                      "L" + (960 + Math.cos(a1) * R).toFixed(0) + " " + (430 + Math.sin(a1) * R).toFixed(0) + "Z",
                   fill: i % 2 ? "#3D6BD1" : C.oroChiaro, "fill-opacity": i % 2 ? 0.08 : 0.065 }, raggi);
    }
    asterisco(s, 960, 430, 330, C.oro, 0.045, 60);

    // i due fari dall'alto
    [[260, "a"], [1660, "b"]].forEach(function (f) {
      var g = el("g", { "class": "gol-faro " + f[1], style: "transform-origin:" + f[0] + "px -40px" }, s);
      el("path", { d: "M" + (f[0] - 30) + " -40L" + (f[0] + 30) + " -40L" + (f[0] + 380) + " 1080L" + (f[0] - 380) + " 1080Z", fill: "url(#golCono)" }, g);
    });

    // il pavimento: righe verso il centro e linee orizzontali che si stringono
    var pavimento = el("g", {}, s);
    el("rect", { x: 0, y: 760, width: 1920, height: 320, fill: "#03050F", "fill-opacity": 0.45 }, pavimento);
    var d = "";
    for (var k = -14; k <= 14; k++) d += "M" + (960 + k * 40) + " 760L" + (960 + k * 260) + " 1080";
    var y = 760, passo = 10;
    while (y < 1080) { d += "M0 " + y.toFixed(1) + "H1920"; y += passo; passo *= 1.32; }
    el("path", { d: d, stroke: "url(#golPavimento)", "stroke-width": 1.5, fill: "none" }, pavimento);
    el("ellipse", { cx: 960, cy: 760, rx: 900, ry: 60, fill: "url(#golOrizzonte)" }, pavimento);
    el("rect", { x: 0, y: 759, width: 1920, height: 2, fill: "url(#golFiloStudio)" }, pavimento);
    return s;
  }

  // ── testo ──────────────────────────────────────────────────────────
  function testo(padre, x, y, str, o) {
    o = o || {};
    var t = el("text", {
      x: x, y: y, "text-anchor": o.anchor || "start",
      "font-family": o.font || "Mazzard", "font-weight": o.peso || 800,
      "font-size": o.size || 46, fill: o.fill || C.avorio,
      "letter-spacing": o.ls != null ? o.ls : null
    }, padre);
    t.textContent = str == null ? "" : String(str);
    if (o.maxW) stringi(t, o.maxW, o.size || 46, o.minSize);
    return t;
  }
  function stringi(t, maxW, size, minSize) {
    var w = 0;
    try { w = t.getComputedTextLength(); } catch (e) { return; }
    if (w <= maxW || !w) return;
    t.setAttribute("font-size", Math.max(minSize || size * 0.6, size * maxW / w));
    try { w = t.getComputedTextLength(); } catch (e) { return; }
    if (w > maxW) { t.setAttribute("textLength", maxW); t.setAttribute("lengthAdjust", "spacingAndGlyphs"); }
  }
  function misura(padre, str, o) {
    // misurata al corpo pieno: se si restringesse qui, non andrebbe mai a capo
    var t = testo(padre, 0, -9999, str, Object.assign({}, o, { maxW: null })), w = 0;
    try { w = t.getComputedTextLength(); } catch (e) {}
    padre.removeChild(t);
    return w;
  }
  // Una o due righe centrate: si va a capo solo se serve, nel punto che
  // rende le due righe piu' simili.
  function righe(padre, cx, cy, str, o) {
    o = o || {};
    var parole = String(str || "").trim().split(/\s+/).filter(Boolean);
    var size = o.size || 46, maxW = o.maxW || 400, g = el("g", {}, padre);
    var linee = [parole.join(" ")];
    if (misura(g, linee[0], o) > maxW && parole.length > 1) {
      var meglio = null;
      for (var i = 1; i < parole.length; i++) {
        var a = parole.slice(0, i).join(" "), b = parole.slice(i).join(" ");
        var peggio = Math.max(misura(g, a, o), misura(g, b, o));
        if (!meglio || peggio < meglio.w) meglio = { w: peggio, l: [a, b] };
      }
      linee = meglio.l;
    }
    var corpo = linee.length === 2 ? (o.size2 || size) : size;
    var passo = corpo * (o.interlinea || 1.08);
    var y0 = cy - (linee.length - 1) * passo / 2 + corpo * 0.36;
    linee.forEach(function (l, k) {
      testo(g, cx, y0 + k * passo, l, Object.assign({}, o, { anchor: o.anchor || "middle", size: corpo, maxW: maxW }));
    });
    return g;
  }

  // ── le forme del quiz ──────────────────────────────────────────────
  // L'esagono allungato dei quiz, con le punte ai lati
  function esagono(x, y, w, h, punta) {
    var p = punta == null ? h * 0.42 : punta, m = y + h / 2;
    return "M" + x + " " + m + "L" + (x + p) + " " + y + "H" + (x + w - p) + "L" + (x + w) + " " + m +
           "L" + (x + w - p) + " " + (y + h) + "H" + (x + p) + "Z";
  }
  // o.stato: "vuota" (in attesa), "piena" (scoperta), "giusta" (oro),
  // "spenta" (le sbagliate quando esce la giusta). o.linee: [x sinistra,
  // x destra] dei fili che escono dalle punte, come nei quiz veri
  function casella(padre, x, y, w, h, o) {
    o = o || {};
    var stato = o.stato || "piena", p = o.punta == null ? h * 0.42 : o.punta;
    var g = el("g", { "class": "gol-casella" }, padre);
    if (o.linee) {
      var m = y + h / 2;
      el("path", { d: "M" + o.linee[0] + " " + m + "H" + x + "M" + (x + w) + " " + m + "H" + o.linee[1],
                   stroke: stato === "giusta" ? C.oroChiaro : C.oro, "stroke-opacity": stato === "vuota" ? 0.3 : 0.6, "stroke-width": 3 }, g);
    }
    var d = esagono(x, y, w, h, p);
    if (stato === "giusta") {
      el("path", { d: d, fill: C.oroChiaro, filter: "url(#golAlone)", "class": "gol-pulsa" }, g);
      el("path", { d: d, fill: "url(#golOro)", stroke: "#FFF6D8", "stroke-width": 3 }, g);
      el("path", { d: esagono(x + 12, y + 9, w - 24, h - 18, p - 6), fill: "none", stroke: C.navy, "stroke-opacity": 0.3, "stroke-width": 2 }, g);
    } else {
      var spento = stato === "vuota" || stato === "spenta";
      el("path", { d: d, fill: spento ? "url(#golSpento)" : "url(#golPannello)", filter: "url(#golOmbra)" }, g);
      el("path", { d: d, fill: "none", stroke: "url(#golBordo)", "stroke-width": stato === "vuota" ? 2 : 4, "stroke-opacity": stato === "vuota" ? 0.5 : 1 }, g);
      // il riflesso lucido sulla meta' alta
      if (!spento) el("path", { d: esagono(x + 14, y + 6, w - 28, h / 2 - 6, p * 0.5), fill: "#fff", "fill-opacity": 0.05 }, g);
    }
    if (stato === "spenta") g.setAttribute("opacity", 0.4);
    return g;
  }
  // il bollino della lettera o del numero
  function bollino(padre, cx, cy, r, str, o) {
    o = o || {};
    var g = el("g", {}, padre);
    el("circle", { cx: cx, cy: cy, r: r + 5, fill: C.navy, "fill-opacity": 0.7 }, g);
    el("circle", { cx: cx, cy: cy, r: r, fill: o.spento ? "url(#golSpento)" : "url(#golOro)", stroke: o.spento ? C.oro : "#FFF6D8",
                   "stroke-width": 2.5, "stroke-opacity": o.spento ? 0.55 : 1 }, g);
    testo(g, cx, cy + r * 0.36, str, { anchor: "middle", size: r * (String(str).length > 1 ? 0.88 : 1.05), fill: o.spento ? C.oroChiaro : C.navy });
    return g;
  }
  // l'asterisco di GOLEADA, a sei bracci
  function asterisco(padre, cx, cy, r, colore, opacita, spessore) {
    var d = "";
    for (var i = 0; i < 3; i++) {
      var a = i * Math.PI / 3, dx = Math.sin(a) * r, dy = -Math.cos(a) * r;
      d += "M" + (cx - dx).toFixed(1) + " " + (cy - dy).toFixed(1) + "L" + (cx + dx).toFixed(1) + " " + (cy + dy).toFixed(1);
    }
    return el("path", { d: d, stroke: colore || C.oro, "stroke-opacity": opacita == null ? 1 : opacita,
                        "stroke-width": spessore || Math.max(2, r * 0.36), "stroke-linecap": "round", fill: "none" }, padre);
  }
  // il lucchetto degli indizi non ancora usciti
  function lucchetto(padre, cx, cy, s, colore, opacita) {
    var g = el("g", { transform: "translate(" + cx + " " + cy + ") scale(" + s + ")", opacity: opacita == null ? 1 : opacita }, padre);
    el("path", { d: "M-8 -2V-9A8 8 0 0 1 8 -9V-2", fill: "none", stroke: colore, "stroke-width": 3.5 }, g);
    el("rect", { x: -12, y: -3, width: 24, height: 19, rx: 3, fill: colore }, g);
    return g;
  }
  // la raggiera dietro a chi vince: raggi d'oro che girano
  function raggiera(padre, cx, cy, r, o) {
    o = o || {};
    var g = el("g", { opacity: o.opacita == null ? 0.6 : o.opacita }, padre);
    var ruota = el("g", { "class": "gol-ruota", style: "transform-box:view-box;transform-origin:" + cx + "px " + cy + "px;animation:golGira " + (o.giro || 40) + "s linear infinite" }, g);
    var n = o.n || 22;
    for (var i = 0; i < n; i++) {
      var a0 = (i / n) * Math.PI * 2, a1 = ((i + 0.42) / n) * Math.PI * 2;
      el("path", { d: "M" + cx + " " + cy + "L" + (cx + Math.cos(a0) * r).toFixed(0) + " " + (cy + Math.sin(a0) * r).toFixed(0) +
                      "L" + (cx + Math.cos(a1) * r).toFixed(0) + " " + (cy + Math.sin(a1) * r).toFixed(0) + "Z", fill: C.oroChiaro, "fill-opacity": 0.3 }, ruota);
    }
    el("circle", { cx: cx, cy: cy, r: r * 0.8, fill: "url(#golLampo)", "fill-opacity": 0.22 }, g);
    return g;
  }

  // ── animazioni ─────────────────────────────────────────────────────
  // Lo stato di riposo e' quello finale: se il browser non fa girare le
  // animazioni la grafica c'e' lo stesso.
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
  function centro(e, o) { e.style.transformBox = "fill-box"; e.style.transformOrigin = o || "50% 50%"; }
  // la casella che si gira: si chiude in verticale e si riapre scoperta
  function gira(g, ritardo) {
    if (STILL || !g) return;
    centro(g);
    anima(g, [{ transform: "scaleY(0.02)" }, { transform: "scaleY(1.1)", offset: 0.7 }, { transform: "scaleY(1)" }],
          0.42, ritardo || 0, "cubic-bezier(.3,.8,.3,1)");
  }
  function lampo(padre, cx, cy, r, ritardo) {
    if (STILL) return;
    var c = el("circle", { cx: cx, cy: cy, r: r, fill: "url(#golLampo)", opacity: 0 }, padre);
    centro(c);
    anima(c, [{ opacity: 0, transform: "scale(.3)" }, { opacity: 0.85, transform: "scale(1)", offset: 0.25 }, { opacity: 0, transform: "scale(1.5)" }], 0.6, ritardo || 0, "ease-out");
  }
  function entra(g, ritardo, da) {
    if (STILL || !g) return;
    anima(g, [{ opacity: 0, transform: da || "translateY(30px)" }, { opacity: 1, transform: "translate(0,0)" }], 0.45, ritardo || 0);
  }
  function colpo(g, ritardo) {
    if (STILL || !g) return;
    centro(g);
    anima(g, [{ transform: "scale(1.6)", opacity: 0 }, { transform: "scale(.94)", opacity: 1, offset: 0.7 }, { transform: "scale(1)", opacity: 1 }],
          0.38, ritardo || 0, "cubic-bezier(.5,0,.6,1)");
  }

  // Lo studio dietro, a meno che i dati non chiedano la grafica trasparente
  function pronto(D, fn) {
    fit();
    if (!(D && (D.trasp === 1 || D.trasp === true))) studio(document.getElementById("stage"));
    var f = document.fonts, fatto = false;
    function via() { if (fatto) return; fatto = true; fn(); }
    if (f && f.load) {
      Promise.all([f.load('800 46px "Mazzard"'), f.load('700 40px "Mazzard"'), f.load('500 24px "DM Sans"')]).then(via, via);
      setTimeout(via, 1500);
    } else via();
  }
  document.addEventListener("keydown", function (e) { if (e.key === "r" || e.key === "R") location.reload(); });
  document.addEventListener("dblclick", function () { location.reload(); });

  function maiuscolo(s) { return String(s == null ? "" : s).toLocaleUpperCase("it-IT"); }
  function passo(d, max) {
    var k = d && d.k != null ? parseInt(d.k, 10) : max;
    return isNaN(k) ? max : Math.max(0, Math.min(max, k));
  }
  // l'intestazione dei giochi: asterisco e nome del gioco a sinistra,
  // il marchio GOLEADA a destra
  function intestazione(padre, gioco, sotto) {
    var g = el("g", {}, padre);
    asterisco(g, 116, 90, 22, C.oroChiaro, 1, 9);
    testo(g, 158, 108, maiuscolo(gioco), { size: 54, fill: C.avorio, ls: 2 });
    if (sotto) testo(g, 160, 150, maiuscolo(sotto), { font: "DM Sans", peso: 500, size: 26, fill: C.oroChiaro, ls: 6, maxW: 1100 });
    testo(g, 1804, 102, "GOLEADA", { anchor: "end", size: 40, fill: C.oroChiaro, ls: 6 });
    el("rect", { x: 1564, y: 120, width: 240, height: 3, fill: "url(#golFilo)" }, g);
    return g;
  }

  return { STILL: STILL, C: C, dati: dati, fit: fit, el: el, materiali: materiali, testo: testo, stringi: stringi, righe: righe,
           esagono: esagono, casella: casella, bollino: bollino, asterisco: asterisco, lucchetto: lucchetto, raggiera: raggiera,
           anima: anima, centro: centro, gira: gira, lampo: lampo, entra: entra, colpo: colpo,
           pronto: pronto, maiuscolo: maiuscolo, passo: passo, intestazione: intestazione };
})();
