/**
 * COACH — la guida che ti accompagna dentro le pagine vere (Goffredo, 27/09/2026)
 *
 * La carica nav.js (o nav-mam.js): una linguetta GUIDA sul bordo destro,
 * l'elenco dei "pezzi" della pagina, e un pezzo alla volta con il punto da
 * premere cerchiato in oro. Si va avanti da soli quando il gesto e' fatto.
 *
 * Due modi, stesso testo:
 *  - PALESTRA: su /como-tv-dev/ (ambiente di prova, scaletta di prova, niente
 *    arriva ai vMix). Nome, punti, distintivi.
 *  - AIUTO: sul sito vero. Prima di cominciare avvisa che le azioni restano e
 *    propone di allenarsi in palestra.
 *
 * I pezzi stanno in coach-dati.js. Un passo e':
 *   { t: "cosa fare", aiuto: "dove guardare", fai: "clic|scegli|scrivi|tasto|vedi|leggi",
 *     su: <dove>, atteso: "testo", tasto: "Enter", quando: <dove> | { url: "regex" } }
 *   <dove> = "selettore css" | { testo: "regex", in: "css", tag: "css" } | [ alternative ] | function(){ return el }
 * Un pezzo puo' cominciare su un'altra pagina (pagina: "live/x.html"): il
 * cammino sopravvive ai cambi di pagina (sessionStorage).
 */
