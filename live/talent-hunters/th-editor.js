/**
 * TALENT HUNTERS — la logica comune delle pagine editor.
 *
 * Ogni grafica del format ha la sua pagina (th-carta.html, th-approved.html…),
 * come le altre grafiche del catalogo; la vetrina e' talent-hunters.html.
 * Le pagine dichiarano cosa sono in window.TH_PAGINA e il ponte in
 * window.TH_PONTE, poi caricano questo file.
 */
(function () {
  "use strict";

  // Il ponte lo scrive la pagina: sulla VM l'indirizzo viene riscritto solo
  // dentro i file .html, un .js restera' sempre con quello di GitHub.
  var PONTE = window.TH_PONTE;
  var PAGINA = window.TH_PAGINA || { g: "carta", nome: "Carta d'identità" };
  var TOKEN = (window.ChiaveComoTV ? ChiaveComoTV.valore() : "");
  var BASEIMG = PONTE.replace(/\/(api|exec)$/, "");
  if (window.Destinazione) Destinazione.adotta(document.getElementById("canaleSel"), PONTE, TOKEN);

  // Ogni pagina ha solo i campi della sua grafica. Quelli che mancano sono
  // campi finti, fuori dalla pagina: la logica resta una sola per tutte.
  var FINTI = {};
  function el(id) { return document.getElementById(id) || FINTI[id] || (FINTI[id] = document.createElement("input")); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function b64url(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function stato(cls, txt) { el("stato").innerHTML = '<span class="' + cls + '">' + txt + '</span>'; }
  function leggiLS(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function scriviLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ── le cinque grafiche ──────────────────────────────────────────────
  var GRAFICHE = {
    carta:    { nome: "Carta d'identità", tipo: "th-carta",    motore: "th-carta-vmix.html" },
    approved: { nome: "Approved",         tipo: "th-approved", motore: "th-approved-vmix.html" },
    heatmap:  { nome: "Heatmap",          tipo: "th-heatmap",  motore: "th-heatmap-vmix.html" },
    torta:    { nome: "Torta",            tipo: "th-torta",    motore: "th-torta-vmix.html", alpha: true },
    radar:    { nome: "Radar",            tipo: "th-radar",    motore: "th-radar-vmix.html", alpha: true }
  };
  var QUALE = PAGINA.g;
  // quello che decide la pagina: il timbro, l'evidenza, il confronto
  function prepara() {
    if (PAGINA.ok != null) el("aOk").value = PAGINA.ok ? "1" : "0";
    if (PAGINA.ev != null) el("hmEv").checked = !!PAGINA.ev;
    if (PAGINA.confronto != null) confronto(!!PAGINA.confronto);
  }

  // ── l'anagrafica: il CSV della redazione ────────────────────────────
  function leggiCsv(testo) {
    var righe = [], riga = [], campo = "", dentro = false;
    testo = String(testo || "").replace(/^﻿/, "");
    for (var i = 0; i < testo.length; i++) {
      var c = testo[i];
      if (dentro) {
        if (c === '"') { if (testo[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
        else campo += c;
      } else if (c === '"') dentro = true;
      else if (c === ",") { riga.push(campo); campo = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && testo[i + 1] === "\n") i++;
        riga.push(campo); campo = ""; righe.push(riga); riga = [];
      } else campo += c;
    }
    if (campo || riga.length) { riga.push(campo); righe.push(riga); }
    if (!righe.length) return [];
    // le colonne si riconoscono dal nome, non dalla posizione
    var test = righe.shift().map(function (h) { return h.trim().toUpperCase(); });
    function col(re) { for (var k = 0; k < test.length; k++) if (re.test(test[k])) return k; return -1; }
    var C = { ep: col(/EPISODIO/), sopr: col(/SOPRANNOME/), nome: col(/NOME COMPLETO/), nasc: col(/NASCITA/),
              naz: col(/NAZIONALIT/), sq: col(/SQUADRA/), ruolo: col(/RUOLO/), piede: col(/PIEDE/),
              alt: col(/ALTEZZA/), num: col(/MAGLIA/), val: col(/VALORE/), ok: col(/APPROVED/) };
    function v(r, k) { return k >= 0 ? String(r[k] || "").trim() : ""; }
    return righe.filter(function (r) { return v(r, C.nome); }).map(function (r) {
      return { ep: v(r, C.ep), sopr: v(r, C.sopr), nome: v(r, C.nome), nasc: v(r, C.nasc), naz: v(r, C.naz),
               sq: v(r, C.sq), ruolo: v(r, C.ruolo), piede: v(r, C.piede), alt: v(r, C.alt),
               num: v(r, C.num), val: v(r, C.val), ok: !/NOT/i.test(v(r, C.ok)) };
    });
  }
  var LS_CSV = "comotv.th.csv";
  var csvMio = leggiLS(LS_CSV);
  var ANAGRAFICA = leggiCsv(csvMio || window.TH_CSV || "");

  var MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  function data(s) {
    var m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (!m || +m[2] < 1 || +m[2] > 12) return s || "";
    return (+m[1]) + " " + MESI[+m[2] - 1] + (m[3] ? " " + m[3] : "");
  }
  function prima(s) { s = String(s || "").trim().toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }
  // "12 milioni" -> 12 M · "200mila euro" -> 200 K · "3,5 milioni" -> 3,5 M
  function valore(s) {
    var t = String(s || "").trim(), m = t.match(/^(\d+(?:[.,]\d+)?)\s*(milioni|milione|mln|m|mila|k)\b/i);
    if (m) return { val: m[1], u: /^mil(a)$|^k$/i.test(m[2]) ? "K" : "M" };
    return { val: t, u: "M" };
  }
  function chiave(nome) { return "comotv.th.g." + String(nome || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"); }

  function riempiElenco() {
    var h = '<option value="">— scegli —</option>', gruppi = { con: [], senza: [] };
    ANAGRAFICA.forEach(function (g, i) { (g.ep ? gruppi.con : gruppi.senza).push(i); });
    function voce(i) {
      var g = ANAGRAFICA[i];
      return '<option value="' + i + '">' + (g.ep ? "Ep. " + esc(g.ep) + " · " : "") + esc(g.nome) +
             (g.sopr ? " (" + esc(g.sopr) + ")" : "") + (g.sq ? " · " + esc(g.sq) : "") + "</option>";
    }
    if (gruppi.con.length) h += '<optgroup label="Puntate">' + gruppi.con.map(voce).join("") + "</optgroup>";
    if (gruppi.senza.length) h += '<optgroup label="Senza puntata">' + gruppi.senza.map(voce).join("") + "</optgroup>";
    h += '<option value="nuovo">+ Giocatore nuovo, a mano</option>';
    el("gSel").innerHTML = h;
    el("rSel2").innerHTML = '<option value="">—</option>' + ANAGRAFICA.map(function (g, i) {
      return '<option value="' + i + '">' + esc(g.nome) + "</option>"; }).join("");
    el("gNota").innerHTML = ANAGRAFICA.length + " giocatori " + (csvMio ? "dal <b>CSV caricato su questo computer</b>." : "dall'anagrafica della redazione.");
  }

  el("gCsv").addEventListener("click", function () { el("gCsvFile").click(); });
  el("gCsvFile").addEventListener("change", function () {
    var f = this.files && this.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      var lista = leggiCsv(r.result);
      if (!lista.length) { stato("err", "Nel CSV non trovo giocatori: serve la colonna NOME COMPLETO."); return; }
      csvMio = r.result; scriviLS(LS_CSV, csvMio); ANAGRAFICA = lista; riempiElenco();
      stato("ok", "Anagrafica aggiornata: " + lista.length + " giocatori.");
    };
    r.readAsText(f, "utf-8");
  });

  // ── cio' che si compila per giocatore, e che si ricorda ─────────────
  var ETICHETTE_CARTA = ["Data di nascita", "Nazionalità", "Ruolo", "Piede", "Altezza"];
  var TORTA_BASE = ["AERIAL DUEL %", "DUEL WON", "GOAL CONVERSION", "NXPG/SHOT", "EXPECTED ASSISTS", "KEY PASSES"];
  var RADAR_BASE = ["NPG", "npxG", "GOAL CONVERSION %", "AERIAL", "TOUCHES IN BOX", "XA", "OFF DUELS WON"];
  var LIV = ["#1B2452", "#2B568A", "#4F8FA8", "#C9A24B", "#F1DE9E"];   // come il motore
  var LIV_NOME = ["quasi mai", "poco", "a volte", "spesso", "sempre"];
  var ZONE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var FOTO = null, attuale = null;

  function rigaCarta(eti, val) {
    return '<div class="coppia"><input type="text" class="eti" value="' + esc(eti) + '"><input type="text" class="val" value="' + esc(val) + '"></div>';
  }
  function rigaTorta(eti, val) {
    return '<div class="coppia"><input type="text" class="eti" value="' + esc(eti) + '"><input type="number" class="num" min="0" max="100" value="' + esc(val) + '" placeholder="0-100">' +
           '<button type="button" class="via" data-via="1">&times;</button></div>';
  }
  function rigaRadar(eti, a, b) {
    return '<div class="coppia"><input type="text" class="eti" value="' + esc(eti) + '"><input type="number" class="num a" min="0" max="100" value="' + esc(a) + '" placeholder="oro">' +
           '<input type="number" class="num b" min="0" max="100" value="' + esc(b) + '" placeholder="avorio"' + (el("rConf").checked ? "" : " hidden") + '>' +
           '<button type="button" class="via" data-via="1">&times;</button></div>';
  }
  function disegnaZone() {
    el("hmCampo").innerHTML = ZONE.map(function (l, i) {
      return '<button type="button" data-z="' + i + '" style="background:' + LIV[l] + '" title="' + LIV_NOME[l] + '">' + l + "</button>";
    }).join("");
  }
  el("hmLegenda").innerHTML = LIV.map(function (c, i) { return '<span><i style="background:' + c + '"></i>' + i + " · " + LIV_NOME[i] + "</span>"; }).join("");
  el("hmCampo").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-z]"); if (!b) return;
    var i = +b.getAttribute("data-z");
    ZONE[i] = (ZONE[i] + (e.shiftKey ? 4 : 1)) % 5;
    disegnaZone(); ricorda();
  });

  function scegli(i) {
    var g = i === "nuovo" ? { nome: "", sopr: "", nasc: "", naz: "", ruolo: "", piede: "", alt: "", num: "", val: "", ok: true } : ANAGRAFICA[+i];
    if (!g) return;
    attuale = g;
    var salvato = leggiLS(chiave(g.nome)) || {};
    el("cNome").value = g.nome;
    el("cNum").value = g.num;
    var cognome = g.nome.trim().split(/\s+/).pop() || "";
    el("cSopr").value = g.sopr || cognome;
    el("aSopr").value = g.sopr || cognome;
    var valori = [data(g.nasc), g.naz, prima(g.ruolo), prima(g.piede), String(g.alt || "").replace(/\s*cm$/i, " cm")];
    el("cRighe").innerHTML = ETICHETTE_CARTA.map(function (e, k) { return rigaCarta(e, valori[k]); }).join("");
    var v = valore(g.val);
    el("aVal").value = v.val; el("aUnita").value = v.u; el("aOk").value = g.ok ? "1" : "0";
    // quello che non sta nel CSV torna com'era l'ultima volta per questo giocatore
    ZONE = (salvato.z && salvato.z.length === 12) ? salvato.z.slice() : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    disegnaZone();
    var t = (salvato.torta && salvato.torta.length >= 3) ? salvato.torta : TORTA_BASE.map(function (e) { return [e, ""]; });
    el("tRighe").innerHTML = t.map(function (x) { return rigaTorta(x[0], x[1]); }).join("");
    var r = (salvato.radar && salvato.radar.length >= 3) ? salvato.radar : RADAR_BASE.map(function (e) { return [e, "", ""]; });
    el("rRighe").innerHTML = r.map(function (x) { return rigaRadar(x[0], x[1], x[2]); }).join("");
    el("lUrl").value = salvato.logo || ""; disegnaStemma();
    el("fvid").value = salvato.video || "";
    if (salvato.foto) caricaFoto(salvato.foto, false); else togliFoto();
    prepara();
  }
  el("gSel").addEventListener("change", function () { if (this.value !== "") scegli(this.value); });

  // Si ricorda solo quello che questa pagina ha davvero: la pagina della
  // carta d'identita' non ha i valori della torta, e se li scrivesse li
  // cancellerebbe a chi li ha compilati nella pagina della torta.
  function ricorda() {
    if (!attuale || !el("cNome").value.trim()) return;
    var k = chiave(el("cNome").value.trim()), m = leggiLS(k) || {};
    function c(id) { return !!document.getElementById(id); }
    if (c("hmCampo")) m.z = ZONE;
    if (c("tRighe")) m.torta = righeTorta();
    if (c("rRighe")) m.radar = righeRadar(true);
    if (c("lUrl")) m.logo = el("lUrl").value.trim();
    if (c("fvid")) { m.video = el("fvid").value.trim(); m.foto = FOTO && FOTO.url && !FOTO.sporca ? FOTO.url : null; }
    scriviLS(k, m);
  }
  document.addEventListener("change", function (e) { if (e.target.closest(".panel")) ricorda(); });

  function righeTorta() {
    return [].map.call(document.querySelectorAll("#tRighe .coppia"), function (r) {
      return [r.querySelector(".eti").value.trim(), r.querySelector(".num").value];
    });
  }
  function righeRadar(tutte) {
    return [].map.call(document.querySelectorAll("#rRighe .coppia"), function (r) {
      return [r.querySelector(".eti").value.trim(), r.querySelector(".a").value, r.querySelector(".b").value];
    });
  }
  el("tAgg").addEventListener("click", function () {
    if (document.querySelectorAll("#tRighe .coppia").length >= 8) return;
    el("tRighe").insertAdjacentHTML("beforeend", rigaTorta("", ""));
  });
  el("rAgg").addEventListener("click", function () {
    if (document.querySelectorAll("#rRighe .coppia").length >= 10) return;
    el("rRighe").insertAdjacentHTML("beforeend", rigaRadar("", "", ""));
  });
  ["tRighe", "rRighe"].forEach(function (id) {
    el(id).addEventListener("click", function (e) {
      if (!e.target.closest("[data-via]")) return;
      if (el(id).querySelectorAll(".coppia").length <= 3) return;
      e.target.closest(".coppia").remove(); ricorda();
    });
  });
  function confronto(si) {
    el("rConf").checked = si;
    el("rConfNome").hidden = !si;
    document.querySelectorAll("#rRighe .b").forEach(function (b) { b.hidden = !si; });
  }
  el("rConf").addEventListener("change", function () { confronto(this.checked); });

  // ── la foto: editor con le proporzioni della card (927x967) ─────────
  var W_ED = 232, H_ED = 242, W_OUT = 927, H_OUT = 967;
  function fotoDisegna() {
    var f = FOTO, im = el("fimg");
    if (!f) return;
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
      FOTO = { img: img, ox: 0, oy: 0, z: 1, sporca: sporca, url: sporca ? null : src };
      el("fedit").hidden = false; el("fimg").src = src; el("fz").value = 100; fotoDisegna();
    };
    img.src = src;
  }
  function togliFoto() { FOTO = null; el("fedit").hidden = true; el("ffile").value = ""; }
  el("fbtn").addEventListener("click", function () { el("ffile").click(); });
  el("ffile").addEventListener("change", function () {
    if (!this.files || !this.files[0]) return;
    var r = new FileReader(); r.onload = function () { caricaFoto(r.result, true); }; r.readAsDataURL(this.files[0]);
  });
  el("ftogli").addEventListener("click", function () { togliFoto(); ricorda(); });
  el("fz").addEventListener("input", function () { if (FOTO) { FOTO.z = this.value / 100; FOTO.sporca = true; fotoDisegna(); } });
  var fdrag = null;
  el("fc").addEventListener("pointerdown", function (e) {
    if (!FOTO) return; fdrag = { x: e.clientX, y: e.clientY };
    this.setPointerCapture && this.setPointerCapture(e.pointerId); e.preventDefault();
  });
  document.addEventListener("pointermove", function (e) {
    if (!fdrag || !FOTO) return;
    FOTO.ox += e.clientX - fdrag.x; FOTO.oy += e.clientY - fdrag.y; FOTO.sporca = true;
    fdrag.x = e.clientX; fdrag.y = e.clientY; fotoDisegna();
  });
  document.addEventListener("pointerup", function () { fdrag = null; });
  function fotoCotta() {
    var f = FOTO, F = W_OUT / W_ED;
    var base = Math.max(W_ED / f.img.naturalWidth, H_ED / f.img.naturalHeight), sc = base * f.z;
    var tela = document.createElement("canvas"); tela.width = W_OUT; tela.height = H_OUT;
    tela.getContext("2d").drawImage(f.img,
      (W_ED / 2 - f.img.naturalWidth * sc / 2 + f.ox) * F, (H_ED / 2 - f.img.naturalHeight * sc / 2 + f.oy) * F,
      f.img.naturalWidth * sc * F, f.img.naturalHeight * sc * F);
    return tela.toDataURL("image/jpeg", 0.86);
  }
  function carica(nome, dati) {
    return fetch(PONTE, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
                          body: JSON.stringify({ token: TOKEN, tipo: "logo-carica", nome: nome, dati: dati }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok || !res.url) throw new Error(res.errore || "salvataggio non riuscito");
        return BASEIMG + res.url + "?t=" + Date.now();
      });
  }
  function assicuraFoto() {
    if (!FOTO || !FOTO.sporca || (QUALE !== "carta" && QUALE !== "approved")) return Promise.resolve();
    return carica("foto talent hunters " + (el("cNome").value.trim() || "giocatore"), fotoCotta())
      .then(function (url) { FOTO.url = url; FOTO.sporca = false; ricorda(); });
  }

  // ── lo stemma ──
  function disegnaStemma() {
    var u = el("lUrl").value.trim();
    el("lPrev").innerHTML = u ? '<img alt="" src="' + esc(u) + '">' : '<span class="nota">nessuno</span>';
  }
  el("lUrl").addEventListener("input", disegnaStemma);
  el("lBtn").addEventListener("click", function () { el("lFile").click(); });
  el("lFile").addEventListener("change", function () {
    var f = this.files && this.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      stato("", "Carico lo stemma…");
      carica("stemma talent hunters " + (el("cNome").value.trim() || ""), r.result)
        .then(function (url) { el("lUrl").value = url; disegnaStemma(); ricorda(); stato("ok", "Stemma caricato."); })
        .catch(function (e) { stato("err", "Stemma non salvato: " + esc(e.message)); });
    };
    r.readAsDataURL(f);
  });
  if (window.SceltaFoto) {
    SceltaFoto.adotta(PONTE, TOKEN);
    el("fmag").addEventListener("click", function () { SceltaFoto.apri(function (url) { caricaFoto(url, false); setTimeout(ricorda, 300); }); });
    el("lMag").addEventListener("click", function () { SceltaFoto.apri(function (url) { el("lUrl").value = url; disegnaStemma(); ricorda(); }); });
  }

  // ── dai campi ai dati del motore ────────────────────────────────────
  function numero(v) { var n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? null : Math.max(0, Math.min(100, n)); }
  function dati() {
    var foto = FOTO && FOTO.url ? FOTO.url : null, vid = el("fvid").value.trim();
    if (QUALE === "carta") {
      var c = [].map.call(document.querySelectorAll("#cRighe .coppia"), function (r) {
        return [r.querySelector(".eti").value.trim(), r.querySelector(".val").value.trim()];
      }).filter(function (x) { return x[0] && x[1]; });
      var d = { n: el("cNome").value.trim(), s: el("cSopr").value.trim(), num: el("cNum").value.trim(), c: c };
      if (vid) d.v = vid; else if (foto) d.f = foto;
      if (el("lUrl").value.trim()) d.l = el("lUrl").value.trim();
      return { d: d, err: !d.n ? "Serve il nome." : null, nome: d.s || d.n };
    }
    if (QUALE === "approved") {
      var a = { s: el("aSopr").value.trim(), val: el("aVal").value.trim(), u: el("aUnita").value, ok: el("aOk").value === "1" };
      if (vid) a.v = vid; else if (foto) a.f = foto;
      return { d: a, err: !a.s && !a.val ? "Serve almeno il nome nella barra o il valore." : null, nome: a.s };
    }
    if (QUALE === "heatmap") {
      var h = { z: ZONE.slice(), t: el("hmT").value.trim(), st: el("hmSt").value.trim(), dir: el("hmDir").value, fo: el("hmFo").value.trim() };
      if (el("hmEv").checked) h.ev = 1;
      return { d: h, err: ZONE.every(function (z) { return !z; }) ? "Scalda almeno una zona del campo." : null, nome: el("cNome").value.trim() };
    }
    if (QUALE === "torta") {
      var tr = righeTorta().filter(function (x) { return x[0]; });
      var mancanti = tr.filter(function (x) { return numero(x[1]) === null; }).length;
      return { d: { v: tr.map(function (x) { return [x[0], numero(x[1]) || 0]; }), fo: el("tFo").value.trim() },
               err: tr.length < 3 ? "Servono almeno 3 spicchi con il nome." : mancanti ? "Mancano " + mancanti + " valori (da 0 a 100)." : null,
               nome: el("cNome").value.trim() };
    }
    var rr = righeRadar().filter(function (x) { return x[0]; }), conf = el("rConf").checked;
    var mancaA = rr.filter(function (x) { return numero(x[1]) === null; }).length;
    var mancaB = conf ? rr.filter(function (x) { return numero(x[2]) === null; }).length : 0;
    var r = { v: rr.map(function (x) { return [x[0], numero(x[1]) || 0]; }), fo: el("rFo").value.trim() };
    if (conf) r.b = rr.map(function (x) { return numero(x[2]) || 0; });
    return { d: r, err: rr.length < 3 ? "Servono almeno 3 assi con il nome." : (mancaA + mancaB) ? "Mancano " + (mancaA + mancaB) + " valori (da 0 a 100)." : null,
             nome: el("cNome").value.trim() };
  }

  // ── anteprima e invio ───────────────────────────────────────────────
  function adattaPrev() { el("prev").style.transform = "scale(" + (el("prevbox").clientWidth / 1920) + ")"; }
  window.addEventListener("resize", adattaPrev);
  el("btnPrevChiudi").addEventListener("click", function () { el("prevwrap").style.display = "none"; el("prev").src = "about:blank"; });
  function anteprima() {
    stato("", "Preparo l'anteprima…");
    assicuraFoto().then(function () {
      var x = dati();
      ricorda();
      if (x.err) { stato("err", x.err); return; }
      el("prevwrap").style.display = "block";
      el("prev").src = GRAFICHE[QUALE].motore + "?d=" + b64url(x.d) + "&n=" + Date.now();
      adattaPrev();
      stato("", "Anteprima aggiornata.");
    }).catch(function (e) { stato("err", "Foto non salvata: " + esc(e.message)); });
  }
  el("btnPrev").addEventListener("click", anteprima);

  el("btnRegia").addEventListener("click", function () {
    assicuraFoto().then(function () {
      var x = dati();
      ricorda();
      if (x.err) { stato("err", x.err); return; }
      var G = GRAFICHE[QUALE];
      var proposta = ("TH · " + PAGINA.nome + (x.nome ? " · " + x.nome : "")).toUpperCase();
      var titolo = window.prompt("Nome in scaletta di regia:", proposta);
      if (titolo === null) return;
      el("stato").innerHTML = '<span>Invio a ' + Destinazione.dove() + '&hellip;</span><span class="pbar"><span class="pfill" id="pfill"></span></span>';
      fetch(PONTE, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({ token: TOKEN }, Destinazione.corpo({ grafica: G.tipo, titolo: titolo.trim() || proposta, dati: x.d })))
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res.ok) {
            var pf = document.getElementById("pfill"); if (pf) pf.className = "pfill done";
            setTimeout(function () { stato("ok", "Aggiunta a " + Destinazione.dove() + ". Dalla regia la mandi in onda."); }, 350);
          } else stato("err", "Errore: " + esc(res.errore || "sconosciuto"));
        })
        .catch(function () { stato("err", "Ponte non raggiungibile."); });
    }).catch(function (e) { stato("err", "Foto non salvata: " + esc(e.message)); });
  });

  // ── partenza ──
  riempiElenco();
  scegli("nuovo");
  el("gSel").value = "";
  el("prevbox").className = GRAFICHE[QUALE].alpha ? "trasparente" : "";
  adattaPrev();
})();
