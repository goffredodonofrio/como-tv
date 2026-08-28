/**
 * ═══════════════════════════════════════════════════════════════════
 *  DESTINAZIONE — vMix subito, oppure un Progetto per dopo
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Il menu' della destinazione, oltre ai sette vMix, offre i Progetti:
 *  contenitori con nome dove la redazione prepara le grafiche nei
 *  giorni prima (il Football Show del lunedi' si prepara il sabato).
 *  Il giorno del live, dalla regia, il progetto si versa nel canale.
 *
 *  Le pagine continuano a usare il loro flusso d'invio: qui cambiano
 *  solo il contenuto del menu' e il corpo della richiesta.
 */
window.Destinazione = (function () {
  "use strict";
  var sel = null, ponte = "", token = "", progetti = [];
  var LS = "comotv.regia.destinazione";

  function ricostruisci() {
    var scelto = null;
    try { scelto = localStorage.getItem(LS); } catch (e) {}
    if (sel.value) scelto = sel.value;              // una scelta gia' fatta vince
    var h = "";
    for (var i = 1; i <= 7; i++) h += '<option value="' + i + '">vMix ' + i + "</option>";
    if (progetti.length) {
      h += '<optgroup label="Progetti">';
      progetti.forEach(function (p) {
        h += '<option value="p:' + p.id + '">📁 ' + esc(p.nome) + " (" + p.quante + ")</option>";
      });
      h += "</optgroup>";
    }
    h += '<option value="__nuovo">➕ Nuovo progetto…</option>';
    sel.innerHTML = h;
    // riprendo la scelta salvata, se esiste ancora
    if (scelto && [].some.call(sel.options, function (o) { return o.value === scelto; })) sel.value = scelto;
    else sel.value = "1";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function carica() {
    return fetch(ponte, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: token, tipo: "progetto-elenco" })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.ok) { progetti = j.progetti || []; ricostruisci(); } })
      .catch(function () { /* senza elenco restano i vMix: nessun danno */ });
  }

  function cambio() {
    if (sel.value === "__nuovo") {
      var nome = window.prompt("Nome del nuovo progetto (es. Football Show 01/09):");
      if (!nome || !nome.trim()) { ricostruisci(); return; }
      fetch(ponte, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ token: token, tipo: "progetto-crea", nome: nome.trim() })
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) { window.alert("Non sono riuscito a creare il progetto: " + (j.errore || "")); ricostruisci(); return; }
          progetti.unshift({ id: j.id, nome: j.nome, quante: 0 });
          ricostruisci();
          sel.value = "p:" + j.id;
          try { localStorage.setItem(LS, sel.value); } catch (e) {}
        })
        .catch(function () { window.alert("Ponte non raggiungibile."); ricostruisci(); });
      return;
    }
    try { localStorage.setItem(LS, sel.value); } catch (e) {}
  }

  function adotta(s, po, tk) {
    sel = s; ponte = po; token = tk;
    ricostruisci();
    sel.addEventListener("change", cambio);
    carica();
  }

  function corrente() {
    var v = sel ? sel.value : "1";
    if (v && v.indexOf("p:") === 0) {
      var id = v.slice(2), nome = "";
      progetti.forEach(function (p) { if (p.id === id) nome = p.nome; });
      return { tipo: "progetto", id: id, nome: nome };
    }
    var c = parseInt(v, 10);
    return { tipo: "canale", c: (c >= 1 && c <= 7) ? c : 1 };
  }

  // il corpo della richiesta: stesso payload, comando diverso
  function corpo(base) {
    var d = corrente();
    if (d.tipo === "progetto") return Object.assign({ tipo: "progetto-aggiungi", id: d.id }, base);
    return Object.assign({ tipo: "regia-load", c: d.c }, base);
  }

  // per i messaggi di conferma: "vMix 3" oppure "progetto FOOTBALL SHOW"
  function dove() {
    var d = corrente();
    return d.tipo === "progetto" ? 'progetto "' + d.nome + '"' : "vMix " + d.c;
  }

  return { adotta: adotta, corrente: corrente, corpo: corpo, dove: dove, ricarica: carica };
})();
