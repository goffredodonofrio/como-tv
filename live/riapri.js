/* Riapri — un editor che riprende una grafica GIA' in scaletta
 * --------------------------------------------------------------
 * La Redazione apre l'editor di una grafica con la grafica dentro:
 *
 *   formazioni-premium.html?riapri=<id>&canale=<c>&chi=<nome>&incorporato=1
 *   formazioni-premium.html?riapri=<pid>&progetto=<id>&chi=<nome>&incorporato=1
 *
 * Questo modulo legge i dati dal ponte e li passa all'editor, che li rimette
 * nei suoi campi con Riapri.quando(function (dati) {...}). Poi ruba il corpo
 * della richiesta di invio: "Invia alla regia" non aggiunge una grafica
 * nuova, SOSTITUISCE quella al suo posto (stessa riga, stesso livello), con
 * scritto chi l'ha corretta. L'editor non deve sapere niente: chiama
 * Destinazione.corpo come sempre.
 *
 * "incorporato": l'editor sta dentro la pagina Redazione, quindi via barra e
 * testata; in cima resta una striscia che dice cosa si sta correggendo.
 */
window.Riapri = (function () {
  "use strict";

  var q = new URLSearchParams(location.search);
  var id = q.get("riapri") || "";
  var canale = parseInt(q.get("canale"), 10) || 0;
  var progetto = q.get("progetto") || "";
  var chi = q.get("chi") || "";
  var incorporato = q.get("incorporato") === "1";
  var attivo = !!id && (canale > 0 || !!progetto);

  var dati = null, titolo = "", tipo = "";
  var inAttesa = [];         // gli editor che aspettano i dati

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // il ponte: lo stesso indirizzo dell'editor (riscritto dallo script di
  // installazione), preso dalla pagina quando c'e', altrimenti /api
  // Lo script d'installazione riscrive l'indirizzo del ponte solo nelle
  // pagine, non qui: si legge quindi dalla pagina che ci ospita. In dev e'
  // "/como-tv-dev/api", in produzione "/api"; sbagliare vorrebbe dire
  // scrivere sul ponte sbagliato, quindi niente indovinelli.
  function ponte() {
    var html = document.documentElement.innerHTML;
    var m = html.match(/"(\/(?:como-tv(?:-dev)?\/)?api)"/);
    if (m) return m[1];
    var g = html.match(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/);
    return g ? g[0] : "/api";
  }
  function token() { return window.ChiaveComoTV ? ChiaveComoTV.valore() : ""; }

  function striscia(testo, classe) {
    var s = document.getElementById("riapri-striscia");
    if (!s) {
      var st = document.createElement("style");
      st.textContent =
        "#riapri-striscia{position:sticky;top:0;z-index:300;display:flex;align-items:center;gap:12px;" +
        "  padding:10px 18px;background:rgba(201,162,75,.14);border-bottom:1px solid rgba(201,162,75,.45);" +
        "  font-family:'DM Sans',system-ui,sans-serif;font-size:13px;color:#F5F1E6;" +
        "  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);}" +
        "#riapri-striscia b{font-family:'Mazzard',system-ui,sans-serif;font-weight:800;letter-spacing:.08em;" +
        "  text-transform:uppercase;color:#E3C271;}" +
        "#riapri-striscia.err{background:rgba(229,27,32,.14);border-color:rgba(229,27,32,.5);}" +
        (incorporato ? ".cnav,.cnav-giu,header.page,#cnav-ora{display:none !important;} body{padding-top:0 !important;}" : "");
      document.head.appendChild(st);
      s = document.createElement("div");
      s.id = "riapri-striscia";
      document.body.insertBefore(s, document.body.firstChild);
    }
    s.className = classe || "";
    s.innerHTML = testo;
  }

  function consegna() {
    inAttesa.forEach(function (fn) { try { fn(dati, { titolo: titolo, tipo: tipo }); } catch (e) { console.error(e); } });
    inAttesa = [];
  }

  function leggi() {
    striscia("<b>Correzione</b> carico la grafica dalla scaletta…");
    var p;
    if (canale) {
      p = fetch(ponte() + "?regia=item&id=" + encodeURIComponent(id) + "&canale=" + canale, { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          // il titolo sta nella scaletta, non nel pacchetto
          return fetch(ponte() + "?regia=1&canale=" + canale, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              var it = ((j && j.items) || []).filter(function (x) { return x.id === id; })[0];
              titolo = it ? it.titolo : ""; tipo = it ? it.tipo : "";
              return d;
            });
        });
    } else {
      p = fetch(ponte(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
                           body: JSON.stringify({ token: token(), tipo: "progetto-item", id: progetto, pid: id }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.errore) || "grafica non trovata");
          titolo = j.titolo || ""; tipo = j.tipo || "";
          return j.dati || {};
        });
    }
    p.then(function (d) {
      dati = d || {};
      striscia("<b>Correzione</b> stai correggendo “" + esc(titolo || tipo) + "”: " +
               "<i>Invia alla regia</i> la sostituisce al suo posto in scaletta" +
               (chi ? ", a nome di " + esc(chi) : "") + ".");
      consegna();
    }).catch(function (e) {
      striscia("<b>Correzione</b> non riesco a leggere la grafica: " + esc(e.message || e), "err");
    });
  }

  // l'editor si registra qui: riceve i dati appena ci sono
  function quando(fn) {
    if (!attivo) return;
    if (dati) { try { fn(dati, { titolo: titolo, tipo: tipo }); } catch (e) { console.error(e); } }
    else inAttesa.push(fn);
  }

  // il corpo dell'invio: da "aggiungi" a "sostituisci"
  function rubaDestinazione() {
    if (!window.Destinazione) return;
    var D = window.Destinazione;
    D.corpo = function (base) {
      var b = Object.assign({}, base);
      delete b.dest;
      if (canale) return Object.assign({ tipo: "regia-dati", c: canale, id: id, chi: chi }, b);
      return Object.assign({ tipo: "progetto-dati", id: progetto, pid: id, chi: chi }, b);
    };
    // gli editor scrivono "aggiunta a " + dove(): deve leggersi di seguito
    D.dove = function () { return "scaletta, al posto di “" + (titolo || "questa grafica") + "”"; };
    // la tendina della destinazione non conta piu': si spegne per non
    // far credere che si possa scegliere dove mandare
    var sel = document.getElementById("canaleSel");
    if (sel) { sel.disabled = true; sel.title = "Correzione: la grafica torna al suo posto in scaletta"; }
  }

  if (attivo) {
    // il DOM puo' non esserci ancora: si aspetta
    var via = function () { rubaDestinazione(); leggi(); };
    // "Nome in scaletta di regia?": qui il nome non cambia, la grafica
    // torna al suo posto. La domanda si risponde da sola col proposto.
    window.prompt = function (testo, proposto) { return proposto == null ? "" : String(proposto); };
    // dentro la Redazione la pagina che ci ospita adatta l'altezza del
    // telaio a quella nostra: un solo scroll, il suo
    if (incorporato && window.parent !== window) {
      setInterval(function () {
        try { window.parent.postMessage({ comotv: "riapri-altezza", h: document.documentElement.scrollHeight }, "*"); } catch (e) {}
      }, 400);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", via);
    else setTimeout(via, 0);
    // ogni invio riuscito avvisa la pagina che ci ospita, che rilegge la scaletta
    var f0 = window.fetch;
    window.fetch = function (u, o) {
      var p = f0.apply(this, arguments);
      try {
        var corpo = o && o.body ? String(o.body) : "";
        if (corpo.indexOf('"regia-dati"') >= 0 || corpo.indexOf('"progetto-dati"') >= 0) {
          p.then(function (r) { return r.clone().json(); }).then(function (j) {
            if (j && j.ok && window.parent !== window) {
              window.parent.postMessage({ comotv: "riapri-aggiornata", id: id }, "*");
            }
          }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  return { attivo: attivo, incorporato: incorporato, quando: quando, chi: chi,
           id: id, canale: canale, progetto: progetto };
})();
