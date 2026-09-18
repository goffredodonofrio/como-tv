/**
 * ═══════════════════════════════════════════════════════════════════
 *  OROLOGIO — il tempo di una grafica, in mano alla regia
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Per far partire una grafica da un punto qualsiasi della sua animazione
 *  non basta spostare le animazioni CSS: meta' dei motori si compongono coi
 *  timer (le righe che entrano una dopo l'altra, la foto che cambia, i
 *  numeri che crescono a requestAnimationFrame). Il vecchio cursore vedeva
 *  solo le prime, e misurava durate da un secondo.
 *
 *  Qui il tempo della pagina e' FINTO, come nell'esportazione video
 *  (13_Server_VM/esporta): setTimeout, setInterval, requestAnimationFrame,
 *  performance.now, le animazioni del browser e i video avanzano solo quando
 *  lo si dice. Cosi' si puo':
 *    · portare la grafica a qualunque secondo, in un attimo (avanza);
 *    · sapere quanto dura davvero (finoAllaFine);
 *    · e poi lasciarla andare a tempo vero da li' (libera): e' quello che
 *      fa il playout quando la grafica ha un punto di partenza.
 *
 *  Date NON si tocca: i cronometri delle grafiche devono restare veri.
 *
 *  Si carica PRIMA del motore: lo fa tempo.html, che scrive il motore nella
 *  stessa finestra dopo aver installato l'orologio. I motori non si toccano.
 *
 *  API (window.Orologio):
 *    ora()            secondi finti trascorsi
 *    avanza(t)        porta la grafica al secondo t (solo in avanti)
 *    siMuove()        secondi che mancano alla fine di quel che e' in corso
 *    finoAllaFine(max, min)  avanza finche' non resta niente in arrivo, e
 *                     dice quanto dura (al massimo max secondi)
 *    libera()         da qui il tempo e' quello vero, ripartendo da ora()
 *    pronto           Promise: la pagina ha finito di caricarsi
 */
