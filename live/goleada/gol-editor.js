/**
 * GOLEADA — la logica comune delle pagine editor.
 *
 * Ogni grafica del format ha la sua pagina (goleada-tabellone.html,
 * goleada-10challenge.html…), la vetrina e' goleada.html. Le pagine dichiarano
 * cosa sono in window.GOL_PAGINA e il ponte in window.GOL_PONTE; il modulo lo
 * costruisce questo file dentro #corpo.
 *
 * I giochi vanno in onda a passi (la domanda, la prima risposta, la seconda…):
 * ogni passo e' una grafica. Dalla pagina si manda in regia il passo scelto,
 * oppure tutta la sequenza in una volta, gia' in ordine.
 *
 * Quello che si scrive resta su questo computer (localStorage), un archivio
 * per gioco: 10 Challenge e Bonus condividono lo stesso, come Mister X e la
 * sua rivelazione.
 */
(function () {
  "use strict";

  // Il ponte lo scrive la pagina: sulla VM l'indirizzo viene riscritto solo
  // dentro i file .html, un .js restera' sempre con quello di GitHub.
  var PONTE = window.GOL_PONTE;
  var PAGINA = window.GOL_PAGINA || { g: "tabellone", nome: "Tabellone" };
  var TOKEN = (window.ChiaveComoTV ? ChiaveComoTV.valore() : "");
  var BASEIMG = PONTE.replace(/\/(api|exec)$/, "");
  if (window.Destinazione) Destinazione.adotta(document.getElementById("canaleSel"), PONTE, TOKEN);

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function b64url(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function stato(cls, txt) { $("stato").innerHTML = '<span class="' + cls + '">' + txt + "</span>"; }
  function leggiLS(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function scriviLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function pieno(s) { return String(s == null ? "" : s).trim() !== ""; }
  function lista(n, fn) { var a = []; for (var i = 0; i < n; i++) a.push(fn(i)); return a; }

  // ── i giochi ────────────────────────────────────────────────────────
  var ETI_X = ["Età", "Nato a", "Nazionalità", "Ruolo", "Squadra"];
  var GIOCHI = {
    tabellone:     { tipo: "gol-tabellone",   motore: "gol-tabellone-vmix.html", archivio: "tabellone", titolo: "Tabellone" },
    "10challenge": { tipo: "gol-10challenge", motore: "gol-10challenge-vmix.html", archivio: "10challenge", titolo: "10 Challenge", alpha: true },
    bonus:         { tipo: "gol-bonus",       motore: "gol-bonus-vmix.html", archivio: "10challenge", titolo: "10 Challenge Bonus", alpha: true, foto: [788, 745] },
    eleven:        { tipo: "gol-eleven",      motore: "gol-eleven-vmix.html", archivio: "eleven", titolo: "Eleven", alpha: true },
    misterx:       { tipo: "gol-misterx",     motore: "gol-misterx-vmix.html", archivio: "misterx", titolo: "Mister X", alpha: true },
    rivela:        { tipo: "gol-rivela",      motore: "gol-rivela-vmix.html", archivio: "misterx", titolo: "Mister X", foto: [738, 648] }
  };
  var G = GIOCHI[PAGINA.g] || GIOCHI.tabellone;
  var VUOTI = {
    tabellone: function () { return { p: "", a: "", b: "", ea: 0, eb: 0, u: "" }; },
    "10challenge": function () { return { r: lista(10, function () { return ["", ""]; }), bonus: { n: "", num: "", f: null } }; },
    eleven: function () { return { sel: 0, q: lista(11, function () { return { q: "", a: ["", "", ""], w: -1 }; }) }; },
    misterx: function () {
      return { sel: 0, x: lista(7, function () {
        return { i: ["", "", "", "", ""], n: "", c: ETI_X.map(function (e) { return [e, ""]; }), f: null };
      }) };
    }
  };
  var CHIAVE = "comotv.gol." + G.archivio;
  var A = leggiLS(CHIAVE);
  // un archivio vecchio o rovinato non deve rompere la pagina
  (function () {
    var base = VUOTI[G.archivio]();
    if (!A || typeof A !== "object") { A = base; return; }
    for (var k in base) if (A[k] == null) A[k] = base[k];
    if (G.archivio === "10challenge") { while (A.r.length < 10) A.r.push(["", ""]); }
    if (G.archivio === "eleven") { while (A.q.length < 11) A.q.push(VUOTI.eleven().q[0]); }
    if (G.archivio === "misterx") { while (A.x.length < 7) A.x.push(VUOTI.misterx().x[0]); }
  })();
  function salva() { scriviLS(CHIAVE, A); }
  // tabellone: la spunta "manda subito" sopravvive al ridisegno del modulo
  var SUBITO = false;

  // ── i moduli, uno per gioco ─────────────────────────────────────────
  function schede(n, sel, nomeDi, pienaSe) {
    return '<div class="schede" id="schede">' + lista(n, function (i) {
      return '<button type="button" data-scheda="' + i + '" class="' + (i === sel ? "on " : "") + (pienaSe(i) ? "piena" : "") + '">' + esc(nomeDi(i)) + "</button>";
    }).join("") + "</div>";
  }
  function pannelloFoto(titolo) {
    return '<div class="panel"><h2>Foto <small>' + esc(titolo) + '</small></h2>' +
      '<div class="riga"><div style="flex:0 0 auto"><button type="button" id="fbtn">Carica la foto</button> ' +
      '<button type="button" id="fmag">&#128444;&#65039; Da archivio</button><input type="file" id="ffile" accept="image/*" hidden></div></div>' +
      '<div class="fedit" id="fedit" hidden><div class="frett" id="fc"><img id="fimg" draggable="false" alt=""></div>' +
      '<div class="fcomandi"><label>Trascina per inquadrare, ingrandisci col cursore</label>' +
      '<input type="range" id="fz" min="100" max="320" value="100">' +
      '<button type="button" class="via" id="ftogli" style="align-self:flex-start">Togli la foto</button></div></div></div>';
  }

  var MODULI = {
    tabellone: function () {
      function x(n) { return lista(3, function (i) { return '<i class="' + (i < n ? "on" : "") + '">X</i>'; }).join(""); }
      return '<div class="panel"><h2>La puntata</h2><div class="riga">' +
        '<div style="flex:0 0 140px"><label for="tP">Puntata</label><input type="text" id="tP" data-campo="p" value="' + esc(A.p) + '" placeholder="29"></div>' +
        '<div><label for="tA">Concorrente a sinistra</label><input type="text" id="tA" data-campo="a" value="' + esc(A.a) + '" placeholder="Simo"></div>' +
        '<div><label for="tB">Concorrente a destra</label><input type="text" id="tB" data-campo="b" value="' + esc(A.b) + '" placeholder="Andrea"></div>' +
        "</div></div>" +
        '<div class="due">' + ["a", "b"].map(function (chi) {
          var n = chi === "a" ? A.ea : A.eb;
          return '<div class="panel"><h2>Errori · ' + esc(chi === "a" ? (A.a || "sinistra") : (A.b || "destra")) + '</h2>' +
            '<div class="contatore"><div class="x">' + x(n) + '</div>' +
            '<button type="button" data-errore="' + chi + '" data-quanto="1">+ Errore</button>' +
            '<button type="button" class="via" data-errore="' + chi + '" data-quanto="-1">Togli</button></div></div>';
        }).join("") + "</div>" +
        '<div class="panel"><label class="spunta"><input type="checkbox" id="tSubito"' + (SUBITO ? " checked" : "") + '> A ogni errore manda subito il tabellone in regia</label>' +
        '<div class="riga" style="margin-top:8px"><div style="flex:0 0 auto"><button type="button" class="via" id="tAzzera">Azzera gli errori</button></div></div>' +
        '<div class="nota">La X appena aggiunta entra col colpo; le altre sono ferme.</div></div>';
    },
    "10challenge": function () {
      return '<div class="panel"><h2>Le dieci risposte <small>dall\'alto in basso, nell\'ordine in cui escono</small></h2>' +
        A.r.map(function (r, i) {
          return '<div class="rispo"><span class="n">' + (i + 1) + '</span><input type="text" data-riga="' + i + '" data-col="0" value="' + esc(r[0]) + '" placeholder="Nome">' +
            '<input type="text" data-riga="' + i + '" data-col="1" value="' + esc(r[1]) + '" placeholder="N." style="width:90px"></div>';
        }).join("") +
        '<div class="riga" style="margin-top:12px"><div style="flex:0 0 auto"><button type="button" class="via" id="svuota">Svuota le risposte</button></div></div></div>' +
        '<div class="panel"><h2>Incolla l\'elenco <small>una riga per risposta: nome e numero (anche da Excel)</small></h2>' +
        '<textarea id="incolla" placeholder="Gabriel Barbosa 31&#10;Pedro 28&#10;…"></textarea>' +
        '<div class="riga" style="margin-top:8px"><div style="flex:0 0 auto"><button type="button" id="btnIncolla">Riempi le righe</button></div></div></div>';
    },
    bonus: function () {
      return '<div class="due"><div><div class="panel"><h2>Il bonus</h2><div class="riga">' +
        '<div><label for="bN">Nome</label><input type="text" id="bN" data-bonus="n" value="' + esc(A.bonus.n) + '" placeholder="Hulk"></div>' +
        '<div style="flex:0 0 140px"><label for="bNum">Numero</label><input type="text" id="bNum" data-bonus="num" value="' + esc(A.bonus.num) + '" placeholder="16"></div>' +
        "</div></div></div><div>" + pannelloFoto("la card del bonus") + "</div></div>";
    },
    eleven: function () {
      var q = A.q[A.sel];
      return '<div class="panel"><h2>Le domande <small>undici, una scheda per domanda</small></h2>' +
        schede(11, A.sel, function (i) { return "D" + (i + 1); }, function (i) { return pieno(A.q[i].q); }) +
        '<label for="eQ">Domanda</label><textarea id="eQ" data-dom="q" placeholder="Chi ha raggiunto la finale…?">' + esc(q.q) + "</textarea>" +
        '<div style="margin-top:12px">' + q.a.map(function (t, i) {
          return '<div class="rispo"><span class="n">' + (i + 1) + '</span><input type="text" data-risp="' + i + '" value="' + esc(t) + '" placeholder="Risposta ' + (i + 1) + '">' +
            '<label class="giusta"><input type="radio" name="giusta" value="' + i + '"' + (q.w === i ? " checked" : "") + "> giusta</label></div>";
        }).join("") + "</div>" +
        '<div class="nota">Sequenza: la domanda con le caselle vuote, le tre risposte una alla volta, poi la giusta che si accende.</div></div>';
    },
    misterx: function () {
      var x = A.x[A.sel];
      return '<div class="panel"><h2>I Mister X <small>una scheda per giocatore — nome e foto nella pagina della rivelazione</small></h2>' +
        schede(7, A.sel, function (i) { return A.x[i].n || "X" + (i + 1); }, function (i) { return A.x[i].i.some(pieno); }) +
        x.i.map(function (t, i) {
          return '<div class="rispo"><span class="n">' + (i + 1) + '</span><input type="text" data-indizio="' + i + '" value="' + esc(t) + '" placeholder="' +
            ["Sono colombiano", "Gioco nel Crystal Palace", "Sono un terzino destro", "Il 2 è il mio numero di maglia", "Sono nato il 26 maggio 1996"][i] + '"><span></span></div>';
        }).join("") +
        '<div class="nota">I primi due indizi escono sopra, gli altri tre sotto. Sequenza: un indizio alla volta.</div></div>';
    },
    rivela: function () {
      var x = A.x[A.sel];
      return '<div class="panel"><h2>I Mister X <small>una scheda per giocatore — gli indizi nella pagina Mister X</small></h2>' +
        schede(7, A.sel, function (i) { return A.x[i].n || "X" + (i + 1); }, function (i) { return pieno(A.x[i].n); }) +
        '<div class="due"><div><div class="riga"><div><label for="xN">Nome e cognome</label><input type="text" id="xN" data-x="n" value="' + esc(x.n) + '" placeholder="Daniel Muñoz"></div></div>' +
        x.c.map(function (r, i) {
          return '<div class="coppia"><input type="text" class="eti" data-carta="' + i + '" data-col="0" value="' + esc(r[0]) + '">' +
            '<input type="text" class="val" data-carta="' + i + '" data-col="1" value="' + esc(r[1]) + '"></div>';
        }).join("") + "</div><div>" + pannelloFoto("la foto della rivelazione") + "</div></div></div>";
    }
  };

  function disegna() {
    $("corpo").innerHTML = MODULI[PAGINA.g]();
    if (G.foto) montaFoto();
    riempiPassi();
  }

  // ── le modifiche: tutto finisce nell'archivio ───────────────────────
  $("corpo").addEventListener("input", function (e) {
    var t = e.target, d = t.dataset;
    if (d.campo) A[d.campo] = t.value;
    else if (d.riga != null) A.r[+d.riga][+d.col] = t.value;
    else if (d.bonus) A.bonus[d.bonus] = t.value;
    else if (d.dom) A.q[A.sel].q = t.value;
    else if (d.risp != null) A.q[A.sel].a[+d.risp] = t.value;
    else if (d.indizio != null) A.x[A.sel].i[+d.indizio] = t.value;
    else if (d.x) A.x[A.sel][d.x] = t.value;
    else if (d.carta != null) A.x[A.sel].c[+d.carta][+d.col] = t.value;
    else return;
    salva(); riempiPassi();
  });
  $("corpo").addEventListener("change", function (e) {
    if (e.target.id === "tSubito") { SUBITO = e.target.checked; return; }
    if (e.target.name === "giusta") { A.q[A.sel].w = +e.target.value; salva(); riempiPassi(); }
  });
  $("corpo").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.scheda != null) { A.sel = +b.dataset.scheda; salva(); disegna(); return; }
    if (b.dataset.errore) {
      var chi = b.dataset.errore, k = chi === "a" ? "ea" : "eb", prima = A[k];
      A[k] = Math.max(0, Math.min(3, A[k] + (+b.dataset.quanto)));
      A.u = A[k] > prima ? chi : "";
      salva(); disegna();
      if ($("prevwrap").style.display !== "none") anteprima();
      if (A[k] > prima && SUBITO) invia([passi()[0]]);
      return;
    }
    if (b.id === "tAzzera") { A.ea = 0; A.eb = 0; A.u = ""; salva(); disegna(); return; }
    if (b.id === "svuota") {
      if (!window.confirm("Svuoto le dieci risposte?")) return;
      A.r = lista(10, function () { return ["", ""]; }); salva(); disegna(); return;
    }
    if (b.id === "btnIncolla") {
      var righe = $("incolla").value.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 10);
      if (!righe.length) return;
      A.r = lista(10, function (i) {
        var l = righe[i] || "", m = l.match(/^(.*?)[\s;,\t]+(\d{1,4})\s*$/);
        return m ? [m[1].trim(), m[2]] : [l, ""];
      });
      salva(); disegna(); stato("ok", righe.length + " righe riempite.");
    }
  });

  // ── i passi della sequenza ──────────────────────────────────────────
  function passi() {
    var g = PAGINA.g, out = [];
    if (g === "tabellone") {
      out.push({ nome: (A.a || "?") + " " + A.ea + " – " + A.eb + " " + (A.b || "?"),
                 d: { p: A.p.trim(), a: A.a.trim(), b: A.b.trim(), ea: A.ea, eb: A.eb, u: A.u || undefined } });
    } else if (g === "10challenge") {
      var ultima = -1;
      A.r.forEach(function (r, i) { if (pieno(r[0])) ultima = i; });
      var r = A.r.slice(0, ultima + 1).map(function (x) { return [x[0].trim(), x[1].trim()]; });
      r.forEach(function (x, i) { out.push({ nome: (i + 1) + "/" + r.length + " · " + (x[0] || "—"), d: { r: r, k: i + 1 } }); });
    } else if (g === "bonus") {
      if (pieno(A.bonus.n) || A.bonus.f) out.push({ nome: A.bonus.n || "Bonus", d: { n: A.bonus.n.trim(), num: A.bonus.num.trim(), f: A.bonus.f || undefined } });
    } else if (g === "eleven") {
      var q = A.q[A.sel], risp = q.a.map(function (t) { return t.trim(); });
      if (pieno(q.q)) {
        var base = { q: q.q.trim(), a: risp }, tit = "D" + (A.sel + 1);
        out.push({ nome: tit + " · domanda", d: Object.assign({ k: 0 }, base) });
        [1, 2, 3].forEach(function (k) { if (pieno(risp[k - 1])) out.push({ nome: tit + " · risposta " + k, d: Object.assign({ k: k }, base) }); });
        if (q.w >= 0 && risp.every(pieno)) out.push({ nome: tit + " · giusta: " + risp[q.w], d: Object.assign({ k: 3, w: q.w }, base) });
      }
    } else if (g === "misterx") {
      var x = A.x[A.sel], ind = x.i.map(function (t) { return t.trim(); }).filter(Boolean);
      ind.forEach(function (t, i) { out.push({ nome: (x.n || "X" + (A.sel + 1)) + " · indizio " + (i + 1), d: { i: ind, k: i + 1 } }); });
    } else if (g === "rivela") {
      var y = A.x[A.sel];
      if (pieno(y.n)) out.push({ nome: y.n.trim(), d: { n: y.n.trim(), c: y.c.filter(function (r) { return pieno(r[0]) && pieno(r[1]); }).map(function (r) { return [r[0].trim(), r[1].trim()]; }), f: y.f || undefined } });
    }
    return out;
  }
  function riempiPassi() {
    var p = passi(), sel = $("passoSel"), prima = sel.value;
    sel.innerHTML = p.length ? p.map(function (x, i) { return '<option value="' + i + '">' + esc(x.nome) + "</option>"; }).join("")
                             : '<option value="">— niente da mandare —</option>';
    if (prima !== "" && +prima < p.length) sel.value = prima;
    var serie = p.length > 1;
    $("btnSerie").hidden = !serie;
    $("btnSerie").textContent = "Invia tutta la sequenza (" + p.length + ")";
    $("campoPasso").hidden = !(serie || PAGINA.g === "10challenge" || PAGINA.g === "eleven" || PAGINA.g === "misterx");
  }
  $("passoSel").addEventListener("change", function () { if ($("prevwrap").style.display !== "none") anteprima(); });

  // ── la foto (bonus e rivelazione) ───────────────────────────────────
  var FOTO = null, W_ED = 240, H_ED = 228;
  function dove() { return PAGINA.g === "bonus" ? A.bonus : A.x[A.sel]; }
  function montaFoto() {
    H_ED = Math.round(W_ED * G.foto[1] / G.foto[0]);
    $("fc").style.height = H_ED + "px";
    FOTO = null;
    if (dove().f) caricaFoto(dove().f, false);
    $("fbtn").addEventListener("click", function () { $("ffile").click(); });
    $("ffile").addEventListener("change", function () {
      if (!this.files || !this.files[0]) return;
      var r = new FileReader(); r.onload = function () { caricaFoto(r.result, true); }; r.readAsDataURL(this.files[0]);
    });
    $("ftogli").addEventListener("click", function () { FOTO = null; $("fedit").hidden = true; dove().f = null; salva(); riempiPassi(); });
    $("fz").addEventListener("input", function () { if (FOTO) { FOTO.z = this.value / 100; FOTO.sporca = true; fotoDisegna(); } });
    $("fc").addEventListener("pointerdown", function (e) {
      if (!FOTO) return; trascina = { x: e.clientX, y: e.clientY };
      this.setPointerCapture && this.setPointerCapture(e.pointerId); e.preventDefault();
    });
    if (window.SceltaFoto) {
      $("fmag").addEventListener("click", function () {
        SceltaFoto.apri(function (url) { caricaFoto(url, false); dove().f = url; salva(); riempiPassi(); });
      });
    }
  }
  var trascina = null;
  document.addEventListener("pointermove", function (e) {
    if (!trascina || !FOTO) return;
    FOTO.ox += e.clientX - trascina.x; FOTO.oy += e.clientY - trascina.y; FOTO.sporca = true;
    trascina.x = e.clientX; trascina.y = e.clientY; fotoDisegna();
  });
  document.addEventListener("pointerup", function () { trascina = null; });
  function fotoDisegna() {
    var f = FOTO, im = $("fimg");
    if (!f || !im) return;
    var base = Math.max(W_ED / f.img.naturalWidth, H_ED / f.img.naturalHeight), sc = base * f.z;
    var w = f.img.naturalWidth * sc, h = f.img.naturalHeight * sc;
    f.ox = Math.max(-(w - W_ED) / 2, Math.min((w - W_ED) / 2, f.ox));
    f.oy = Math.max(-(h - H_ED) / 2, Math.min((h - H_ED) / 2, f.oy));
    im.style.width = w + "px"; im.style.height = h + "px";
    im.style.left = (W_ED / 2 - w / 2 + f.ox) + "px"; im.style.top = (H_ED / 2 - h / 2 + f.oy) + "px";
  }
  function caricaFoto(src, sporca) {
    var img = new Image();
    img.onload = function () {
      FOTO = { img: img, ox: 0, oy: 0, z: 1, sporca: sporca };
      if (!$("fedit")) return;
      $("fedit").hidden = false; $("fimg").src = src; $("fz").value = 100; fotoDisegna();
    };
    img.src = src;
  }
  function fotoCotta() {
    var f = FOTO, W = G.foto[0], H = G.foto[1], F = W / W_ED;
    var base = Math.max(W_ED / f.img.naturalWidth, H_ED / f.img.naturalHeight), sc = base * f.z;
    var tela = document.createElement("canvas"); tela.width = W; tela.height = H;
    tela.getContext("2d").drawImage(f.img, (W_ED / 2 - f.img.naturalWidth * sc / 2 + f.ox) * F, (H_ED / 2 - f.img.naturalHeight * sc / 2 + f.oy) * F,
                                    f.img.naturalWidth * sc * F, f.img.naturalHeight * sc * F);
    return tela.toDataURL("image/jpeg", 0.86);
  }
  // la foto spostata o nuova si salva nel magazzino prima di andare in onda
  function assicuraFoto() {
    if (!G.foto || !FOTO || !FOTO.sporca) return Promise.resolve();
    var nome = "foto goleada " + (PAGINA.g === "bonus" ? "bonus " + (A.bonus.n || "") : "mister x " + (A.x[A.sel].n || ""));
    return fetch(PONTE, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
                          body: JSON.stringify({ token: TOKEN, tipo: "logo-carica", nome: nome.trim(), dati: fotoCotta() }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok || !res.url) throw new Error(res.errore || "salvataggio non riuscito");
        dove().f = BASEIMG + res.url + "?t=" + Date.now(); FOTO.sporca = false; salva(); riempiPassi();
      });
  }

  // ── anteprima e invio ───────────────────────────────────────────────
  function adattaPrev() { $("prev").style.transform = "scale(" + ($("prevbox").clientWidth / 1920) + ")"; }
  window.addEventListener("resize", adattaPrev);
  $("btnPrevChiudi").addEventListener("click", function () { $("prevwrap").style.display = "none"; $("prev").src = "about:blank"; });
  function scelto() { var p = passi(); return p[+$("passoSel").value] || p[p.length - 1]; }
  function anteprima() {
    stato("", "Preparo l'anteprima…");
    assicuraFoto().then(function () {
      var p = scelto();
      if (!p) { stato("err", "Non c'è ancora niente da mostrare: compila il gioco."); return; }
      $("prevwrap").style.display = "block";
      $("prev").src = G.motore + "?d=" + b64url(p.d) + "&n=" + Date.now();
      adattaPrev();
      stato("", "Anteprima: " + esc(p.nome) + ".");
    }).catch(function (e) { stato("err", "Foto non salvata: " + esc(e.message)); });
  }
  $("btnPrev").addEventListener("click", anteprima);

  function invia(elenco) {
    var dest = window.Destinazione ? Destinazione.dove() : "regia";
    var i = 0;
    $("stato").innerHTML = '<span>Invio a ' + dest + '&hellip;</span><span class="pbar"><span class="pfill" id="pfill"></span></span>';
    function prossimo() {
      if (i >= elenco.length) {
        var pf = $("pfill"); if (pf) pf.className = "pfill done";
        setTimeout(function () {
          stato("ok", (elenco.length > 1 ? elenco.length + " grafiche aggiunte" : "Aggiunta") + " a " + dest + ". Dalla regia le mandi in onda.");
        }, 350);
        return;
      }
      var p = elenco[i], titolo = elenco.length === 1 && p.titolo ? p.titolo : ("GOLEADA · " + G.titolo + " · " + p.nome).toUpperCase();
      fetch(PONTE, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({ token: TOKEN }, Destinazione.corpo({ grafica: G.tipo, titolo: titolo, dati: p.d })))
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res.ok) { stato("err", "Errore alla grafica " + (i + 1) + ": " + esc(res.errore || "sconosciuto")); return; }
          i++;
          if (elenco.length > 1) $("stato").firstChild.innerHTML = "Invio a " + dest + "… " + i + "/" + elenco.length;
          prossimo();
        })
        .catch(function () { stato("err", "Ponte non raggiungibile" + (i ? " dopo " + i + " grafiche." : ".")); });
    }
    prossimo();
  }
  $("btnRegia").addEventListener("click", function () {
    assicuraFoto().then(function () {
      var p = scelto();
      if (!p) { stato("err", "Non c'è ancora niente da mandare: compila il gioco."); return; }
      var proposta = ("GOLEADA · " + G.titolo + " · " + p.nome).toUpperCase();
      var titolo = window.prompt("Nome in scaletta di regia:", proposta);
      if (titolo === null) return;
      invia([Object.assign({}, p, { titolo: titolo.trim() || proposta })]);
    }).catch(function (e) { stato("err", "Foto non salvata: " + esc(e.message)); });
  });
  $("btnSerie").addEventListener("click", function () {
    var p = passi();
    if (p.length < 2) return;
    var dest = window.Destinazione ? Destinazione.dove() : "regia";
    if (!window.confirm("Mando " + p.length + " grafiche a " + dest + ", in ordine?")) return;
    invia(p);
  });

  // ── partenza ──
  if (window.SceltaFoto) SceltaFoto.adotta(PONTE, TOKEN);
  $("prevbox").className = G.alpha ? "trasparente" : "";
  disegna();
  adattaPrev();
})();
