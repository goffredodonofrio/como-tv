/**
 * ═══════════════════════════════════════════════════════════════════
 *  SFONDO VIVO — il fondo animato delle grafiche a schermo pieno
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Due cose, entrambe dietro al contenuto e volutamente sottotono:
 *
 *   1) il blu respira — due aloni larghissimi che derivano su cicli di
 *      un minuto e mezzo, cosi' il fondo non e' mai una tinta piatta;
 *   2) un pulviscolo dorato lo attraversa lentamente.
 *
 *  Devono farsi notare solo se li cerchi.
 *
 *  Perche' e' fatto cosi'
 *  ──────────────────────
 *  Queste pagine girano dentro vMix su sette macchine, mentre le stesse
 *  macchine codificano il video. Il costo in CPU e' un vincolo vero, non
 *  un dettaglio, quindi:
 *
 *   · la tela e' a META' risoluzione (960x540) e viene stirata a schermo
 *     pieno dal CSS. La polvere e' sfocata per natura, la differenza non
 *     si vede, e il lavoro di riempimento cala di quattro volte.
 *   · ogni granello e' un'immagine gia' pronta (un dischetto sfumato
 *     disegnato una sola volta all'avvio) ricopiata con drawImage:
 *     costa molto meno che ridisegnare un gradiente per ogni granello
 *     a ogni fotogramma.
 *   · quando la pagina non e' in onda il browser ferma da solo
 *     requestAnimationFrame: ferma niente CPU quando non serve.
 *
 *  Si aggancia da solo a #stage e non tocca il resto della pagina.
 */
