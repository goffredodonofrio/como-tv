/**
 * ═══════════════════════════════════════════════════════════════════
 *  LAVAGNA — il campetto del giornalista, con le rose vere
 * ═══════════════════════════════════════════════════════════════════
 *
 *  E' l'attrezzo della telecronaca, non una grafica: i giocatori sono
 *  pedine da trascinare, sopra si disegna, e ogni pedina porta le note di
 *  chi racconta la partita. Non parla col ponte e non va in onda.
 *
 *  Vive in due case:
 *   · dentro le Formazioni (il tasto "Lavagna"), gia' piena delle squadre
 *     che si stanno preparando — undici, panchina e modulo;
 *   · da sola, in lavagna.html, dove le squadre si scelgono da ESPN.
 *
 *  Tre cose che TacticalPad non fa e a noi servono:
 *   · le rose sono quelle vere (ESPN, e il database giovanili del Como);
 *   · i CAMBI: entra chi esce dalla panchina, al posto di chi esce, e resta
 *     scritto sotto il campo;
 *   · le CURIOSITA': doppio clic su un giocatore e ci si scrive quello che
 *     si vuole dire in telecronaca. Chi ha una nota ha un puntino d'oro, e
 *     le note finiscono nel foglio stampato.
 *
 *  Uso:
 *    var L = Lavagna.monta(box, { salva: true });
 *    L.carica({ A:{nome,col,rosa,titolari,panchina,mod}, B:{...} });
 */