(function () {
  "use strict";
  if (window.COACH) return;
  // le pagine d'uscita per i vMix non devono mai vedere niente
  if (/-vmix\.html$/i.test(location.pathname)) return;

  var DEV = /^\/como-tv-dev\//.test(location.pathname);
  // Si impara solo in PALESTRA (le pagine di prova): sul sito vero le pagine
  // di lavoro restano pulite, niente linguetta (Goffredo, 27/09/2026).
  if (!DEV) return;
  var RADICE = DEV ? "/como-tv-dev/" : "/como-tv/";
  var QUI = (document.currentScript && document.currentScript.src) || (RADICE + "live/coach.js");
  var VIDEO = "/como-tv/guida/video/";
  var K_RUN = "coach-cammino", K_PAL = "coach-palestra";
  // la lingua: ?lang=en (dalla palestra inglese) vale per tutto il giro
  var EN = (function () { try { var m = /[?&]lang=(en|it)\b/.exec(location.search); if (m) sessionStorage.setItem("coach-lingua", m[1]); return sessionStorage.getItem("coach-lingua") === "en"; } catch (e) { return false; } })();
  function X(t) { return EN && window.COACH_EN && window.COACH_EN[t] ? window.COACH_EN[t] : t; }
  function U(t) { return EN && window.COACH_EN && window.COACH_EN.__ui && window.COACH_EN.__ui[t] ? window.COACH_EN.__ui[t] : t; }
  var PAL_URL = EN ? "/como-tv/guida/palestra-en.html" : "/como-tv/guida/palestra.html";

  function leggi(k, d, sess) { try { var v = (sess ? sessionStorage : localStorage).getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function scrivi(k, v, sess) { try { (sess ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch (e) {} }
  function togli(k, sess) { try { (sess ? sessionStorage : localStorage).removeItem(k); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(); }

  // ── dove sono ────────────────────────────────────────────────
  function paginaQui() {
    var f = (location.pathname.split("/").pop() || "index.html").toLowerCase(), q = location.search;
    if (f === "mam2.html") {
      if (/[?&]live=1/.test(q)) return "mam-live";
      if (/[?&](raccolte=1|rac=)/.test(q)) return "raccolte";
      if (/[?&](montaggio=1|seq=)/.test(q)) return "editing";
      if (/[?&]asset=/.test(q)) return "mam-partita";
      return "mam";
    }
    if (/\/10_look/i.test(decodeURIComponent(location.pathname))) return /solo=social/.test(q) ? "social" : "statiche";
    if (f === "index.html" && !/\/live\//.test(location.pathname)) return "home";
    return f.replace(/\.html$/, "");
  }

  // ── trovare le cose sulla pagina ─────────────────────────────
  function visibile(e) {
    if (!e || !e.getBoundingClientRect) return false;
    var r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && +s.opacity !== 0;
  }
  function trova(f) {
    if (!f) return null;
    try {
      if (typeof f === "function") { var x = f(); return visibile(x) ? x : null; }
      if (Array.isArray(f)) { for (var i = 0; i < f.length; i++) { var e = trova(f[i]); if (e) return e; } return null; }
      if (typeof f === "string") { var l = document.querySelectorAll(f); for (var j = 0; j < l.length; j++) if (visibile(l[j]) && !dentroCoach(l[j])) return l[j]; return null; }
      if (f.testo) {
        var r = new RegExp(f.testo, "i"), ambiti = f.in ? document.querySelectorAll(f.in) : [document.body], cand = [];
        for (var a = 0; a < ambiti.length; a++) {
          var els = ambiti[a].querySelectorAll(f.tag || "button,a,label,summary,option,select,input,[role=button],span,div,li,td,th,b,strong,h1,h2,h3,h4,p");
          for (var b = 0; b < els.length; b++) {
            var el = els[b]; if (dentroCoach(el) || !visibile(el)) continue;
            var testi = [(el.textContent || "").replace(/\s+/g, " ").trim(), el.getAttribute("title") || "", el.getAttribute("aria-label") || "", el.getAttribute("placeholder") || ""];
            if (el.value && /^(INPUT|SELECT)$/.test(el.tagName)) testi.push(String(el.value));
            if (testi.some(function (x) { return x && r.test(x); })) cand.push(el);
          }
        }
        // la piu' piccola che contiene il testo (non il contenitore di tutta la pagina)
        cand = cand.filter(function (c) { return !cand.some(function (d) { return d !== c && c.contains(d); }); });
        return cand[0] || null;
      }
      if (f.url) return new RegExp(f.url, "i").test(location.pathname + location.search) ? document.body : null;
    } catch (e) {}
    return null;
  }
  function dentroCoach(e) { return !!(e && e.closest && e.closest(".coach-ui")); }

  // ── stile ─────────────────────────────────────────────────────
  var CSS = [
    ".coach-ui,.coach-ui *{box-sizing:border-box;font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:normal;text-transform:none}",
    ".coach-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483000;writing-mode:vertical-rl;background:#C9A24B;color:#0A0F24;border:0;border-radius:10px 0 0 10px;padding:16px 9px;font:800 13px/1 'Mazzard','Arial Black',sans-serif!important;letter-spacing:.18em!important;cursor:pointer;box-shadow:-4px 0 18px rgba(0,0,0,.35)}",
    ".coach-tab:hover{background:#E3C271}",
    ".coach-card{position:fixed;z-index:2147483001;top:84px;width:min(520px,calc(100vw - 24px));max-height:calc(100vh - 110px);overflow:auto;background:#F6F2E8;color:#101631;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.5);border:2px solid #C9A24B}",
    ".coach-card.destra{right:14px}.coach-card.sinistra{left:14px}",
    ".coach-card header{display:flex;align-items:center;gap:10px;padding:18px 22px;border-bottom:1px solid #E3DCCB}",
    ".coach-card header b{font:800 17px/1.2 'Mazzard','Arial Black',sans-serif;text-transform:uppercase!important;letter-spacing:.02em!important}",
    ".coach-card header .x{margin-left:auto;background:transparent;border:0;font-size:30px;line-height:1;cursor:pointer;color:#6D7186;padding:2px 6px}",
    ".coach-card .corpo{padding:20px 22px 22px;display:grid;gap:18px}",
    ".coach-card .avviso{background:#FBE7E7;border-radius:10px;padding:10px 12px;font-size:14px}",
    ".coach-card .avviso b{color:#B4232A}",
    ".coach-card .pezzi{display:grid;gap:8px}",
    ".coach-card .pezzo{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center;text-align:left;background:#fff;border:1px solid #E3DCCB;border-radius:12px;padding:10px 12px;cursor:pointer;color:#101631}",
    ".coach-card .pezzo:hover{border-color:#C9A24B}",
    ".coach-card .pezzo .t{font:700 19px/1.25 'DM Sans',system-ui,-apple-system,sans-serif}",
    ".coach-card .pezzo .m{font-size:15px;color:#6D7186}",
    ".coach-card .pezzo .v{grid-row:span 2;font:800 12px/1 'DM Sans',system-ui,-apple-system,sans-serif;color:#fff;background:#0A0F24;border-radius:999px;padding:7px 10px}",
    ".coach-card .pezzo.fatto .v{background:#2F7D55}",
    ".coach-card .ordine{font:800 30px/1.25 'DM Sans',system-ui,-apple-system,sans-serif;color:#0A0F24}",
    ".coach-card .aiuto{font-size:19px;line-height:1.4;color:#3F455E;background:#F4E9CF;border-radius:12px;padding:12px 16px}",
    ".coach-card .pallini{display:flex;gap:8px;flex-wrap:wrap}",
    ".coach-card .pallini i{width:16px;height:16px;border-radius:50%;background:#E3DCCB}",
    ".coach-card .pallini i.ok{background:#2F7D55}.coach-card .pallini i.ora{background:#C9A24B}",
    ".coach-card .bottoni{display:flex;gap:8px;flex-wrap:nowrap}",
    ".coach-card button.b{border:0;border-radius:12px;padding:14px 14px;white-space:nowrap;font:700 16px/1 'DM Sans',system-ui,-apple-system,sans-serif;cursor:pointer;background:#EFE9DB;color:#101631}",
    ".coach-card button.b.rosso{background:#E51B20;color:#fff}.coach-card button.b.rosso:hover{background:#C8161B}",
    ".coach-card button.b.oro{background:#C9A24B;color:#0A0F24}.coach-card button.b.navy{background:#0A0F24;color:#F5F1E6}",
    ".coach-card .stato{font-size:17px;color:#6D7186}",
    ".coach-card .bravo{font:800 26px/1.25 'DM Sans',system-ui,-apple-system,sans-serif;color:#2F7D55}",
    ".coach-card input.nome{width:100%;font:600 16px/1 'DM Sans',system-ui,-apple-system,sans-serif;padding:10px 12px;border-radius:10px;border:2px solid #E3DCCB;background:#fff;color:#101631}",
    ".coach-card video{width:100%;border-radius:10px;background:#000;display:block}",
    ".coach-anello{position:fixed;z-index:2147482999;pointer-events:none;border:3px solid #E3C271;border-radius:10px;box-shadow:0 0 0 4px rgba(10,15,36,.55),0 0 22px rgba(227,194,113,.9);transition:all .18s ease;animation:coachPulsa 1.2s ease-in-out infinite}",
    "@keyframes coachPulsa{0%,100%{outline:0 solid rgba(227,194,113,.6)}50%{outline:9px solid rgba(227,194,113,0)}}",
    ".coach-badge{position:fixed;left:12px;bottom:12px;z-index:2147483000;background:#0A0F24;color:#F5F1E6;border:2px solid #C9A24B;border-radius:999px;padding:13px 20px;font:700 17px/1 'DM Sans',system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)}",
    ".coach-badge b{color:#E3C271}",
    ".coach-piu{position:fixed;z-index:2147483002;font:800 26px/1 'Mazzard','Arial Black',sans-serif;color:#3DDC84;pointer-events:none;animation:coachSale 1s ease-out forwards;text-shadow:0 2px 8px rgba(0,0,0,.6)}",
    "@keyframes coachSale{from{transform:translateY(0);opacity:1}to{transform:translateY(-46px);opacity:0}}",
    "#cnav-dev{display:none!important}",
    "@media (prefers-reduced-motion:reduce){.coach-anello,.coach-piu{animation:none}}"
  ].join("\n");

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // ── stato ─────────────────────────────────────────────────────
  var DATI = null, card = null, anello = null, badge = null, tab = null;
  var RUN = leggi(K_RUN, null, true);           // { id, i, prod }
  var PAL = leggi(K_PAL, { nome: "", punti: 0, fatti: {} });
  function salvaPal() { scrivi(K_PAL, PAL); disegnaBadge(); }

  function pezzi() { return (DATI && DATI.pezzi) || []; }
  function pezzo(id) { var l = pezzi(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return generico(id); }
  function suQuestaPagina(p) { return (p.pagine || []).indexOf(paginaQui()) >= 0; }

  // Il pezzo "manda questa grafica in regia" per ogni editor di grafica:
  // si costruisce dai bottoni veri che la pagina ha.
  function generico(id) {
    if (id !== "grafica-" + paginaQui()) return null;
    var passi = [];
    var carica = trova([{ testo: "^(⇩|↓)?\\s*(prendi|carica)\\b", tag: "button" }]);
    if (carica) passi.push({ t: "Prendi i dati: clicca " + carica.textContent.trim().replace(/\s+/g, " "), aiuto: "I dati arrivano da ESPN o dal ponte. Se mancano si scrivono a mano.", fai: "clic", su: { testo: "^(⇩|↓)?\\s*(prendi|carica)\\b", tag: "button" } });
    passi.push({ t: "Controlla i campi: nomi, numeri, date, foto", aiuto: "La grafica va in onda come la vedi: prima di mandarla, rileggila.", fai: "leggi" });
    if (trova({ testo: "^anteprima$", tag: "button" })) passi.push({ t: "Clicca Anteprima e guardala", aiuto: "La vedi esattamente come uscirà in onda.", fai: "clic", su: { testo: "^anteprima$", tag: "button" } });
    passi.push({ t: "Scegli il vMix a cui mandarla", aiuto: "Il menu SELEZIONA VMIX O PROGETTO, in alto a destra.", fai: "scegli", su: ["#canaleSel", "select.destinazione", { testo: "^vmix", tag: "select" }] });
    passi.push({ t: "Clicca Invia alla regia", aiuto: DEV ? "Siamo in palestra: arriva nella scaletta di prova, non in onda." : "Arriva davvero nella scaletta: controlla il vMix.", fai: "clic", su: [{ testo: "invia alla regia", tag: "button" }, { testo: "^📡?\\s*invia", tag: "button" }] });
    var nome = (document.querySelector("h1") || {}).textContent || "questa grafica";
    return { id: id, titolo: "Manda " + nome.trim().toLowerCase().replace(/^\w/, function (c) { return c.toUpperCase(); }) + " in regia", area: "Grafiche live", pagine: [paginaQui()], passi: passi, generico: true };
  }
  function eEditorGrafica() { return !!(trova({ testo: "invia alla regia", tag: "button" }) && trova(["#canaleSel", "select.destinazione", { testo: "^vmix", tag: "select" }])); }
  function pezziQui() {
    var l = pezzi().filter(suQuestaPagina);
    if (eEditorGrafica() && !l.some(function (p) { return p.sostituisceGenerico; })) { var g = generico("grafica-" + paginaQui()); if (g && g.passi.length > 2) l.push(g); }
    return l;
  }

  // ── interfaccia ───────────────────────────────────────────────
  function monta() {
    if (!document.getElementById("coach-css")) { var s = el("style"); s.id = "coach-css"; s.textContent = CSS; document.head.appendChild(s); }
    tab = el("button", "coach-ui coach-tab", "GUIDA"); tab.type = "button"; tab.title = "Guida passo passo di questa pagina"; tab.onclick = function () { card && !RUN ? chiudi() : elenco(); };
    document.body.appendChild(tab);
    anello = el("div", "coach-ui coach-anello"); anello.style.display = "none"; document.body.appendChild(anello);
    if (DEV) { badge = el("a", "coach-ui coach-badge"); badge.href = "/como-tv/guida/palestra.html"; badge.style.textDecoration = "none"; document.body.appendChild(badge); disegnaBadge(); }
    window.addEventListener("pointerdown", suPremi, true); window.addEventListener("mousedown", suPremi, true);
    window.addEventListener("click", suClic, true);
    document.addEventListener("change", suCambio, true);
    document.addEventListener("input", suScrivi, true);
    document.addEventListener("keydown", suTasto, true);
    setInterval(giro, 350);
  }
  function disegnaBadge() { if (badge) badge.innerHTML = "← " + U("PALESTRA") + " · <b>" + PAL.punti + "</b> " + U("punti"); }
  function apriCard(html, lato) {
    if (!card) { card = el("div", "coach-ui coach-card"); document.body.appendChild(card); }
    card.className = "coach-ui coach-card " + (lato || "destra"); card.innerHTML = html; return card;
  }
  function chiudi() { if (card) { card.remove(); card = null; } nascondiAnello(); }

  function elenco() {
    var l = pezziQui(), altri = pezzi().filter(function (p) { return !suQuestaPagina(p); });
    var html = '<header><b>Guida · questa pagina</b><button class="x" data-c="chiudi" aria-label="Chiudi">×</button></header><div class="corpo">';
    if (!DEV) html += '<div class="avviso"><b>Sei sul sito vero:</b> quello che fai resta (e un invio arriva davvero in regia). Per esercitarti usa la <b>palestra</b>.</div>';
    html += l.length ? '<div class="pezzi">' + l.map(function (p) { return '<button class="pezzo' + (PAL.fatti[p.id] ? " fatto" : "") + '" data-p="' + esc(p.id) + '"><span class="t">' + esc(p.titolo) + '</span><span class="v">' + (PAL.fatti[p.id] ? "✓ rifai" : DEV ? "Allenati" : "Guidami") + '</span><span class="m">' + p.passi.length + " passi" + (p.video ? " · con video" : "") + '</span></button>'; }).join("") + "</div>"
      : '<div class="stato">Per questa pagina non ci sono ancora pezzi guidati.</div>';
    if (!DEV) html += '<div class="bottoni"><button class="b navy" data-c="palestra">Allenati in palestra</button></div>';
    html += '<div class="bottoni"><a class="b" style="text-decoration:none;display:inline-block;border-radius:10px;padding:9px 12px;background:#EFE9DB;color:#101631;font:700 17px/1 DM Sans,system-ui,sans-serif" href="' + RADICE.replace("-dev", "") + 'guida/index.html" target="_blank">Tutta la guida ↗</a></div>';
    if (altri.length) html += '<div class="stato">Altri ' + altri.length + ' pezzi sono nelle altre pagine: li trovi nella guida.</div>';
    html += "</div>";
    var c = apriCard(html, "destra");
    c.querySelectorAll("[data-p]").forEach(function (b) { b.onclick = function () { inizia(b.dataset.p); }; });
    c.querySelectorAll("[data-c]").forEach(function (b) { b.onclick = function () { comando(b.dataset.c); }; });
    var n = c.querySelector("#coachNome"); if (n) n.addEventListener("keydown", function (e) { if (e.key === "Enter") comando("nome"); });
  }
  function comando(c) {
    if (c === "chiudi") return RUN ? esci() : chiudi();
    if (c === "nome") { var v = (document.getElementById("coachNome") || {}).value; if (v && v.trim()) { PAL.nome = v.trim(); salvaPal(); } return elenco(); }
    if (c === "palestra") { location.href = versoPalestra(RUN ? RUN.id : null); return; }
    if (c === "esci") return esci();
    if (c === "salta") return avanza(true);
    if (c === "avanti") return avanza();
    if (c === "video") return mostraVideo();
    if (c === "elenco") { esci(); return elenco(); }
    if (c === "torna") { RUN = null; togli(K_RUN, true); location.href = PAL_URL; return; }
    if (c === "rifai") { var id = leggi("coach-finito-id", null, true); if (id) inizia(id); return; }
  }
  function versoPalestra(id) {
    var u = location.pathname.replace(/^\/como-tv\//, "/como-tv-dev/") + location.search;
    return u + (id ? (location.search ? "&" : "?") + "coach=" + encodeURIComponent(id) : "");
  }

  // ── il cammino ────────────────────────────────────────────────
  function inizia(id) {
    var p = pezzo(id); if (!p) return;
    RUN = { id: id, i: 0 }; scrivi(K_RUN, RUN, true);
    if (p.pagine && p.pagine.indexOf(paginaQui()) < 0 && p.pagina) { location.href = RADICE + p.pagina; return; }
    passo();
  }
  function esci() { RUN = null; togli(K_RUN, true); chiudi(); }
  function passoCorrente() { if (!RUN) return null; var p = pezzo(RUN.id); return p ? p.passi[RUN.i] : null; }

  function passo() {
    var p = RUN && pezzo(RUN.id); if (!p) { esci(); return; }
    var s = p.passi[RUN.i]; if (!s) return fine(p);
    while (s && s.salta && trova(s.salta)) { RUN.i++; scrivi(K_RUN, RUN, true); s = p.passi[RUN.i]; }
    if (!s) return fine(p);
    var bersaglio = trova(s.su); ultimoBersaglio = bersaglio;
    var lato = "destra";
    if (bersaglio) { var r = bersaglio.getBoundingClientRect(); if (r.left + r.width / 2 > innerWidth * 0.55) lato = "sinistra"; }
    var altrove = s.pagina && paginaQui() !== s.pagina.replace(/^.*\//, "").replace(/\.html.*$/, "") && !(s.paginaChiave && s.paginaChiave === paginaQui());
    var html = '<header><b>' + esc(X(p.titolo)) + '</b><button class="x" data-c="esci" aria-label="Esci">×</button></header><div class="corpo">' +
      '<div class="pallini">' + p.passi.map(function (_, j) { return '<i class="' + (j < RUN.i ? "ok" : j === RUN.i ? "ora" : "") + '"></i>'; }).join("") + '</div>' +
      '<div class="stato" style="margin-top:-8px">' + U("Passo") + " " + (RUN.i + 1) + " " + U("di") + " " + p.passi.length + '</div><div class="ordine">' + esc(X(s.t)) + "</div>" +
      (s.aiuto ? '<div class="aiuto">' + esc(X(s.aiuto)) + "</div>" : "") +
      (!bersaglio && s.su && s.fai !== "vedi" ? '<div class="stato">' + U("Non vedo ancora il punto giusto su questa pagina:") + " " + (altrove ? U("prima apri la pagina giusta.") : U("scorri o aspetta che carichi.")) + "</div>" : "") +
      (s.fai === "leggi" ? '<button class="b oro" data-c="avanti" style="width:100%;padding:16px;font-size:18px">' + U("Fatto, avanti →") + '</button>' : "") +
      (altrove ? '<button class="b oro" data-c="vaiPagina" style="width:100%;padding:16px;font-size:18px">' + U("Apri la pagina") + '</button>' : "") +
      '<div class="bottoni">' +
      (p.video ? '<button class="b rosso" data-c="video"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" style="vertical-align:-2px;margin-right:8px"><path d="M4 2v12l10-6z" fill="currentColor"/></svg>' + U("Guarda come si fa") + '</button>' : "") +
      '<button class="b" data-c="salta">' + U("Salta") + '</button>' + (DEV ? '<button class="b" data-c="torna">' + U("Torna alla palestra") + '</button>' : '<button class="b" data-c="elenco">Altri pezzi</button>') + '</div>' +
      '<div class="stato" id="coachEsito"></div></div>';
    var c = apriCard(html, lato);
    c.querySelectorAll("[data-c]").forEach(function (b) { b.onclick = function () { if (b.dataset.c === "vaiPagina") location.href = RADICE + s.pagina; else comando(b.dataset.c); }; });
    if (bersaglio && s.fai !== "leggi") { var rr = bersaglio.getBoundingClientRect(); if (rr.top < 70 || rr.bottom > innerHeight - 20) bersaglio.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
  function avanza(saltato) {
    if (!RUN) return; var p = pezzo(RUN.id); if (!p) return;
    if (!saltato && DEV) { PAL.punti += 10; salvaPal(); piu(10); }
    RUN.i++; scrivi(K_RUN, RUN, true);
    if (RUN.i >= p.passi.length) return fine(p);
    nascondiAnello(); setTimeout(passo, 250);
  }
  function fine(p) {
    var gia = PAL.fatti[p.id];
    if (DEV) { if (!gia) PAL.punti += 20; PAL.fatti[p.id] = 1; salvaPal(); }
    RUN = null; togli(K_RUN, true); nascondiAnello();
    scrivi("coach-finito", { id: p.id, t: Date.now() }, true);
    mostraFine(p, false, gia);
  }
  function mostraFine(p, dopo, gia) {
    var area = p.area, tutti = pezzi().filter(function (x) { return x.area === area; }), presa = DEV && tutti.length && tutti.every(function (x) { return PAL.fatti[x.id]; });
    var c = apriCard('<header><b>' + U("Fatto") + '</b><button class="x" data-c="chiudi" aria-label="Chiudi">×</button></header><div class="corpo"><div class="bravo">' + U("Pezzo completato:") + " " + esc(X(p.titolo)) + '</div>' +
      (DEV ? '<div>' + (dopo ? "" : "+" + (gia ? 0 : 20) + " " + U("punti") + " · ") + U("totale") + ' <b>' + PAL.punti + "</b> " + U("punti") + "</div>" : "") + (presa ? '<div class="bravo">' + U("Hai preso la patente") + " " + esc(area) + "</div>" : "") +
      '<div class="bottoni">' + (DEV ? '<button class="b oro" data-c="torna">' + U("Torna alla palestra") + '</button><button class="b" data-c="rifai">' + U("Rifallo") + '</button>' : '<button class="b oro" data-c="elenco">Altri pezzi</button><button class="b" data-c="chiudi">Chiudi</button>') + '</div></div>', "destra");
    scrivi("coach-finito-id", p.id, true);
    c.querySelectorAll("[data-c]").forEach(function (b) { b.onclick = function () { comando(b.dataset.c); }; });
  }
  function piu(n) { var s = passoCorrente(), e = s && trova(s.su), r = e ? e.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0 }; var d = el("div", "coach-ui coach-piu", "+" + n); d.style.left = (r.left + r.width / 2) + "px"; d.style.top = (r.top) + "px"; document.body.appendChild(d); setTimeout(function () { d.remove(); }, 1100); }
  function mostraVideo() {
    var p = RUN && pezzo(RUN.id); if (!p || !p.video) return;
    var box = card.querySelector(".corpo"); if (box.querySelector("video")) return;
    var v = el("video"); v.src = VIDEO + p.video + (EN ? "-en" : "") + ".mp4"; v.controls = true; v.muted = true; v.playsInline = true; box.insertBefore(v, box.firstChild); v.play().catch(function () {});
  }
  function nascondiAnello() { if (anello) anello.style.display = "none"; }

  // ── riconoscere il gesto ──────────────────────────────────────
  function colpito(target, s) { var e = trova(s.su); return !!(e && target && (e === target || e.contains(target))); }
  // Molte pagine reagiscono gia' alla pressione (menu, caselle) e ridisegnano
  // prima del clic: il gesto si riconosce alla pressione, il clic fa da riserva.
  var ultimoGesto = 0;
  function suPremi(e) { if (dentroCoach(e.target) || Date.now() - ultimoGesto < 400) return; window.__coachUltimo = [e.type, e.target && (e.target.tagName + "." + e.target.className)].join(" "); var s = passoCorrente(); if (s && s.fai === "clic" && colpito(e.target, s)) { ultimoGesto = Date.now(); avanza(); } }
  function suClic(e) { if (dentroCoach(e.target) || Date.now() - ultimoGesto < 900) return; var s = passoCorrente(); if (s && s.fai === "clic" && colpito(e.target, s)) { ultimoGesto = Date.now(); avanza(); } }
  function suCambio(e) { if (dentroCoach(e.target)) return; var s = passoCorrente(); if (s && s.fai === "scegli" && colpito(e.target, s)) { if (!s.atteso || new RegExp(s.atteso, "i").test(e.target.selectedOptions ? e.target.selectedOptions[0].text : e.target.value)) avanza(); } }
  function suScrivi(e) { if (dentroCoach(e.target)) return; var s = passoCorrente(); if (s && s.fai === "scrivi" && colpito(e.target, s) && norm(e.target.value) === norm(s.atteso)) avanza(); }
  function suTasto(e) {
    if (dentroCoach(e.target)) return; var s = passoCorrente(); if (!s || s.fai !== "tasto") return;
    var ok = [].concat(s.tasto).some(function (k) { return e.key === k || (k.length === 1 && e.key.toLowerCase() === k.toLowerCase()); });
    if (ok && (!s.cmd || e.metaKey || e.ctrlKey)) setTimeout(avanza, 80);
  }
  var ultimoBersaglio = null, visto = 0;
  function giro() {
    var s = passoCorrente(); if (!s) { nascondiAnello(); ultimoBersaglio = null; return; }
    if (s.fai === "vedi" && s.quando) { if (trova(s.quando)) { if (++visto > 1) { visto = 0; avanza(); return; } } else visto = 0; }
    var e = trova(s.su);
    if (!!e !== !!ultimoBersaglio) { ultimoBersaglio = e; passo(); }
    ultimoBersaglio = e;
    if (!e || s.fai === "leggi" && !s.mostra) { if (!e) { nascondiAnello(); return; } }
    var r = e.getBoundingClientRect();
    anello.style.display = "block"; anello.style.left = (r.left - 6) + "px"; anello.style.top = (r.top - 6) + "px"; anello.style.width = (r.width + 12) + "px"; anello.style.height = (r.height + 12) + "px";
  }

  // ── partenza ──────────────────────────────────────────────────
  function avvia() {
    window.COACH = { stato: function () { return RUN ? { id: RUN.id, i: RUN.i, passo: passoCorrente() } : null; }, inizia: inizia, esci: esci, pagina: paginaQui, dati: function () { return DATI; }, trova: trova, pezziQui: pezziQui, generico: generico };
    DATI = window.COACH_DATI || { pezzi: [] };
    monta();
    var m = /[?&]coach=([^&]+)/.exec(location.search);
    if (m) {
      var id = decodeURIComponent(m[1]);
      history.replaceState(null, "", location.pathname + location.search.replace(/([?&])coach=[^&]+&?/, "$1").replace(/[?&]$/, "") + location.hash);
      setTimeout(function () { inizia(id); }, 900);
    } else if (RUN) setTimeout(passo, 900);
    else { var f = leggi("coach-finito", null, true); if (f && Date.now() - f.t < 15000) { togli("coach-finito", true); var pf = pezzo(f.id); if (pf) setTimeout(function () { mostraFine(pf, true); }, 900); } }
  }
  function carica() {
    if (EN && !window.COACH_EN && !carica.provato) { carica.provato = 1; var e = document.createElement("script"); e.src = QUI.replace(/coach\.js(\?.*)?$/, "coach-dati-en.js"); e.onload = e.onerror = function () { carica(); }; document.head.appendChild(e); return; }
    if (window.COACH_DATI) return avvia();
    var s = document.createElement("script"); s.src = QUI.replace(/coach\.js(\?.*)?$/, "coach-dati.js"); s.onload = avvia; s.onerror = avvia; document.head.appendChild(s);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", carica); else carica();
})();
