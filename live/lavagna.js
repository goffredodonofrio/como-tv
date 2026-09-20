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
      ".lav .segui{align-items:center;}" +
      ".lav .segui select{padding:7px 9px;border-radius:7px;background:rgba(245,241,230,.06);" +
      "  border:1px solid rgba(245,241,230,.16);color:var(--lav-avorio);font-family:'DM Sans',sans-serif;" +
      "  font-size:12.5px;max-width:260px;}" +
      ".lav .segui select option{background:#141B3C;color:var(--lav-avorio);}" +
      ".lav .segui b{font-family:'Mazzard',sans-serif;font-size:10.5px;letter-spacing:.16em;" +
      "  text-transform:uppercase;color:#FF8A8C;}" +
      ".lav .segui .nota{flex:1 1 220px;font-size:11.5px;}" +
      ".lav .diretta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;padding:8px 12px;" +
      "  border-radius:9px;background:rgba(229,27,32,.10);border:1px solid rgba(229,27,32,.45);font-size:13px;}" +
      ".lav .diretta b{font-family:'Mazzard',sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#FF8A8C;}" +
      ".lav .diretta .punteggio{font-family:'Mazzard',sans-serif;font-weight:800;font-size:17px;color:var(--lav-avorio);}" +
      ".lav .diretta .azione{color:#D8D2C2;flex:1 1 220px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
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
      ".lav .campoBox .foglietto{position:absolute;z-index:8;width:420px;max-width:94%;" +
      "  background:linear-gradient(180deg,#141B3C,#0E1430);box-shadow:0 12px 30px rgba(0,0,0,.55);" +
      "  border:1px solid rgba(201,162,75,.5);border-radius:10px;padding:12px;}" +
      ".lav .foglietto h3{font-family:'Mazzard',sans-serif;font-size:11px;font-weight:700;letter-spacing:.16em;" +
      "  text-transform:uppercase;color:var(--lav-oro);margin-bottom:8px;}" +
      ".lav .foglietto textarea{width:100%;height:190px;padding:11px 12px;border-radius:7px;resize:vertical;" +
      "  background:rgba(245,241,230,.06);border:1px solid rgba(245,241,230,.16);color:var(--lav-avorio);" +
      "  font-family:'DM Sans',sans-serif;font-size:15px;line-height:1.5;}" +
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
        '<button type="button" data-az="indietro" title="Annulla l\'ultima mossa (Cmd/Ctrl+Z)">&#8630; Annulla</button>' +
        '<button type="button" class="via" data-az="pulisci">Cancella i disegni</button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-az="png">&#11015; Immagine</button>' +
        '<button type="button" data-az="stampa">&#128424; Stampa</button>' +
        (opz.salva ? '<span class="sep"></span><span data-salva="1"></span>' : "") +
      '</div>' +
      // seguire una partita vera: la scelta sta qui dentro, cosi' vale in
      // tutte le case della lavagna (pagina, Formazioni, banco partita)
      // la riga della diretta esce solo dove serve (il banco partita): la
      // lavagna della telecronaca resta un attrezzo a mano
      (!opz.diretta ? "" :
      '<div class="barra segui">' +
        '<b>Diretta</b>' +
        '<select data-d="comp"><option value="">— competizione —</option></select>' +
        '<select data-d="part" disabled><option value="">— partita —</option></select>' +
        '<button type="button" data-az="segui" disabled>&#128308; Segui</button>' +
        '<button type="button" data-az="fermaDiretta">Stacca</button>' +
        '<span class="nota" data-dnota="1" style="margin:0">Il pallone segue le giocate di ESPN, col suo ritardo (circa un minuto). Le giovanili ESPN non le ha.</span>' +
      '</div>') +
      // il campo e, DI FIANCO, le due rose: si pesca da li' mentre si guarda
      // il campo, senza scorrere la pagina
      '<div class="diretta" data-diretta="1" style="display:none"></div>' +
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
    // La pila dei passi: prima di ogni mossa si mette da parte com'era.
    // Cmd/Ctrl+Z torna indietro, Cmd/Ctrl+Maiusc+Z rifa'. Trenta passi
    // bastano: e' una lavagna, non un programma di montaggio.
    var PASSI = [], RIFAI = [], PASSI_MAX = 30;
    var ARNESE = "muovi", COLORE = "#F5F1E6";

    function ricorda() {
      try { PASSI.push(JSON.stringify(stato())); } catch (e) { return; }
      if (PASSI.length > PASSI_MAX) PASSI.shift();
      RIFAI.length = 0;
    }
    function annulla() {
      if (!PASSI.length) { nota("Non c'è più niente da annullare.", ""); return; }
      try { RIFAI.push(JSON.stringify(stato())); } catch (e) {}
      riapri(JSON.parse(PASSI.pop()));
      nota("Annullato. <b>Cmd/Ctrl+Maiusc+Z</b> per rifare.", "");
    }
    function rifai() {
      if (!RIFAI.length) return;
      try { PASSI.push(JSON.stringify(stato())); } catch (e) {}
      riapri(JSON.parse(RIFAI.pop()));
      nota("Rifatto.", "");
    }
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
      if (p.mister) {
        // l'allenatore non e' un giocatore: gettone quadrato, bordo d'oro, e
        // sta a bordo campo. Si sposta e si clicca come gli altri.
        ns("rect", { x: -27, y: -27, width: 54, height: 54, rx: 10, fill: SQ[p.lato].col,
                     stroke: "#E3C271", "stroke-width": 3, "class": "disco" }, g);
        var m = ns("text", { x: 0, y: 7, "text-anchor": "middle", "font-family": "Mazzard", "font-weight": 800,
                             "font-size": 17, fill: "#F5F1E6", "letter-spacing": 1 }, g);
        m.textContent = "ALL";
      } else {
        ns("circle", { cx: 0, cy: 0, r: 26, fill: SQ[p.lato].col, stroke: "#F5F1E6", "stroke-width": 3, "class": "disco" }, g);
        var t = ns("text", { x: 0, y: 9, "text-anchor": "middle", "font-family": "Mazzard", "font-weight": 800,
                             "font-size": 24, fill: "#F5F1E6" }, g);
        t.textContent = p.num || "";
      }
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
      var p = pedina({ lato: lato, pid: g.pid, num: g.num, cognome: g.cognome || g.nome || "",
                       mister: !!g.mister, x: x, y: y });
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
        c.setAttribute("stroke", p === SCELTO ? "#E3C271" : (p.mister ? "#E3C271" : "#F5F1E6"));
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
        ricorda();
        trascino = { p: p, dx: p.x - pt.x, dy: p.y - pt.y };
        mosso = false;
        svg.setPointerCapture(ev.pointerId);
        return;
      }
      ricorda();
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
      var largo = f.offsetWidth || 420, alto = f.offsetHeight || 300;
      var r = cassa.getBoundingClientRect();
      var px = p.x / W * r.width, py = p.y / H * r.height;
      var x = px + 44, y = py - alto / 2;
      if (x + largo > r.width - 8) x = px - 44 - largo;
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
          ricorda();
          var t = ta.value.trim();
          if (t) NOTE[k] = t; else delete NOTE[k];
          segnaNota(p); disegnaCurio(); disegnaRose();
        }
        if (b.dataset.f === "togli") { ricorda(); togli(p); disegnaRose(); disegnaCurio(); }
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
        var mis = misterDi(lato);
        var testaAll = mis ? '<button type="button" data-lato="' + lato + '" data-mister="1"' +
            (inCampo(lato, "mister") ? ' class="dentro"' : "") + '><b>ALL</b>' + esc(mis.cognome) +
            (NOTE[lato + ":mister"] ? "<em>&#9733;</em>" : "") + "</button>" : "";
        box2.innerHTML = testaAll + (SQ[lato].rosa || []).map(function (g, i) {
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
      var lato = b.dataset.lato;
      var g = b.dataset.mister ? misterDi(lato) : SQ[lato].rosa[+b.dataset.i];
      if (!g) return;
      var gia = inCampo(lato, g.pid);
      // IL CAMBIO: c'e' un giocatore scelto sul campo, della stessa squadra, e
      // si clicca uno che in campo non c'e'. Entra al posto suo, e resta scritto.
      if (SCELTO && SCELTO.lato === lato && !gia) {
        ricorda();
        var fuori = SCELTO, x = fuori.x, y = fuori.y;
        CAMBI.push({ lato: lato, dentro: (g.num ? g.num + " " : "") + (g.cognome || g.nome),
                     fuori: (fuori.num ? fuori.num + " " : "") + fuori.cognome });
        togli(fuori);
        metti(lato, g, x, y);
        SCELTO = null; evidenzia(); disegnaRose(); disegnaCurio();
        nota("Cambio segnato: <b>" + esc(g.cognome || g.nome) + "</b> per <b>" + esc(fuori.cognome) + "</b>.", "ok");
        return;
      }
      if (gia) { ricorda(); togli(gia); disegnaRose(); disegnaCurio(); return; }
      ricorda();
      var n = PEDINE.filter(function (p) { return p.lato === lato; }).length;
      var x2 = lato === "A" ? 180 + (n % 4) * 60 : W - 180 - (n % 4) * 60;
      metti(lato, g, x2, 120 + Math.floor(n / 4) * 80);
      disegnaRose();
    });

    // ── schiera ─────────────────────────────────────────────────────────
    // l'allenatore, se la squadra ce l'ha: una pedina come le altre, con un
    // suo nome finto (serve solo a riconoscerla fra le note)
    function misterDi(lato) {
      var a = SQ[lato].all;
      if (!a || !(a.cognome || a.nome)) return null;
      return { pid: "mister", num: "", nome: a.nome || "", cognome: a.cognome || a.nome, mister: true };
    }
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
      ricorda();
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
        // l'allenatore in panchina: fuori dal campo, sulla sua meta'
        var mis = misterDi(lato);
        // non attaccato al bordo: sotto la pedina ci va il cognome
        if (mis) metti(lato, mis, lato === "A" ? 150 : W - 150, H - 78);
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
      if (b.dataset.az === "indietro") annulla();
      if (b.dataset.az === "pulisci") { ricorda(); gDis.innerHTML = ""; }
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
                     rosa: s.rosa || [], titolari: s.titolari || [], mod: s.mod || SQ[lato].mod,
                     all: s.all || null };
      });
      PEDINE.slice().forEach(togli);
      CAMBI = [];
      disegnaRose(); disegnaCurio();
      if (d && d.schiera !== false) schiera();
    }
    function stato() {
      return { sq: { A: SQ.A, B: SQ.B }, note: NOTE, cambi: CAMBI, disegni: gDis.innerHTML,
               pedine: PEDINE.map(function (p) { return { lato: p.lato, pid: p.pid, num: p.num, cognome: p.cognome,
                                                          mister: !!p.mister, x: p.x, y: p.y }; }) };
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

    // ── LA DIRETTA ──────────────────────────────────────────────────────
    // ESPN non pubblica il tracciamento dei giocatori: nessuno lo fa
    // gratis. Pubblica pero' ogni GIOCATA con le sue coordinate — passaggi,
    // contrasti, tiri — e da li' si ricava dove sta il pallone e chi lo sta
    // toccando. Il campetto quindi si muove davvero, col ritardo di ESPN
    // (circa un minuto) e a scatti di giocata, non a 25 fotogrammi.
    //
    // Le coordinate sono girate per chi attacca (x 100 = porta avversaria,
    // y 100 = la sua sinistra): qui si rimettono sul campo vero, dove la
    // squadra di casa attacca verso destra.
    var DIR = null, gPalla = null;
    function pallaEl() {
      if (gPalla && gPalla.parentNode) return gPalla;
      gPalla = ns("g", { "class": "palla", style: "transition:transform .45s cubic-bezier(.3,.8,.4,1)" }, gPedine);
      ns("circle", { cx: 0, cy: 0, r: 15, fill: "#F5F1E6", stroke: "#06301A", "stroke-width": 3 }, gPalla);
      ns("circle", { cx: 0, cy: 0, r: 5.5, fill: "#0A0F24" }, gPalla);
      return gPalla;
    }
    function postoDi(x, y, casa) {
      // casa attacca verso destra; l'ospite ha tutto specchiato
      var X = casa ? x / 100 * W : (1 - x / 100) * W;
      var Y = casa ? (1 - y / 100) * H : y / 100 * H;
      return { x: Math.max(12, Math.min(W - 12, X)), y: Math.max(12, Math.min(H - 12, Y)) };
    }
    function accendi(idAtleta) {
      PEDINE.forEach(function (p) {
        var c = p.g.querySelector(".disco");
        if (!c) return;
        var mio = idAtleta && String(p.pid) === String(idAtleta);
        c.setAttribute("stroke", mio ? "#F5B91E" : (p === SCELTO ? "#E3C271" : (p.mister ? "#E3C271" : "#F5F1E6")));
        c.setAttribute("stroke-width", mio ? 7 : (p === SCELTO ? 6 : 3));
      });
    }
    function striscia(t) {
      var d = box.querySelector("[data-diretta]");
      if (!t) { d.style.display = "none"; d.innerHTML = ""; return; }
      d.style.display = "flex";
      d.innerHTML = t;
    }
    function giocateDi(lega, ev) {
      var base = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/" + lega +
                 "/events/" + ev + "/competitions/" + ev + "/plays?limit=1000";
      return fetch(base).then(function (r) { return r.json(); }).then(function (j) {
        if ((j.pageCount || 1) < 2) return j.items || [];
        return fetch(base + "&page=" + j.pageCount).then(function (r) { return r.json(); })
          .then(function (k) { return k.items || []; });
      });
    }
    function seguiPartita(opz) {
      fermaPartita();
      DIR = { lega: opz.lega, ev: opz.event, casa: opz.casa || "", visti: {}, coda: [], vistiEventi: {} };
      striscia('<b>Diretta</b> <span class="azione">mi collego…</span>');
      giro();
      DIR.timer = setInterval(giro, 15000);
      // le giocate in coda si consumano piano, cosi' il pallone si muove
      DIR.passo = setInterval(function () {
        if (!DIR || !DIR.coda.length) return;
        var g = DIR.coda.shift();
        var q = postoDi(g.x, g.y, g.casa);
        pallaEl().style.transform = "translate(" + Math.round(q.x) + "px," + Math.round(q.y) + "px)";
        accendi(g.atleta);
        striscia('<b>Diretta</b> <span class="punteggio">' + esc(DIR.punteggio || "") + '</span>' +
                 '<span>' + esc(DIR.minuto || "") + "</span>" +
                 '<span class="azione">' + esc(g.testo || "") + "</span>" +
                 '<button type="button" data-az="fermaDiretta">Stacca</button>');
      }, 900);
    }
    function fermaPartita() {
      if (!DIR) return;
      clearInterval(DIR.timer); clearInterval(DIR.passo);
      DIR = null; striscia("");
      accendi(null);
      if (gPalla && gPalla.parentNode) { gPalla.parentNode.removeChild(gPalla); gPalla = null; }
    }
    function giro() {
      if (!DIR) return;
      var D = DIR;
      fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + D.lega + "/summary?event=" + D.ev)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (DIR !== D) return;
          var c = ((j.header || {}).competitions || [])[0] || {};
          var chi = c.competitors || [];
          var casa = chi.filter(function (x) { return x.homeAway === "home"; })[0] || {};
          var osp = chi.filter(function (x) { return x.homeAway === "away"; })[0] || {};
          D.casaId = String((casa.team || {}).id || "");
          D.punteggio = ((casa.team || {}).shortDisplayName || "") + " " + (casa.score || 0) + " - " +
                        (osp.score || 0) + " " + ((osp.team || {}).shortDisplayName || "");
          D.minuto = ((c.status || {}).type || {}).detail || "";
          // i cambi di ESPN diventano i nostri, una volta sola ciascuno
          (j.keyEvents || []).forEach(function (e) {
            var k = e.id || ((e.clock || {}).displayValue + (e.type || {}).text + ((e.athletesInvolved || [])[0] || {}).id);
            if (D.vistiEventi[k]) return;
            D.vistiEventi[k] = 1;
            if (!/substitution/i.test((e.type || {}).text || "")) return;
            var lato = String(((e.team || {}).id || "")) === D.casaId ? "A" : "B";
            var dentro = (e.athletesInvolved || [])[0], fuori = (e.athletesInvolved || [])[1];
            if (!dentro || !fuori) return;
            var p = inCampo(lato, String(fuori.id));
            var g = { pid: String(dentro.id), num: dentro.jersey || "", nome: "",
                      cognome: (dentro.displayName || "").split(" ").pop() };
            CAMBI.push({ lato: lato, dentro: (g.num ? g.num + " " : "") + g.cognome,
                         fuori: (fuori.jersey ? fuori.jersey + " " : "") + (fuori.displayName || "").split(" ").pop() });
            if (p) { var x = p.x, y = p.y; togli(p); metti(lato, g, x, y); }
            disegnaRose(); disegnaCurio();
          });
        })
        .catch(function () {});
      giocateDi(D.lega, D.ev).then(function (tutte) {
        if (DIR !== D) return;
        var nuove = tutte.filter(function (g) {
          return g.id && !D.visti[g.id] && g.fieldPositionX != null && g.fieldPositionY != null;
        });
        nuove.forEach(function (g) { D.visti[g.id] = 1; });
        // al primo giro si parte dall'ultima, non da tutta la partita
        if (!D.partito) { D.partito = 1; nuove = nuove.slice(-1); }
        nuove.forEach(function (g) {
          var idSq = ((g.team || {}).$ref || "").match(/teams\/(\d+)/);
          var atl = ((((g.participants || [])[0] || {}).athlete || {}).$ref || "").match(/athletes\/(\d+)/);
          D.coda.push({ x: g.fieldPositionX, y: g.fieldPositionY,
                        casa: idSq ? idSq[1] === D.casaId : true,
                        atleta: atl ? atl[1] : "",
                        testo: ((g.clock || {}).displayValue || "") + " · " + (g.text || (g.type || {}).text || "") });
        });
        if (D.coda.length > 40) D.coda = D.coda.slice(-40);
      }).catch(function () {});
    }
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-az="fermaDiretta"]') : null;
      if (b) fermaPartita();
    });

    // ── scegliere la partita da seguire ─────────────────────────────────
    var selC = box.querySelector('[data-d="comp"]'), selP = box.querySelector('[data-d="part"]');
    function dnota(t) { var n = box.querySelector("[data-dnota]"); if (n) n.innerHTML = t; }
    if (selC) {
      if (window.CompetizioniEspn) CompetizioniEspn.riempi(selC);
      selC.addEventListener("change", function () {
        selP.innerHTML = '<option value="">—</option>'; selP.disabled = true;
        box.querySelector('[data-az="segui"]').disabled = true;
        if (!this.value) return;
        var d = new Date();
        var g = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
        dnota("Cerco le partite di oggi&hellip;");
        fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + this.value + "/scoreboard?dates=" + g)
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var ev = (j.events || []).map(function (e) {
              var st = ((e.competitions[0] || {}).status || {}).type || {};
              return { id: e.id, nome: e.name, stato: st.detail || "", viva: st.state === "in" };
            });
            selP.innerHTML = ev.length
              ? '<option value="">— ' + ev.length + " oggi —</option>" + ev.map(function (x) {
                  return '<option value="' + esc(x.id) + '">' + (x.viva ? "\u25CF " : "") + esc(x.nome) + " · " + esc(x.stato) + "</option>";
                }).join("")
              : '<option value="">— oggi niente —</option>';
            selP.disabled = !ev.length;
            dnota(ev.length ? "Scegli la partita e premi <b>Segui</b>." : "Oggi in questa competizione non si gioca.");
          })
          .catch(function () { dnota("ESPN non risponde."); });
      });
      selP.addEventListener("change", function () {
        box.querySelector('[data-az="segui"]').disabled = !this.value;
      });
      box.addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-az="segui"]') : null;
        if (!b) return;
        var lega = selC.value, id = selP.value;
        if (!lega || !id) return;
        dnota("Prendo le formazioni&hellip;");
        fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + lega + "/summary?event=" + id)
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var c = ((j.header || {}).competitions || [])[0] || {}, chi = c.competitors || [];
            var casa = chi.filter(function (x) { return x.homeAway === "home"; })[0] || {};
            var osp = chi.filter(function (x) { return x.homeAway === "away"; })[0] || {};
            function undici(idSq) {
              var r = (j.rosters || []).filter(function (x) { return String((x.team || {}).id) === String(idSq); })[0];
              return ((r || {}).roster || []).map(function (x) {
                var a = x.athlete || {};
                return { pid: String(a.id), num: x.jersey || a.jersey || "", nome: "",
                         cognome: (a.displayName || "").split(" ").pop(), titolare: !!x.starter };
              });
            }
            var rA = undici((casa.team || {}).id), rB = undici((osp.team || {}).id);
            // i colori delle due squadre li dice ESPN: se sono troppo simili
            // (due squadre in blu) al secondo si da' il suo colore di riserva
            function tinta(t, dif) {
              var c = "#" + String((t || {}).color || "").replace("#", "");
              if (c.length !== 7) c = dif;
              return c;
            }
            var cA = tinta(casa.team, "#2E6BE6"), cB = tinta(osp.team, "#E0312B");
            if (cA.toLowerCase() === cB.toLowerCase()) cB = "#" + (String((osp.team || {}).alternateColor || "").replace("#", "") || "E0312B");
            if (rA.length || rB.length) {
              ricorda();
              carica({
                A: { nome: (casa.team || {}).displayName || "Casa", col: cA, rosa: rA,
                     titolari: rA.filter(function (x) { return x.titolare; }), mod: SQ.A.mod, all: SQ.A.all },
                B: { nome: (osp.team || {}).displayName || "Ospite", col: cB, rosa: rB,
                     titolari: rB.filter(function (x) { return x.titolare; }), mod: SQ.B.mod, all: SQ.B.all }
              });
            }
            seguiPartita({ lega: lega, event: id });
            dnota("In diretta. <b>Stacca</b> per fermare.");
          })
          .catch(function () { dnota("Partita non caricata."); });
      });
    }

    // Cmd/Ctrl+Z ovunque nella pagina, ma non mentre si scrive una
    // curiosita': li' l'annullamento e' quello del testo.
    document.addEventListener("keydown", function (ev) {
      if (!(ev.metaKey || ev.ctrlKey) || String(ev.key).toLowerCase() !== "z") return;
      if (!box.isConnected || !box.offsetParent) return;
      var t = ev.target, tag = t && t.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || (t && t.isContentEditable)) return;
      ev.preventDefault();
      if (ev.shiftKey) rifai(); else annulla();
    });

    disegnaRose(); disegnaCurio();
    return { carica: carica, stato: stato, riapri: riapri, schiera: schiera, nota: nota,
             annulla: annulla, rifai: rifai, segui: seguiPartita, stacca: fermaPartita,
             barraSalva: box.querySelector("[data-salva]"), moduli: Object.keys(MODULI) };
  }

  return { monta: monta, moduli: Object.keys(MODULI) };
})();
