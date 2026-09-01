/**
 * ═══════════════════════════════════════════════════════════════════
 *  SCEGLI FOTO — il magazzino immagini dentro le pagine delle grafiche
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Ogni grafica con una foto ha due strade:
 *    • carico una foto nuova  → finisce nel magazzino (gia' funzionava)
 *    • la scelgo dal magazzino → questa finestra
 *
 *  Uso, dentro la pagina:
 *      SceltaFoto.adotta(PONTE, TOKEN);
 *      SceltaFoto.apri(function (url) { ...la foto scelta... });
 *
 *  NON tocca le Formazioni Premium, che hanno il loro magazzino
 *  dedicato (foto per cognome, pagina magazzino-foto.html).
 */
window.SceltaFoto = (function () {
  "use strict";
  var ponte = "", token = "", base = "";
  var elenco = [], caricato = false;
  var quandoScelta = null, filtro = "tutto", cerca = "";
  var finestra = null;

  function adotta(po, tk) {
    ponte = po; token = tk;
    // le immagini stanno accanto al ponte: in dev /como-tv-dev/loghi,
    // in produzione /como-tv/loghi. Cosi' l'anteprima e' sempre quella
    // dell'ambiente in cui si sta lavorando.
    base = String(po || "").replace(/\/(api|exec)$/, "");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function peso(n) {
    if (!n) return "";
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
  }

  function stile() {
    if (document.getElementById("sf-stile")) return;
    var s = document.createElement("style");
    s.id = "sf-stile";
    s.textContent =
      "#sf-velo{position:fixed;inset:0;z-index:500;background:rgba(4,6,16,.78);" +
      "  -webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);display:none;" +
      "  align-items:center;justify-content:center;}" +
      "#sf-box{width:min(980px,94vw);max-height:86vh;display:flex;flex-direction:column;" +
      "  background:linear-gradient(180deg,#141B3C,#0E1430);border:1px solid rgba(201,162,75,.4);" +
      "  border-radius:14px;padding:22px;color:#F5F1E6;font-family:'DM Sans',system-ui,sans-serif;}" +
      "#sf-box h3{font-family:'Mazzard',sans-serif;font-size:13px;font-weight:700;letter-spacing:.22em;" +
      "  text-transform:uppercase;color:#C9A24B;margin-bottom:14px;}" +
      "#sf-barra{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;}" +
      "#sf-barra input{flex:1;min-width:200px;padding:9px 12px;background:rgba(16,22,48,.66);" +
      "  border:1px solid rgba(245,241,230,.08);border-radius:5px;color:#F5F1E6;font-size:14px;}" +
      ".sf-chip{font-family:'Mazzard',sans-serif;font-size:10px;font-weight:700;letter-spacing:.14em;" +
      "  text-transform:uppercase;padding:8px 12px;border-radius:20px;cursor:pointer;" +
      "  border:1px solid rgba(245,241,230,.08);color:#D8D2C2;background:transparent;}" +
      ".sf-chip.on{border-color:#C9A24B;color:#E3C271;background:rgba(201,162,75,.1);}" +
      "#sf-griglia{overflow:auto;display:grid;gap:10px;" +
      "  grid-template-columns:repeat(auto-fill,minmax(130px,1fr));}" +
      ".sf-card{background:rgba(16,22,48,.66);border:1px solid rgba(245,241,230,.08);border-radius:9px;" +
      "  padding:8px;cursor:pointer;transition:border-color .12s;}" +
      ".sf-card:hover{border-color:#C9A24B;}" +
      ".sf-card .p{height:96px;border-radius:6px;background:#0A0F24 center/contain no-repeat;" +
      "  border:1px solid rgba(245,241,230,.06);}" +
      ".sf-card .n{margin-top:6px;font-size:11px;line-height:1.25;word-break:break-all;color:#F5F1E6;}" +
      ".sf-card .k{font-size:10px;color:#8A8B96;}" +
      "#sf-piede{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:14px;}" +
      "#sf-conta{font-size:12px;color:#8A8B96;}" +
      "#sf-box button.chiudi{font-family:'Mazzard',sans-serif;font-size:10.5px;font-weight:700;" +
      "  letter-spacing:.09em;text-transform:uppercase;padding:10px 13px;border-radius:5px;cursor:pointer;" +
      "  background:transparent;color:#D8D2C2;border:1px solid rgba(245,241,230,.08);}";
    document.head.appendChild(s);
  }

  function costruisci() {
    if (finestra) return;
    stile();
    finestra = document.createElement("div");
    finestra.id = "sf-velo";
    finestra.innerHTML =
      '<div id="sf-box">' +
        '<h3>Scegli una foto dal magazzino</h3>' +
        '<div id="sf-barra">' +
          '<button class="sf-chip on" data-f="tutto" type="button">Tutte</button>' +
          '<button class="sf-chip" data-f="foto" type="button">Foto</button>' +
          '<button class="sf-chip" data-f="loghi" type="button">Stemmi e loghi</button>' +
          '<input id="sf-cerca" type="search" placeholder="Cerca per nome…" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div id="sf-griglia"></div>' +
        '<div id="sf-piede"><span id="sf-conta"></span>' +
          '<button class="chiudi" id="sf-chiudi" type="button">Chiudi</button></div>' +
      '</div>';
    document.body.appendChild(finestra);

    finestra.addEventListener("click", function (e) {
      if (e.target === finestra) chiudi();                       // clic fuori
      var chip = e.target.closest ? e.target.closest(".sf-chip") : null;
      if (chip) {
        finestra.querySelectorAll(".sf-chip").forEach(function (c) { c.classList.toggle("on", c === chip); });
        filtro = chip.dataset.f; dipingi(); return;
      }
      var card = e.target.closest ? e.target.closest(".sf-card") : null;
      if (card) {
        var url = card.dataset.url;
        chiudi();
        if (quandoScelta) quandoScelta(url);
      }
    });
    document.getElementById("sf-chiudi").addEventListener("click", chiudi);
    document.getElementById("sf-cerca").addEventListener("input", function () {
      cerca = this.value.trim().toLowerCase(); dipingi();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && finestra && finestra.style.display === "flex") chiudi();
    });
  }

  function dipingi() {
    var g = document.getElementById("sf-griglia");
    var v = elenco.filter(function (f) {
      var premium = f.chiave.indexOf("foto-") === 0;
      if (filtro === "foto" && !premium) return false;
      if (filtro === "loghi" && premium) return false;
      if (cerca && f.chiave.toLowerCase().indexOf(cerca) < 0) return false;
      return true;
    });
    g.innerHTML = v.length
      ? v.map(function (f) {
          // l'indirizzo restituito porta il prefisso dell'ambiente, cosi'
          // la foto scelta si vede sia qui sia nella grafica in onda
          return '<div class="sf-card" data-url="' + esc(base + f.url) + '">' +
            '<div class="p" style="background-image:url(\'' + esc(base + f.url) + '\')"></div>' +
            '<div class="n">' + esc(f.chiave) + '</div>' +
            '<div class="k">' + peso(f.size) + '</div></div>';
        }).join("")
      : '<div style="color:#8A8B96;padding:16px 4px">Nessuna immagine trovata.</div>';
    document.getElementById("sf-conta").textContent =
      v.length + " di " + elenco.length + " immagini in magazzino";
  }

  function chiudi() { if (finestra) finestra.style.display = "none"; }

  function apri(callback) {
    quandoScelta = callback;
    costruisci();
    finestra.style.display = "flex";
    if (caricato) { dipingi(); return; }
    document.getElementById("sf-griglia").innerHTML =
      '<div style="color:#8A8B96;padding:16px 4px">Carico il magazzino…</div>';
    fetch(ponte + "?loghi=1", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        elenco = (j && j.loghi) || [];
        elenco.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
        caricato = true;
        dipingi();
      })
      .catch(function () {
        document.getElementById("sf-griglia").innerHTML =
          '<div style="color:#FF9A9C;padding:16px 4px">Magazzino non raggiungibile.</div>';
      });
  }

  // dopo un caricamento nuovo l'elenco va riletto
  function scorda() { caricato = false; }

  return { adotta: adotta, apri: apri, scorda: scorda };
})();
