/**
 * PRESENZE-SYNC — le ore del foglio presenze sul server, non piu' solo nel browser.
 * (Goffredo, 27/09/2026)
 *
 * Il foglio continua a lavorare come prima con la memoria del browser: questo
 * script ci sta intorno.
 *  1. All'apertura (prima che il foglio legga) chiede al server le ore salvate
 *     (/auth/presenze/<foglio>, solo il titolare e il super utente) e le unisce a
 *     quelle del browser: le voci che ci sono solo in uno dei due si tengono,
 *     sulle stesse voci vince il server. La prima volta, quello che c'era solo nel
 *     browser sale sul server: niente si perde.
 *  2. Ogni volta che il foglio salva, dopo un attimo manda tutto al server
 *     (che tiene anche lo storico delle versioni) e lo dice accanto a "Salvato".
 * Va incluso in <head>, senza async: deve girare prima del foglio.
 */
(function () {
  "use strict";
  var slug = decodeURIComponent(location.pathname.split("/").pop() || "").replace(/\.html$/, "");
  if (!slug) return;
  var PRE = "presenze_" + slug, API = "/auth/presenze/" + encodeURIComponent(slug);
  var OGGETTI = [PRE, PRE + "_manuals", PRE + "_times", PRE + "_outTimes"];
  var ls; try { ls = window.localStorage; } catch (e) { return; }

  function locali() {
    var o = {};
    for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k && k.indexOf(PRE) === 0) o[k] = ls.getItem(k); }
    return o;
  }
  function unisci(server, locale) {
    var fuori = {}, k;
    for (k in locale) fuori[k] = locale[k];
    for (k in server) {
      if (OGGETTI.indexOf(k) >= 0 && k in locale) {
        try { var a = JSON.parse(locale[k] || "{}"), b = JSON.parse(server[k] || "{}"), c = {}, x;
          for (x in a) c[x] = a[x]; for (x in b) c[x] = b[x]; fuori[k] = JSON.stringify(c); continue; } catch (e) {}
      }
      fuori[k] = server[k];
    }
    return fuori;
  }
  function uguali(a, b) { return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort()); }

  // ── 1) all'apertura: il server, prima che il foglio legga ──
  var server = null;
  try {
    var x = new XMLHttpRequest(); x.open("GET", API, false); x.send();
    if (x.status === 401) { location.replace("/auth/entra?torna=" + encodeURIComponent(location.pathname)); return; }
    if (x.status === 403) { location.replace("../foglio-presenze.html"); return; }
    if (x.status === 200) server = JSON.parse(x.responseText).chiavi || {};
  } catch (e) {}
  var daMandare = false;
  if (server) {
    var loc = locali(), unite = unisci(server, loc);
    Object.keys(unite).forEach(function (k) { try { ls.setItem(k, unite[k]); } catch (e) {} });
    daMandare = !uguali(unite, server);            // il browser aveva qualcosa che il server non sapeva
  }

  // ── 2) ogni salvataggio del foglio va anche sul server ──
  var timer = null, inVolo = false, ancora = false;
  function segna(testo, errore) {
    var ind = document.getElementById("saveInd"); if (!ind) return;
    ind.textContent = testo; ind.style.color = errore ? "#FF9A9C" : "";
  }
  function manda() {
    timer = null;
    if (inVolo) { ancora = true; return; }
    inVolo = true;
    fetch(API, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chiavi: locali() }) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); segna("✓ Salvato sul server"); })
      .catch(function () { segna("⚠ Non salvato sul server: resta nel browser, riprovo", true); setTimeout(programma, 15000); })
      .then(function () { inVolo = false; if (ancora) { ancora = false; programma(); } });
  }
  function programma() { clearTimeout(timer); timer = setTimeout(manda, 1200); }
  var set = Storage.prototype.setItem, rem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) { set.call(this, k, v); if (this === ls && String(k).indexOf(PRE) === 0) programma(); };
  Storage.prototype.removeItem = function (k) { rem.call(this, k); if (this === ls && String(k).indexOf(PRE) === 0) programma(); };
  // chiudendo la pagina con un salvataggio in sospeso, parte lo stesso
  window.addEventListener("pagehide", function () {
    if (!timer) return;
    try { navigator.sendBeacon(API, new Blob([JSON.stringify({ chiavi: locali() })], { type: "application/json" })); } catch (e) {}
  });
  if (daMandare) programma();
})();
