/**
 * TENDINA CON RICERCA — per i menu' lunghi (le competizioni sono piu' di 60).
 *
 * Si mette sopra una <select> vera, che resta la fonte di verita': il valore,
 * l'evento "change" e tutto il codice che ci lavora sopra restano quelli di
 * prima. La tendina ci aggiunge solo quello che alla select manca: una
 * casella dove scrivere ("bund", "cop", "argentina") e una lista che si
 * legge, coi gruppi della select come titoletti.
 *
 * La ricerca non guarda gli accenti ne' le maiuscole, e cerca anche nel
 * nome del gruppo: scrivendo "spagna" escono tutte le competizioni spagnole.
 * Con opz.sinonimi una parola ne vale altre: per le competizioni "coppa"
 * trova anche Copa del Rey, Coupe de France, FA Cup, DFB-Pokal.
 *
 * Uso:
 *   var t = TendinaCerca.su(select, { segnaposto: "Cerca una competizione" });
 *   t.aggiorna();   // dopo aver riempito o cambiato la select da codice
 */
window.TendinaCerca = (function () {
  "use strict";

  var stileMesso = false;
  function stile() {
    if (stileMesso) return;
    stileMesso = true;
    var s = document.createElement("style");
    s.textContent =
      ".tcerca{position:relative;display:block;width:100%;min-width:0;}" +
      ".tcerca>button.tc-scelta{width:100%;display:flex;align-items:center;gap:8px;text-align:left;" +
        "padding:9px 34px 9px 12px;border-radius:9px;background:rgba(6,10,26,.7);" +
        "border:1px solid rgba(245,241,230,.16);color:#F5F1E6;font-family:'DM Sans',sans-serif;" +
        "font-size:14px;font-weight:600;letter-spacing:0;text-transform:none;cursor:pointer;position:relative;" +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:38px;}" +
      ".tcerca>button.tc-scelta:hover{border-color:rgba(201,162,75,.5);}" +
      ".tcerca>button.tc-scelta::after{content:'';position:absolute;right:13px;top:50%;width:7px;height:7px;" +
        "border-right:2px solid #C9A24B;border-bottom:2px solid #C9A24B;transform:translateY(-70%) rotate(45deg);}" +
      ".tcerca>button.tc-scelta .tc-vuoto{color:rgba(245,241,230,.45);font-weight:500;}" +
      ".tcerca .tc-pan{position:absolute;z-index:9000;left:0;top:calc(100% + 5px);width:max(100%,340px);" +
        "max-width:92vw;background:#0E1533;border:1px solid rgba(201,162,75,.35);border-radius:11px;" +
        "box-shadow:0 18px 50px rgba(0,0,0,.55);padding:8px;display:none;}" +
      ".tcerca.aperta .tc-pan{display:block;}" +
      ".tcerca .tc-pan input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;" +
        "background:rgba(6,10,26,.85);border:1px solid rgba(245,241,230,.18);color:#F5F1E6;" +
        "font-family:'DM Sans',sans-serif;font-size:15px;margin-bottom:6px;}" +
      ".tcerca .tc-pan input:focus{outline:none;border-color:rgba(201,162,75,.6);}" +
      ".tcerca .tc-lista{max-height:360px;overflow-y:auto;overscroll-behavior:contain;}" +
      ".tcerca .tc-gr{font-family:'Mazzard',sans-serif;font-size:10.5px;font-weight:700;letter-spacing:.16em;" +
        "text-transform:uppercase;color:#C9A24B;padding:10px 10px 4px;}" +
      ".tcerca .tc-v{display:block;width:100%;text-align:left;padding:8px 10px;border-radius:7px;" +
        "background:none;border:0;color:#F5F1E6;font-family:'DM Sans',sans-serif;font-size:14.5px;" +
        "font-weight:500;letter-spacing:0;text-transform:none;cursor:pointer;}" +
      ".tcerca .tc-v:hover,.tcerca .tc-v.su{background:rgba(201,162,75,.16);}" +
      ".tcerca .tc-v.scelta{color:#E3C271;font-weight:700;}" +
      ".tcerca .tc-niente{padding:12px 10px;color:rgba(245,241,230,.5);font-family:'DM Sans',sans-serif;font-size:14px;}";
    document.head.appendChild(s);
  }

  // "Süper Lig" e "super lig" devono essere la stessa cosa
  function piano(t) {
    return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function su(sel, opz) {
    if (!sel || sel.__tcerca) return sel && sel.__tcerca;
    opz = opz || {};
    stile();
    var box = document.createElement("div");
    box.className = "tcerca";
    box.innerHTML = '<button type="button" class="tc-scelta"></button>' +
      '<div class="tc-pan"><input type="text" autocomplete="off" spellcheck="false" placeholder="' +
      esc(opz.segnaposto || "Cerca…") + '"><div class="tc-lista"></div></div>';
    sel.parentNode.insertBefore(box, sel);
    sel.style.display = "none";
    var btn = box.querySelector(".tc-scelta"), inp = box.querySelector("input"),
        lista = box.querySelector(".tc-lista");
    var voci = [], su_ = -1;

    // le voci della select, coi loro gruppi
    function leggi() {
      voci = [];
      Array.prototype.forEach.call(sel.options, function (o) {
        if (!o.value && !o.textContent.trim().replace(/[—-]/g, "")) return;   // il "—" vuoto
        if (o.disabled) return;
        var g = o.parentNode && o.parentNode.tagName === "OPTGROUP" ? o.parentNode.label : "";
        voci.push({ v: o.value, t: o.textContent, g: g, cerca: piano(o.textContent + " " + g) });
      });
    }
    function mostraScelta() {
      var o = sel.options[sel.selectedIndex];
      var t = o && o.value !== "" ? o.textContent : "";
      btn.innerHTML = t ? esc(t) : '<span class="tc-vuoto">' + esc(opz.vuoto || "Scegli…") + "</span>";
      btn.title = t;
    }
    function disegna() {
      var q = piano(inp.value), pezzi = q ? q.split(" ") : [];
      var sin = opz.sinonimi || {};
      // ogni parola scritta vale anche per i suoi sinonimi, e basta
      // l'inizio: "cop" trova gia' coppa, copa e coupe
      function varianti(p) {
        var v = [p];
        Object.keys(sin).forEach(function (k) {
          if (k.indexOf(p) === 0 || p.indexOf(k) === 0) v = v.concat(sin[k]);
        });
        return v;
      }
      var cerchi = pezzi.map(varianti);
      var ok = voci.filter(function (x) {
        return cerchi.every(function (v) {
          return v.some(function (p) { return x.cerca.indexOf(p) !== -1; });
        });
      });
      if (!ok.length) { lista.innerHTML = '<div class="tc-niente">Niente con “' + esc(inp.value) + '”.</div>'; su_ = -1; return; }
      var h = "", ultimo = null;
      ok.forEach(function (x, i) {
        if (x.g !== ultimo) { ultimo = x.g; if (x.g) h += '<div class="tc-gr">' + esc(x.g) + "</div>"; }
        h += '<button type="button" class="tc-v' + (x.v === sel.value ? " scelta" : "") +
             '" data-i="' + i + '" data-v="' + esc(x.v) + '">' + esc(x.t) + "</button>";
      });
      lista.innerHTML = h;
      su_ = q ? 0 : -1;
      evidenzia();
    }
    function evidenzia() {
      var b = lista.querySelectorAll(".tc-v");
      Array.prototype.forEach.call(b, function (x, i) { x.classList.toggle("su", i === su_); });
      if (b[su_]) b[su_].scrollIntoView({ block: "nearest" });
    }
    function apri() {
      leggi(); inp.value = ""; disegna();
      box.classList.add("aperta");
      setTimeout(function () {
        inp.focus();
        var s = lista.querySelector(".tc-v.scelta");
        if (s) s.scrollIntoView({ block: "center" });
      }, 0);
    }
    function chiudi() { box.classList.remove("aperta"); }
    function scegli(v) {
      chiudi();
      if (sel.value === v) return;
      sel.value = v;
      mostraScelta();
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }

    btn.addEventListener("click", function () { box.classList.contains("aperta") ? chiudi() : apri(); });
    inp.addEventListener("input", disegna);
    inp.addEventListener("keydown", function (ev) {
      var b = lista.querySelectorAll(".tc-v");
      if (ev.key === "ArrowDown") { ev.preventDefault(); su_ = Math.min(b.length - 1, su_ + 1); evidenzia(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); su_ = Math.max(0, su_ - 1); evidenzia(); }
      else if (ev.key === "Enter") { ev.preventDefault(); if (b[su_]) scegli(b[su_].dataset.v); }
      else if (ev.key === "Escape") { chiudi(); btn.focus(); }
    });
    lista.addEventListener("mousedown", function (ev) { ev.preventDefault(); });   // l'input non perde il fuoco
    lista.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest(".tc-v") : null;
      if (b) scegli(b.dataset.v);
    });
    document.addEventListener("mousedown", function (ev) {
      if (box.classList.contains("aperta") && !box.contains(ev.target)) chiudi();
    });
    // il codice della pagina cambia la select anche da solo (lo stato che
    // arriva dal ponte): la scritta sul bottone lo segue
    sel.addEventListener("change", mostraScelta);
    var visto = null;
    setInterval(function () {
      if (sel.value !== visto) { visto = sel.value; mostraScelta(); }
    }, 400);
    new MutationObserver(function () { mostraScelta(); }).observe(sel, { childList: true, subtree: true });

    leggi(); mostraScelta();
    var api = { aggiorna: function () { leggi(); mostraScelta(); }, apri: apri, chiudi: chiudi, box: box };
    sel.__tcerca = api;
    return api;
  }

  return { su: su };
})();