window.Lavagna = (function () {
  "use strict";

  var W = 1600, H = 900;
  var MODULI = {
    "4-3-3":   [[.06,.5],[.28,.14],[.24,.38],[.24,.62],[.28,.86],[.52,.26],[.50,.5],[.52,.74],[.80,.16],[.86,.5],[.80,.84]],
    "4-2-3-1": [[.06,.5],[.28,.14],[.24,.38],[.24,.62],[.28,.86],[.46,.36],[.46,.64],[.70,.18],[.70,.5],[.70,.82],[.90,.5]],
    "4-4-2":   [[.06,.5],[.28,.14],[.24,.38],[.24,.62],[.28,.86],[.54,.14],[.50,.40],[.50,.60],[.54,.86],[.84,.38],[.84,.62]],
    "3-5-2":   [[.06,.5],[.24,.28],[.22,.5],[.24,.72],[.50,.10],[.48,.34],[.46,.5],[.48,.66],[.50,.90],[.84,.38],[.84,.62]],
    "3-4-2-1": [[.06,.5],[.24,.28],[.22,.5],[.24,.72],[.50,.12],[.48,.40],[.48,.60],[.50,.88],[.74,.34],[.74,.66],[.90,.5]],
    "5-3-2":   [[.06,.5],[.26,.10],[.22,.32],[.20,.5],[.22,.68],[.26,.90],[.52,.30],[.50,.5],[.52,.70],[.84,.38],[.84,.62]],
    "4-3-1-2": [[.06,.5],[.28,.14],[.24,.38],[.24,.62],[.28,.86],[.50,.24],[.48,.5],[.50,.76],[.70,.5],[.88,.38],[.88,.62]]
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ns(nome, attr, dentro) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", nome);
    for (var k in attr) if (attr[k] !== undefined && attr[k] !== null) e.setAttribute(k, attr[k]);
    if (dentro) dentro.appendChild(e);
    return e;
  }
  function stile() {
    if (document.getElementById("lav-stile")) return;
    var s = document.createElement("style");
    s.id = "lav-stile";
    s.textContent =
      ".lav{--lav-oro:#C9A24B;--lav-oroB:#E3C271;--lav-avorio:#F5F1E6;--lav-fg3:#8A8B96;color:var(--lav-avorio);font-family:'DM Sans',system-ui,sans-serif;}" +
      ".lav .barra{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:10px;}" +
      ".lav button{font-family:'Mazzard',sans-serif;font-weight:700;font-size:10.5px;letter-spacing:.1em;" +
      "  text-transform:uppercase;padding:8px 11px;border-radius:7px;cursor:pointer;" +
      "  background:rgba(245,241,230,.06);color:#D8D2C2;border:1px solid rgba(245,241,230,.08);}" +
      ".lav button:hover{color:var(--lav-oroB);border-color:rgba(201,162,75,.28);}" +
      ".lav button.on{background:rgba(201,162,75,.16);border-color:var(--lav-oro);color:var(--lav-oroB);}" +
      ".lav button.via{color:#FF6B6E;border-color:rgba(229,27,32,.4);}" +
      ".lav .sep{width:1px;height:24px;background:rgba(245,241,230,.08);margin:0 2px;}" +
      ".lav .colore{width:24px;height:24px;border-radius:50%;padding:0;border:2px solid rgba(245,241,230,.25);}" +
      ".lav .colore.on{border-color:#fff;box-shadow:0 0 0 2px rgba(201,162,75,.5);}" +
      ".lav .fianco{display:flex;gap:12px;align-items:stretch;}" +
      ".lav .fianco .campoBox{flex:1 1 640px;min-width:0;}" +
      ".lav .lato{flex:0 0 300px;display:flex;flex-direction:column;gap:10px;min-width:0;}" +
      ".lav .lato .col{flex:1 1 0;overflow:auto;}" +
      "@media (max-width:1100px){.lav .fianco{flex-wrap:wrap}.lav .lato{flex:1 1 100%;flex-direction:row}}" +
      ".lav .campoBox{position:relative;width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;" +
      "  border:1px solid rgba(201,162,75,.28);background:#0B5A2E;touch-action:none;}" +
      ".lav .campoBox svg{position:absolute;inset:0;width:100%;height:100%;display:block;}" +
      ".lav .sotto{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;}" +
      ".lav .col{flex:1 1 330px;min-width:0;background:rgba(16,22,48,.66);border:1px solid rgba(245,241,230,.08);" +
      "  border-radius:10px;padding:11px;}" +
      ".lav .col h4{font-family:'Mazzard',sans-serif;font-size:10.5px;font-weight:700;letter-spacing:.2em;" +
      "  text-transform:uppercase;color:var(--lav-oro);margin-bottom:7px;display:flex;align-items:center;gap:7px;}" +
      ".lav .col h4 i{width:11px;height:11px;border-radius:50%;display:inline-block;font-style:normal;}" +
      ".lav .gioc{display:flex;flex-wrap:wrap;gap:5px;}" +
      ".lav .gioc button{font-family:'DM Sans',sans-serif;font-weight:500;font-size:11.5px;letter-spacing:.02em;" +
      "  text-transform:none;padding:5px 8px;}" +
      ".lav .gioc button.dentro{opacity:.42;}" +
      ".lav .gioc button.scelto{border-color:var(--lav-oro);color:var(--lav-oroB);background:rgba(201,162,75,.14);}" +
      ".lav .gioc button b{font-family:'Mazzard',sans-serif;color:var(--lav-oroB);margin-right:5px;}" +
      ".lav .gioc button em{font-style:normal;color:var(--lav-oro);margin-left:5px;}" +
      ".lav .nota{font-size:12.5px;color:var(--lav-fg3);margin-top:8px;line-height:1.5;}" +
      ".lav .nota.ok{color:#7BDCAA;}.lav .nota.err{color:#FF8A8C;}" +
      ".lav .cambi{font-size:12.5px;color:#D8D2C2;line-height:1.7;}" +
      ".lav .cambi span{color:var(--lav-fg3);}" +
      ".lav .curio{font-size:12.5px;color:#D8D2C2;line-height:1.6;}" +
      ".lav .curio div{padding:4px 0;border-bottom:1px solid rgba(245,241,230,.05);}" +
      ".lav .curio b{font-family:'Mazzard',sans-serif;color:var(--lav-oroB);}" +
      /* il foglietto delle curiosita': sta attaccato al giocatore, sul campo */
      ".lav .campoBox .foglietto{position:absolute;z-index:8;width:300px;max-width:92%;" +
      "  background:linear-gradient(180deg,#141B3C,#0E1430);box-shadow:0 12px 30px rgba(0,0,0,.55);" +
      "  border:1px solid rgba(201,162,75,.5);border-radius:10px;padding:12px;}" +
      ".lav .foglietto h3{font-family:'Mazzard',sans-serif;font-size:11px;font-weight:700;letter-spacing:.16em;" +
      "  text-transform:uppercase;color:var(--lav-oro);margin-bottom:8px;}" +
      ".lav .foglietto textarea{width:100%;height:110px;padding:9px 10px;border-radius:7px;resize:vertical;" +
      "  background:rgba(245,241,230,.06);border:1px solid rgba(245,241,230,.16);color:var(--lav-avorio);" +
      "  font-family:'DM Sans',sans-serif;font-size:13.5px;line-height:1.45;}" +
      ".lav .foglietto textarea:focus{outline:none;border-color:rgba(201,162,75,.4);}" +
      ".lav .foglietto .piede{display:flex;gap:6px;justify-content:flex-end;margin-top:9px;}" +
      ".lav .foglietto .piede button{padding:6px 9px;font-size:10px;}" +
      ".lav .foglietto .via{color:#FF6B6E;border-color:rgba(229,27,32,.4);}";
    document.head.appendChild(s);
  }

  var quante = 0;
  function monta(box, opz) {
    opz = opz || {};
    var IO = "lav" + (++quante);   // il nome di questa lavagna: gli id non si scontrano
    stile();
    box.classList.add("lav");
    box.innerHTML =
      '<div class="barra">' +
        '<button type="button" class="on" data-arnese="muovi">&#10021; Muovi</button>' +
        '<button type="button" data-arnese="penna">&#9998; Penna</button>' +
        '<button type="button" data-arnese="freccia">&#10230; Freccia</button>' +
        '<button type="button" data-arnese="linea">&#9472; Linea</button>' +
        '<button type="button" data-arnese="tratteggio">&#8943; Tratteggio</button>' +
        '<button type="button" data-arnese="zona">&#9647; Zona</button>' +
        '<span class="sep"></span>' +
        ['#F5F1E6', '#F5B91E', '#E0312B', '#4FA3E8', '#0A0F24'].map(function (c, i) {
          return '<button type="button" class="colore' + (i ? "" : " on") + '" data-colore="' + c + '" style="background:' + c + '"></button>';
        }).join("") +
        '<span class="sep"></span>' +
        '<button type="button" data-az="schiera">&#9917; Schiera</button>' +
        '<button type="button" data-az="indietro">&#8630; Annulla</button>' +
        '<button type="button" class="via" data-az="pulisci">Cancella i disegni</button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-az="png">&#11015; Immagine</button>' +
        '<button type="button" data-az="stampa">&#128424; Stampa</button>' +
        (opz.salva ? '<span class="sep"></span><span data-salva="1"></span>' : "") +
      '</div>' +
      // il campo e, DI FIANCO, le due rose: si pesca da li' mentre si guarda
      // il campo, senza scorrere la pagina
      '<div class="fianco">' +
        '<div class="campoBox"><svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
        '<div class="lato">' +
          '<div class="col" data-col="A"><h4><i></i><span data-nome="A">Casa</span></h4><div class="gioc" data-rosa="A"></div></div>' +
          '<div class="col" data-col="B"><h4><i></i><span data-nome="B">Ospite</span></h4><div class="gioc" data-rosa="B"></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="nota" data-nota="1">Trascina i giocatori. <b>Doppio clic</b> su un giocatore: ci scrivi le tue curiosità. ' +
        'Per un cambio: clicca chi esce sul campo, poi chi entra dalla panchina.</div>' +
      '<div class="sotto">' +
        '<div class="col"><h4>Cambi</h4><div class="cambi" data-cambi="1"><span>Nessun cambio.</span></div></div>' +
        '<div class="col"><h4>Curiosità</h4><div class="curio" data-curio="1"><span style="color:var(--lav-fg3)">Doppio clic su un giocatore per scriverci sopra.</span></div></div>' +
      '</div>';

    var svg = box.querySelector("svg");
    var gCampo = ns("g", {}, svg), gDis = ns("g", {}, svg), gPedine = ns("g", {}, svg);
    var SQ = { A: { nome: "Casa", col: "#2E6BE6", rosa: [], mod: "4-3-3" },
               B: { nome: "Ospite", col: "#E0312B", rosa: [], mod: "4-4-2" } };
    var PEDINE = [], CAMBI = [], NOTE = {}, SCELTO = null;
    var ARNESE = "muovi", COLORE = "#F5F1E6";

    function nota(t, cls) {
      var n = box.querySelector("[data-nota]");
      n.className = "nota" + (cls ? " " + cls : "");
      n.innerHTML = t;
    }

    // ── il campo ────────────────────────────────────────────────────────
    (function campo() {
      ns("defs", {}, gCampo);
      ns("rect", { width: W, height: H, fill: "#0E7A3E" }, gCampo);
      // Le righe dell'erba sono rettangoli, non un "motivo" richiamato per
      // nome: un altro elemento con lo stesso nome nella pagina — e nelle
      // Formazioni ce ne sono tanti — faceva sparire il disegno del campo
      // appena si toccava qualcosa. Cosi' il campo non dipende da nessuno.
      for (var r = 0; r < 16; r += 2) {
        ns("rect", { x: r * (W / 16), y: 0, width: W / 16, height: H, fill: "#ffffff", opacity: .035 }, gCampo);
      }
      var L = ns("g", { fill: "none", stroke: "#F5F1E6", "stroke-opacity": .75, "stroke-width": 3 }, gCampo);
      var m = 40;
      ns("rect", { x: m, y: m, width: W - 2 * m, height: H - 2 * m }, L);
      ns("path", { d: "M" + (W / 2) + " " + m + "V" + (H - m) }, L);
      ns("circle", { cx: W / 2, cy: H / 2, r: 110 }, L);
      ns("circle", { cx: W / 2, cy: H / 2, r: 5, fill: "#F5F1E6", stroke: "none" }, L);
      [0, 1].forEach(function (lato) {
        var x0 = lato ? W - m : m, s = lato ? -1 : 1;
        ns("rect", { x: Math.min(x0, x0 + s * 200), y: H / 2 - 200, width: 200, height: 400 }, L);
        ns("rect", { x: Math.min(x0, x0 + s * 75), y: H / 2 - 100, width: 75, height: 200 }, L);
        ns("circle", { cx: x0 + s * 130, cy: H / 2, r: 4, fill: "#F5F1E6", stroke: "none" }, L);
        ns("path", { d: "M" + (x0 + s * 200) + " " + (H / 2 - 55) + "A 75 75 0 0 " + (lato ? 0 : 1) +
                        " " + (x0 + s * 200) + " " + (H / 2 + 55) }, L);
      });
    })();

    // ── le pedine ───────────────────────────────────────────────────────
    function chiave(p) { return p.lato + ":" + p.pid; }
    function pedina(p) {
      var g = ns("g", { "data-pid": chiave(p), style: "cursor:grab" }, gPedine);
      ns("circle", { cx: 0, cy: 0, r: 26, fill: SQ[p.lato].col, stroke: "#F5F1E6", "stroke-width": 3, "class": "disco" }, g);
      var t = ns("text", { x: 0, y: 9, "text-anchor": "middle", "font-family": "Mazzard", "font-weight": 800,
                           "font-size": 24, fill: "#F5F1E6" }, g);
      t.textContent = p.num || "";
      var n = ns("text", { x: 0, y: 48, "text-anchor": "middle", "font-family": "Mazzard", "font-weight": 700,
                           "font-size": 19, fill: "#F5F1E6", stroke: "#06301A", "stroke-width": 4,
                           "paint-order": "stroke", "stroke-linejoin": "round" }, g);
      n.textContent = (p.cognome || "").toUpperCase();
      // il puntino d'oro: questo giocatore ha una curiosita' scritta
      ns("circle", { cx: 20, cy: -20, r: 7, fill: "#E3C271", stroke: "#06301A", "stroke-width": 2,
                     "class": "bollo", style: "display:none" }, g);
      p.g = g;
      posa(p); segnaNota(p);
      return p;
    }
    function posa(p) { p.g.setAttribute("transform", "translate(" + Math.round(p.x) + " " + Math.round(p.y) + ")"); }
    function segnaNota(p) {
      var b = p.g.querySelector(".bollo");
      if (b) b.style.display = NOTE[chiave(p)] ? "" : "none";
    }
    function inCampo(lato, pid) {
      for (var i = 0; i < PEDINE.length; i++) if (PEDINE[i].lato === lato && PEDINE[i].pid === pid) return PEDINE[i];
      return null;
    }
    function metti(lato, g, x, y) {
      var gia = inCampo(lato, g.pid);
      if (gia) { gia.x = x; gia.y = y; posa(gia); return gia; }
      var p = pedina({ lato: lato, pid: g.pid, num: g.num, cognome: g.cognome || g.nome || "", x: x, y: y });
      PEDINE.push(p);
      return p;
    }
    function togli(p) {
      PEDINE = PEDINE.filter(function (x) { return x !== p; });
      if (p.g && p.g.parentNode) p.g.parentNode.removeChild(p.g);
      if (SCELTO === p) SCELTO = null;
    }
    function evidenzia() {
      PEDINE.forEach(function (p) {
        var c = p.g.querySelector(".disco");
        c.setAttribute("stroke", p === SCELTO ? "#E3C271" : "#F5F1E6");
        c.setAttribute("stroke-width", p === SCELTO ? 6 : 3);
      });
    }

    function punto(ev) {
      var r = svg.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width * W, y: (ev.clientY - r.top) / r.height * H };
    }
    // Chi e' stato colpito: NON si guarda l'elemento sotto il puntatore.
    // Appena si comincia a trascinare, il campo cattura il puntatore e da
    // quel momento clic e doppio clic arrivano al campo, non alla pedina —
    // il doppio clic delle curiosita' non scattava mai. Si guarda quindi la
    // POSIZIONE: la pedina piu' vicina, se e' abbastanza vicina.
    function pedinaDi(ev) {
      var pt = punto(ev), vicina = null, dist = 46 * 46;
      PEDINE.forEach(function (p) {
        var dx = p.x - pt.x, dy = p.y - pt.y, d = dx * dx + dy * dy;
        if (d < dist) { dist = d; vicina = p; }
      });
      return vicina;
    }

    // ── arnesi e disegno ────────────────────────────────────────────────
    box.querySelectorAll("[data-arnese]").forEach(function (b) {
      b.addEventListener("click", function () {
        ARNESE = b.dataset.arnese;
        box.querySelectorAll("[data-arnese]").forEach(function (x) { x.classList.toggle("on", x === b); });
      });
    });
    box.querySelectorAll("[data-colore]").forEach(function (b) {
      b.addEventListener("click", function () {
        COLORE = b.dataset.colore;
        box.querySelectorAll("[data-colore]").forEach(function (x) { x.classList.toggle("on", x === b); });
      });
    });
    function punta(col) {
      var id = IO + "punta" + col.replace("#", "");
      if (svg.querySelector("#" + id)) return;
      var defs = svg.querySelector("defs");
      var m = ns("marker", { id: id, viewBox: "0 0 10 10", refX: 7, refY: 5, markerWidth: 5, markerHeight: 5,
                             orient: "auto-start-reverse" }, defs);
      ns("path", { d: "M0 0L10 5L0 10z", fill: col }, m);
    }

    var trascino = null, disegno = null, mosso = false;
    svg.addEventListener("pointerdown", function (ev) {
      chiudiNota();
      var pt = punto(ev);
      if (ARNESE === "muovi") {
        var p = pedinaDi(ev);
        if (!p) return;
        trascino = { p: p, dx: p.x - pt.x, dy: p.y - pt.y };
        mosso = false;
        svg.setPointerCapture(ev.pointerId);
        return;
      }
      var d = { tipo: ARNESE, punti: [pt], el: null };
      if (ARNESE === "penna") d.el = ns("path", { fill: "none", stroke: COLORE, "stroke-width": 5,
                                                  "stroke-linecap": "round", "stroke-linejoin": "round" }, gDis);
      else if (ARNESE === "zona") d.el = ns("rect", { fill: COLORE, "fill-opacity": .18, stroke: COLORE, "stroke-width": 3 }, gDis);
      else {
        if (ARNESE === "freccia") punta(COLORE);
        d.el = ns("path", { fill: "none", stroke: COLORE, "stroke-width": 5, "stroke-linecap": "round",
                            "stroke-dasharray": ARNESE === "tratteggio" ? "16 12" : null,
                            "marker-end": ARNESE === "freccia" ? "url(#" + IO + "punta" + COLORE.replace("#", "") + ")" : null }, gDis);
      }
      disegno = d;
      svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener("pointermove", function (ev) {
      var pt = punto(ev);
      if (trascino) {
        mosso = true;
        trascino.p.x = Math.max(20, Math.min(W - 20, pt.x + trascino.dx));
        trascino.p.y = Math.max(20, Math.min(H - 30, pt.y + trascino.dy));
        posa(trascino.p);
        return;
      }
      if (!disegno) return;
      var d = disegno;
      if (d.tipo === "penna") {
        d.punti.push(pt);
        d.el.setAttribute("d", d.punti.map(function (q, i) { return (i ? "L" : "M") + Math.round(q.x) + " " + Math.round(q.y); }).join(""));
      } else if (d.tipo === "zona") {
        var a = d.punti[0];
        d.el.setAttribute("x", Math.min(a.x, pt.x)); d.el.setAttribute("y", Math.min(a.y, pt.y));
        d.el.setAttribute("width", Math.abs(pt.x - a.x)); d.el.setAttribute("height", Math.abs(pt.y - a.y));
      } else {
        var b0 = d.punti[0];
        d.el.setAttribute("d", "M" + Math.round(b0.x) + " " + Math.round(b0.y) + "L" + Math.round(pt.x) + " " + Math.round(pt.y));
      }
    });
    function fine() {
      if (trascino) {
        // un clic senza trascinamento sceglie il giocatore: e' il primo passo
        // del cambio (chi esce)
        if (!mosso) { SCELTO = SCELTO === trascino.p ? null : trascino.p; evidenzia(); disegnaRose(); }
        trascino = null;
        return;
      }
      if (disegno) {
        if (disegno.tipo !== "zona" && !disegno.el.getAttribute("d")) disegno.el.remove();
        disegno = null;
      }
    }
    svg.addEventListener("pointerup", fine);
    svg.addEventListener("pointercancel", fine);
    // DOPPIO CLIC: le curiosita' del giornalista su quel giocatore
    svg.addEventListener("dblclick", function (ev) {
      var p = pedinaDi(ev);
      if (p) apriNota(p);
    });

    // ── la finestrella delle curiosita' ─────────────────────────────────
    // IL FOGLIETTO: si apre attaccato al giocatore, sul campo, non in mezzo
    // allo schermo — in telecronaca si guarda il campo, non una finestra che
    // lo copre. Se il giocatore sta a destra, il foglietto si apre a sinistra.
    function apriNota(p) {
      chiudiNota();
      var k = chiave(p), cassa = box.querySelector(".campoBox");
      var f = document.createElement("div");
      f.className = "foglietto";
      f.innerHTML =
        '<h3>' + esc((p.num ? p.num + " · " : "") + (p.cognome || "")) + ' — ' + esc(SQ[p.lato].nome) + '</h3>' +
        '<textarea placeholder="Quello che vuoi dire in telecronaca: numeri, precedenti, come si pronuncia il nome…"></textarea>' +
        '<div class="piede">' +
          '<button type="button" data-f="togli" class="via">Togli dal campo</button>' +
          '<button type="button" data-f="chiudi">Chiudi</button>' +
          '<button type="button" data-f="salva" class="on">Salva</button>' +
        '</div>';
      cassa.appendChild(f);
      // dove: accanto alla pedina, in percentuale del campo, e sempre dentro
      var largo = f.offsetWidth || 300, alto = f.offsetHeight || 210;
      var r = cassa.getBoundingClientRect();
      var px = p.x / W * r.width, py = p.y / H * r.height;
      var x = px + 40, y = py - alto / 2;
      if (x + largo > r.width - 8) x = px - 40 - largo;
      f.style.left = Math.max(8, Math.min(r.width - largo - 8, x)) + "px";
      f.style.top = Math.max(8, Math.min(r.height - alto - 8, y)) + "px";
      var ta = f.querySelector("textarea");
      ta.value = NOTE[k] || "";
      ta.focus();
      f.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      f.addEventListener("dblclick", function (ev) { ev.stopPropagation(); });
      f.addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest("button[data-f]") : null;
        if (!b) return;
        if (b.dataset.f === "salva") {
          var t = ta.value.trim();
          if (t) NOTE[k] = t; else delete NOTE[k];
          segnaNota(p); disegnaCurio(); disegnaRose();
        }
        if (b.dataset.f === "togli") { togli(p); disegnaRose(); disegnaCurio(); }
        chiudiNota();
      });
      f.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") chiudiNota();
        // Cmd/Ctrl+Invio salva: in telecronaca non si cercano i pulsanti
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) f.querySelector('[data-f="salva"]').click();
      });
    }
    function chiudiNota() {
      var f = box.querySelector(".foglietto");
      if (f) f.remove();
    }

    function disegnaCurio() {
      var c = box.querySelector("[data-curio]");
      var righe = PEDINE.filter(function (p) { return NOTE[chiave(p)]; });
      // anche chi e' uscito dal campo tiene la sua nota: si mostra lo stesso
      Object.keys(NOTE).forEach(function (k) {
        if (!PEDINE.some(function (p) { return chiave(p) === k; })) {
          var pezzi = k.split(":");
          var g = (SQ[pezzi[0]] && SQ[pezzi[0]].rosa || []).filter(function (x) { return String(x.pid) === pezzi[1]; })[0];
          if (g) righe.push({ lato: pezzi[0], pid: pezzi[1], num: g.num, cognome: g.cognome, fuori: true });
        }
      });
      c.innerHTML = righe.length ? righe.map(function (p) {
        return '<div><b>' + esc((p.num ? p.num + " " : "") + (p.cognome || "")) + '</b> · ' +
               esc(SQ[p.lato].nome) + (p.fuori ? " (fuori)" : "") + '<br>' + esc(NOTE[p.lato + ":" + p.pid]) + '</div>';
      }).join("") : '<span style="color:var(--lav-fg3)">Doppio clic su un giocatore per scriverci sopra.</span>';
    }

    // ── le rose, la panchina e i cambi ──────────────────────────────────
    function disegnaRose() {
      ["A", "B"].forEach(function (lato) {
        var col = box.querySelector('[data-col="' + lato + '"]');
        col.querySelector("h4 i").style.background = SQ[lato].col;
        col.querySelector('[data-nome="' + lato + '"]').textContent = SQ[lato].nome;
        var box2 = box.querySelector('[data-rosa="' + lato + '"]');
        box2.innerHTML = (SQ[lato].rosa || []).map(function (g, i) {
          var dentro = !!inCampo(lato, g.pid);
          return '<button type="button" data-lato="' + lato + '" data-i="' + i + '"' +
                 (dentro ? ' class="dentro"' : "") + '>' +
                 (g.num ? "<b>" + esc(g.num) + "</b>" : "") + esc(g.cognome || g.nome) +
                 (NOTE[lato + ":" + g.pid] ? "<em>&#9733;</em>" : "") + "</button>";
        }).join("") || '<span style="color:var(--lav-fg3);font-size:12.5px">Nessuna rosa.</span>';
      });
      var ca = box.querySelector("[data-cambi]");
      ca.innerHTML = CAMBI.length ? CAMBI.map(function (c) {
        return '<div><span>' + esc(SQ[c.lato].nome) + '</span> &nbsp; &#8593; ' + esc(c.dentro) +
               ' &nbsp; &#8595; ' + esc(c.fuori) + '</div>';
      }).join("") : '<span>Nessun cambio.</span>';
      // chi e' scelto sul campo si vede anche nella sua rosa
      if (SCELTO) {
        var b = box.querySelector('[data-rosa="' + SCELTO.lato + '"] button[data-i]');
        (SQ[SCELTO.lato].rosa || []).forEach(function (g, i) {
          if (g.pid === SCELTO.pid) {
            var e = box.querySelector('[data-rosa="' + SCELTO.lato + '"] button[data-i="' + i + '"]');
            if (e) e.classList.add("scelto");
          }
        });
      }
    }
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("button[data-lato]") : null;
      if (!b) return;
      var lato = b.dataset.lato, g = SQ[lato].rosa[+b.dataset.i];
      if (!g) return;
      var gia = inCampo(lato, g.pid);
      // IL CAMBIO: c'e' un giocatore scelto sul campo, della stessa squadra, e
      // si clicca uno che in campo non c'e'. Entra al posto suo, e resta scritto.
      if (SCELTO && SCELTO.lato === lato && !gia) {
        var fuori = SCELTO, x = fuori.x, y = fuori.y;
        CAMBI.push({ lato: lato, dentro: (g.num ? g.num + " " : "") + (g.cognome || g.nome),
                     fuori: (fuori.num ? fuori.num + " " : "") + fuori.cognome });
        togli(fuori);
        metti(lato, g, x, y);
        SCELTO = null; evidenzia(); disegnaRose(); disegnaCurio();
        nota("Cambio segnato: <b>" + esc(g.cognome || g.nome) + "</b> per <b>" + esc(fuori.cognome) + "</b>.", "ok");
        return;
      }
      if (gia) { togli(gia); disegnaRose(); disegnaCurio(); return; }
      var n = PEDINE.filter(function (p) { return p.lato === lato; }).length;
      var x2 = lato === "A" ? 180 + (n % 4) * 60 : W - 180 - (n % 4) * 60;
      metti(lato, g, x2, 120 + Math.floor(n / 4) * 80);
      disegnaRose();
    });

    // ── schiera ─────────────────────────────────────────────────────────
    function ordinaPerRuolo(r) {
      var peso = { G: 0, GK: 0, P: 0, D: 1, CB: 1, LB: 1, RB: 1, M: 2, C: 2, CM: 2, DM: 2, AM: 2, LM: 2, RM: 2,
                   F: 3, A: 3, CF: 3, LW: 3, RW: 3, ST: 3 };
      return r.slice().sort(function (a, b) {
        var pa = peso[String(a.ruolo || "").toUpperCase()], pb = peso[String(b.ruolo || "").toUpperCase()];
        if (pa === undefined) pa = 2;
        if (pb === undefined) pb = 2;
        return pa - pb || (parseInt(a.num, 10) || 99) - (parseInt(b.num, 10) || 99);
      });
    }
    function schiera() {
      ["A", "B"].forEach(function (lato) {
        var s = SQ[lato];
        var lista = (s.titolari && s.titolari.length) ? s.titolari : ordinaPerRuolo(s.rosa || []).slice(0, 11);
        if (!lista.length) return;
        var mod = MODULI[s.mod] || MODULI["4-3-3"];
        PEDINE.filter(function (p) { return p.lato === lato; }).forEach(togli);
        lista.slice(0, 11).forEach(function (g, i) {
          var q = mod[i] || [.5, .5];
          var x = lato === "A" ? q[0] * (W / 2) : W - q[0] * (W / 2);
          metti(lato, g, x, 60 + q[1] * (H - 120));
        });
      });
      disegnaRose(); disegnaCurio();
      nota("Schierate. Clicca un giocatore per sceglierlo (poi uno dalla panchina per il cambio), " +
           "doppio clic per le curiosità.", "ok");
    }

    // ── immagine e stampa ───────────────────────────────────────────────
    function immagine(poi) {
      var copia = svg.cloneNode(true);
      copia.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      copia.setAttribute("width", W); copia.setAttribute("height", H);
      var blob = new Blob([new XMLSerializer().serializeToString(copia)], { type: "image/svg+xml;charset=utf-8" });
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas"); c.width = W; c.height = H;
        c.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        poi(c.toDataURL("image/png"));
      };
      img.onerror = function () { URL.revokeObjectURL(url); nota("Immagine non riuscita.", "err"); };
      img.src = url;
    }
    function titolo() { return (SQ.A.nome || "Casa") + " - " + (SQ.B.nome || "Ospite"); }
    function stampa() {
      immagine(function (dati) {
        var w = window.open("", "_blank");
        if (!w) { nota("Il browser ha bloccato la finestra di stampa.", "err"); return; }
        var note = Object.keys(NOTE).map(function (k) {
          var pezzi = k.split(":");
          var g = (SQ[pezzi[0]].rosa || []).filter(function (x) { return String(x.pid) === pezzi[1]; })[0] ||
                  PEDINE.filter(function (p) { return chiave(p) === k; })[0];
          var nome = g ? ((g.num ? g.num + " " : "") + (g.cognome || g.nome || "")) : k;
          return "<div><b>" + esc(nome) + "</b> · " + esc(SQ[pezzi[0]].nome) + " — " + esc(NOTE[k]) + "</div>";
        }).join("");
        var cambi = CAMBI.map(function (c) {
          return "<div>" + esc(SQ[c.lato].nome) + ": &#8593; " + esc(c.dentro) + " &#8595; " + esc(c.fuori) + "</div>";
        }).join("");
        w.document.write('<title>' + esc(titolo()) + '</title>' +
          '<style>@page{size:A4 landscape;margin:8mm}body{margin:0;font-family:system-ui,sans-serif;color:#14161C}' +
          'h1{font-size:16pt;margin:0 0 4mm}img{width:100%;border-radius:3mm}' +
          '.b{display:flex;gap:6mm;margin-top:4mm;font-size:9.5pt;line-height:1.5}' +
          '.b > div{flex:1}.b h2{font-size:10pt;margin-bottom:2mm}</style>' +
          '<h1>' + esc(titolo()) + '</h1><img src="' + dati + '" onload="window.print()">' +
          '<div class="b"><div><h2>Cambi</h2>' + (cambi || "—") + '</div>' +
          '<div><h2>Curiosità</h2>' + (note || "—") + '</div></div>');
        w.document.close();
      });
    }
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("button[data-az]") : null;
      if (!b) return;
      if (b.dataset.az === "schiera") schiera();
      if (b.dataset.az === "indietro") { var u = gDis.lastElementChild; if (u) u.remove(); }
      if (b.dataset.az === "pulisci") gDis.innerHTML = "";
      if (b.dataset.az === "stampa") stampa();
      if (b.dataset.az === "png") immagine(function (dati) {
        var a = document.createElement("a");
        a.href = dati; a.download = titolo().replace(/[^A-Za-z0-9-]+/g, "-") + ".png";
        document.body.appendChild(a); a.click(); a.remove();
      });
    });

    // ── quello che entra e quello che esce ──────────────────────────────
    function carica(d) {
      ["A", "B"].forEach(function (lato) {
        var s = d && d[lato];
        if (!s) return;
        SQ[lato] = { nome: s.nome || SQ[lato].nome, col: s.col || SQ[lato].col,
                     rosa: s.rosa || [], titolari: s.titolari || [], mod: s.mod || SQ[lato].mod };
      });
      PEDINE.slice().forEach(togli);
      CAMBI = [];
      disegnaRose(); disegnaCurio();
      if (d && d.schiera !== false) schiera();
    }
    function stato() {
      return { sq: { A: SQ.A, B: SQ.B }, note: NOTE, cambi: CAMBI, disegni: gDis.innerHTML,
               pedine: PEDINE.map(function (p) { return { lato: p.lato, pid: p.pid, num: p.num, cognome: p.cognome, x: p.x, y: p.y }; }) };
    }
    function riapri(s) {
      if (!s) return;
      if (s.sq) { SQ.A = s.sq.A || SQ.A; SQ.B = s.sq.B || SQ.B; }
      NOTE = s.note || {}; CAMBI = s.cambi || [];
      PEDINE.slice().forEach(togli);
      (s.pedine || []).forEach(function (p) { PEDINE.push(pedina(p)); });
      gDis.innerHTML = s.disegni || "";
      disegnaRose(); disegnaCurio();
    }

    disegnaRose(); disegnaCurio();
    return { carica: carica, stato: stato, riapri: riapri, schiera: schiera, nota: nota,
             barraSalva: box.querySelector("[data-salva]"), moduli: Object.keys(MODULI) };
  }

  return { monta: monta, moduli: Object.keys(MODULI) };
})();