(function () {
  "use strict";

  var stage = document.getElementById("stage");
  if (!stage) return;

  var L = 960, A = 540;              // tela a meta' risoluzione

  // Quanta polvere e quanto in fretta. Quella in onda e' "media",
  // scelta guardandola a schermo pieno. Le altre due restano per poter
  // confrontare senza toccare il file: basta aggiungere &polvere=quieta
  // (o forte) all'indirizzo della grafica.
  var TARATURE = {
    quieta: { n: 90,  v: 1,   op: 1   },   // quasi ferma, quella di partenza
    media:  { n: 130, v: 2.5, op: 1.3 },   // in onda
    forte:  { n: 180, v: 4,   op: 1.6 }
  };
  var scelta = (new URLSearchParams(location.search).get("polvere") || "").toLowerCase();
  var T = TARATURE[scelta] || TARATURE.media;
  var GRANELLI = T.n;

  var tela = document.createElement("canvas");
  tela.id = "polvere";
  tela.width = L; tela.height = A;
  tela.style.cssText =
    "position:absolute;left:0;top:0;width:1920px;height:1080px;" +
    "pointer-events:none;";
  // in cima al fondo (aloni compresi) e sotto a tutto il contenuto
  stage.insertBefore(tela, stage.firstChild);

  var g = tela.getContext("2d");

  // ── 1) il blu che respira ──────────────────────────────────────────
  // Due aloni molto larghi che derivano avanti e indietro su cicli
  // lunghi e diversi fra loro, cosi' non tornano mai in fase. Sono
  // gradienti animati solo per trasformazione: li muove la scheda
  // grafica, la CPU non se ne accorge. Niente sfocature: un gradiente
  // e' gia' morbido, e il filtro blur su superfici cosi' grandi
  // costerebbe piu' di tutto il resto messo insieme.
  var stile = document.createElement("style");
  stile.textContent =
    "#aloni{position:absolute;inset:0;overflow:hidden;pointer-events:none;}" +
    "#aloni i{position:absolute;display:block;border-radius:50%;will-change:transform;}" +
    "#aloni .a1{width:1500px;height:1100px;left:-280px;top:-260px;" +
      "background:radial-gradient(closest-side,rgba(42,74,158,.42),transparent 72%);" +
      "animation:derivaA 96s ease-in-out infinite alternate;}" +
    "#aloni .a2{width:1300px;height:1000px;right:-240px;bottom:-240px;" +
      "background:radial-gradient(closest-side,rgba(24,36,86,.55),transparent 72%);" +
      "animation:derivaB 132s ease-in-out infinite alternate;}" +
    "#aloni .a3{width:900px;height:700px;left:38%;top:22%;" +
      "background:radial-gradient(closest-side,rgba(201,162,75,.07),transparent 70%);" +
      "animation:derivaC 168s ease-in-out infinite alternate;}" +
    "@keyframes derivaA{from{transform:translate(0,0) scale(1)}" +
      "to{transform:translate(260px,140px) scale(1.18)}}" +
    "@keyframes derivaB{from{transform:translate(0,0) scale(1.08)}" +
      "to{transform:translate(-300px,-160px) scale(1)}}" +
    "@keyframes derivaC{from{transform:translate(-120px,60px) scale(.9)}" +
      "to{transform:translate(140px,-80px) scale(1.25)}}";
  document.head.appendChild(stile);

  var aloni = document.createElement("div");
  aloni.id = "aloni";
  aloni.innerHTML = '<i class="a1"></i><i class="a2"></i><i class="a3"></i>';
  stage.insertBefore(aloni, stage.firstChild);   // sotto la polvere

  // il granello, disegnato una volta sola: un dischetto d'oro sfumato
  var seme = document.createElement("canvas");
  seme.width = seme.height = 32;
  (function () {
    var s = seme.getContext("2d");
    var sf = s.createRadialGradient(16, 16, 0, 16, 16, 16);
    sf.addColorStop(0, "rgba(227,194,113,1)");
    sf.addColorStop(0.35, "rgba(201,162,75,.55)");
    sf.addColorStop(1, "rgba(201,162,75,0)");
    s.fillStyle = sf;
    s.fillRect(0, 0, 32, 32);
  })();

  function nuovo(sparso) {
    return {
      x: sparso ? Math.random() * L : L + Math.random() * 60,
      y: Math.random() * A,
      r: 1.1 + Math.random() * 3.4,          // raggio sulla tela dimezzata
      vx: -(0.04 + Math.random() * 0.20) * T.v,   // deriva verso sinistra
      vy: (Math.random() - 0.5) * 0.05 * T.v,     // un filo di oscillazione
      a: (0.05 + Math.random() * 0.20) * T.op,    // opacita' massima
      t: Math.random() * 6.283,              // fase del respiro
      f: 0.004 + Math.random() * 0.010       // velocita' del respiro
    };
  }

  var p = [];
  for (var i = 0; i < GRANELLI; i++) p.push(nuovo(true));

  // Un fotogramma, disegnato subito e senza aspettare il ciclo: se il
  // browser tarda a far partire l'animazione (o e' fermo perche' la
  // pagina non e' ancora in vista) la polvere c'e' comunque dal primo
  // istante, invece di comparire dal nulla quando la grafica e' gia' in
  // onda.
  function passo() {
    g.clearRect(0, 0, L, A);
    for (var i = 0; i < GRANELLI; i++) {
      var d = p[i];
      d.x += d.vx;
      d.y += d.vy;
      d.t += d.f;
      // uscito a sinistra: rientra dall'altra parte, nuovo di zecca
      if (d.x < -6) { p[i] = nuovo(false); continue; }
      if (d.y < -6) d.y = A + 6;
      if (d.y > A + 6) d.y = -6;
      // respiro: la polvere non e' mai del tutto ferma ne' tutta uguale
      g.globalAlpha = d.a * (0.55 + 0.45 * Math.sin(d.t));
      g.drawImage(seme, d.x - d.r, d.y - d.r, d.r * 2, d.r * 2);
    }
    g.globalAlpha = 1;
  }

  function ciclo() { passo(); requestAnimationFrame(ciclo); }
  passo();                       // subito, prima di qualunque attesa
  requestAnimationFrame(ciclo);
})();