(function () {
  "use strict";
  var W = window;
  var vero = {
    setTimeout: W.setTimeout.bind(W), clearTimeout: W.clearTimeout.bind(W),
    setInterval: W.setInterval.bind(W), clearInterval: W.clearInterval.bind(W),
    raf: W.requestAnimationFrame.bind(W), caf: W.cancelAnimationFrame.bind(W),
    now: performance.now.bind(performance)
  };
  var PASSO = 40;                 // ms finti per fotogramma: 25 al secondo
  var finto = true, ora = 0, oraAlVia = 0, t0Vero = 0;
  var seq = 1000000;              // gli id finti non si confondono con quelli veri
  var timer = new Map();          // id finto -> {quando, fn, a, ogni}
  var veri = new Map();           // id finto -> id vero, dopo libera()
  var rafSeq = 1000000, raf = new Map();

  function adesso() { return finto ? ora : oraAlVia + (vero.now() - t0Vero); }

  W.setTimeout = function (fn, ms) {
    var a = [].slice.call(arguments, 2);
    if (!finto) return vero.setTimeout.apply(null, [fn, ms].concat(a));
    var id = seq++;
    timer.set(id, { quando: ora + Math.max(0, +ms || 0), fn: fn, a: a, ogni: 0 });
    return id;
  };
  W.setInterval = function (fn, ms) {
    var a = [].slice.call(arguments, 2);
    if (!finto) return vero.setInterval.apply(null, [fn, ms].concat(a));
    var id = seq++, p = Math.max(1, +ms || 0);
    timer.set(id, { quando: ora + p, fn: fn, a: a, ogni: p });
    return id;
  };
  W.clearTimeout = W.clearInterval = function (id) {
    if (timer.has(id)) { timer.delete(id); return; }
    if (veri.has(id)) { var v = veri.get(id); vero.clearTimeout(v); vero.clearInterval(v); veri.delete(id); return; }
    vero.clearTimeout(id); vero.clearInterval(id);
  };
  W.requestAnimationFrame = function (fn) {
    if (!finto) return vero.raf(function () { fn(adesso()); });
    var id = rafSeq++;
    raf.set(id, fn);
    return id;
  };
  W.cancelAnimationFrame = function (id) {
    if (raf.has(id)) { raf.delete(id); return; }
    vero.caf(id);
  };
  performance.now = adesso;
  // il timer vero, per chi deve aspettare davvero (tempo.html, se la pagina
  // non finisce di caricarsi)
  W.__veroTimeout = vero.setTimeout;

  // La GUARDIA: le animazioni CSS nascono quando il browser calcola gli stili,
  // e da quel momento corrono a tempo vero. Mentre la pagina si carica
  // (font, immagini) passano secondi veri, e un ingresso da due secondi
  // sarebbe gia' finito prima che qualcuno tocchi il cursore. Finche' il
  // tempo e' finto, a ogni fotogramma vero (e comunque ogni 50 ms, anche se
  // la pagina non si disegna) le animazioni nuove si fermano al loro inizio.
  function guardia() { if (finto) { allinea(); vero.raf(guardia); } }
  vero.raf(guardia);
  var guardiaT = vero.setInterval(function () { if (finto) allinea(); else vero.clearInterval(guardiaT); }, 50);

  function esegui(t) {
    try { typeof t.fn === "function" ? t.fn.apply(W, t.a) : (0, eval)(String(t.fn)); }
    catch (e) { if (W.console) console.error(e); }
  }

  // un fotogramma finto: i timer scaduti in ordine, poi i requestAnimationFrame,
  // poi le animazioni del browser e i video messi al tempo giusto
  function passo(fino) {
    for (;;) {
      var pross = null, pid = null;
      timer.forEach(function (t, id) { if (t.quando <= fino && (!pross || t.quando < pross.quando)) { pross = t; pid = id; } });
      if (!pross) break;
      ora = pross.quando;
      if (pross.ogni) pross.quando += pross.ogni; else timer.delete(pid);
      esegui(pross);
    }
    ora = fino;
    var giro = raf; raf = new Map();
    giro.forEach(function (fn) { try { fn(ora); } catch (e) { if (W.console) console.error(e); } });
    allinea();
  }
  // Le animazioni del browser nascono quando le si vede la prima volta, e da
  // li' la loro posizione e' il tempo finto
  function allinea() {
    var d = W.document;
    if (!d || !d.getAnimations) return;
    d.getAnimations().forEach(function (an) {
      try {
        // nata adesso, al tempo finto di adesso: quello che ha corso a tempo
        // vero prima di essere vista (mentre la pagina si caricava) non conta
        if (an.__t0 === undefined) an.__t0 = ora;
        an.pause();
        an.currentTime = Math.max(0, ora - an.__t0);
      } catch (e) {}
    });
    [].forEach.call(d.querySelectorAll("video"), function (v) {
      try {
        if (v.__t0 === undefined) v.__t0 = ora;
        v.pause();
        var t = (ora - v.__t0) / 1000;
        if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.loop ? t % v.duration : Math.min(t, v.duration - 0.001);
      } catch (e) {}
    });
  }

  function avanza(sec) {
    if (!finto) return;
    var fino = Math.max(0, sec || 0) * 1000;
    if (fino <= ora) { allinea(); return; }
    while (ora + PASSO < fino) passo(ora + PASSO);
    passo(fino);
  }

  // quanto manca alla fine di quello che e' in corso (animazioni che finiscono,
  // timer una tantum, video non in loop). Le cose infinite — la polvere, gli
  // aloni, un giro di foto che ricomincia — non contano.
  function siMuove() {
    var d = W.document, attesa = 0;
    if (d && d.getAnimations) d.getAnimations().forEach(function (an) {
      try {
        var fine = an.effect.getComputedTiming().endTime;
        if (isFinite(fine) && (an.currentTime || 0) < fine) attesa = Math.max(attesa, fine - (an.currentTime || 0));
      } catch (e) {}
    });
    timer.forEach(function (t) { if (!t.ogni && t.quando > ora) attesa = Math.max(attesa, t.quando - ora); });
    return attesa / 1000;
  }

  // Avanza finche' non resta niente in arrivo. Non prima di "min" secondi:
  // qualche motore aspetta un'immagine prima di cominciare.
  //
  // Anche i requestAnimationFrame contano, ma non tutti: la polvere d'oro ne
  // chiede uno a ogni fotogramma per sempre. Si tiene il minimo di richieste
  // in coda visto finora — quelle che non smettono mai — e si considera in
  // moto solo quello che c'e' in piu' (un numero che cresce, un poligono che
  // si apre).
  //
  // Una grafica che gira all'infinito a timer (la foto che cambia) non
  // finisce mai: lo dichiara lei con window.GRAFICA_DURATA (secondi), cioe'
  // quanto dura il suo ingresso, e il cursore si ferma li'.
  var rafMin = Infinity;
  function finoAllaFine(max, min) {
    max = max || 20; min = min || 1;
    if (W.GRAFICA_DURATA > 0) max = Math.min(max, +W.GRAFICA_DURATA);
    var cap = max * 1000;
    while (ora < cap) {
      passo(ora + PASSO);
      rafMin = Math.min(rafMin, raf.size);
      if (ora >= min * 1000 && siMuove() <= 0 && raf.size <= rafMin) break;
    }
    return ora / 1000;
  }

  // Da qui il tempo e' quello vero. Le animazioni riprendono da dove sono,
  // i timer in sospeso diventano timer veri col tempo che gli manca.
  function libera() {
    if (!finto) return;
    allinea();
    oraAlVia = ora; t0Vero = vero.now(); finto = false;
    timer.forEach(function (t, id) {
      var manca = Math.max(0, t.quando - ora);
      if (t.ogni) {
        veri.set(id, vero.setTimeout(function () {
          esegui(t);
          veri.set(id, vero.setInterval(function () { esegui(t); }, t.ogni));
        }, manca));
      } else {
        veri.set(id, vero.setTimeout(function () { veri.delete(id); esegui(t); }, manca));
      }
    });
    timer.clear();
    raf.forEach(function (fn) { vero.raf(function () { fn(adesso()); }); });
    raf.clear();
    var d = W.document;
    // Attenzione: play() su un'animazione gia' arrivata in fondo la RIAVVOLGE
    // (lo dice lo standard) e l'ingresso ricomincerebbe da capo. Quelle finite
    // si chiudono con finish(), che le lascia sull'ultimo fotogramma.
    if (d && d.getAnimations) d.getAnimations().forEach(function (an) {
      try {
        var fine = an.effect.getComputedTiming().endTime;
        if (isFinite(fine) && (an.currentTime || 0) >= fine) an.finish(); else an.play();
      } catch (e) {}
    });
    if (d) [].forEach.call(d.querySelectorAll("video"), function (v) {
      try { if (!v.ended && v.autoplay !== false) v.play().catch(function () {}); } catch (e) {}
    });
  }

  var pronto = new Promise(function (ok) { W.__orologioPronto = ok; });

  W.Orologio = {
    ora: function () { return ora / 1000; },
    avanza: avanza, siMuove: siMuove, finoAllaFine: finoAllaFine, libera: libera,
    pronto: pronto,
    finto: function () { return finto; }
  };
})();
