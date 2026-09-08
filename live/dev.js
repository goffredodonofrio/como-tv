/**
 * ═══════════════════════════════════════════════════════════════════
 *  DEV — il segnale d'ambiente
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Dev e produzione sono identiche a vedersi e si distinguono solo dal
 *  "-dev" nell'indirizzo: è bastato per perderci progetti e foto, creati
 *  di qua e cercati di là. Qui lo si vede a colpo d'occhio; in produzione
 *  non compare nulla, perché il controllo è sull'indirizzo e basta.
 *
 *  Stava dentro nav.js, e quindi mancava sulle pagine senza menù — mam,
 *  regia, partita-live, il pannello, la home. Ora è un file per conto suo:
 *  una riga sola da aggiungere, e vale ovunque lo si metta.
 *
 *  NON va nelle grafiche -vmix: quelle finiscono in onda, e un bollo
 *  arancione sopra la diretta è peggio del problema che risolve.
 *
 *  La pillola sta in BASSO a sinistra: in alto copriva le voci del menù.
 *  La riga a strisce resta sopra, dove non c'è niente da coprire.
 */
(function () {
  "use strict";

  function segnalaDev() {
    if (location.pathname.indexOf("/como-tv-dev/") < 0) return;
    if (document.getElementById("cnav-dev")) return;
    var st = document.createElement("style");
    st.textContent =
      "#cnav-dev-riga{position:fixed;left:0;right:0;top:0;height:4px;z-index:99998;" +
      "  background:repeating-linear-gradient(90deg,#FF7A1A 0 22px,#0A0F24 22px 44px);pointer-events:none;}" +
      "#cnav-dev{position:fixed;bottom:0;left:14px;z-index:99999;" +
      "  font-family:'Mazzard',system-ui,sans-serif;font-size:10px;font-weight:800;letter-spacing:.2em;" +
      "  text-transform:uppercase;color:#0A0F24;background:#FF7A1A;padding:5px 16px 4px;" +
      "  border-radius:8px 8px 0 0;box-shadow:0 -3px 12px rgba(0,0,0,.5);pointer-events:none;}";
    document.head.appendChild(st);
    var riga = document.createElement("div"); riga.id = "cnav-dev-riga";
    var b = document.createElement("div"); b.id = "cnav-dev";
    b.textContent = "DEV · ambiente di prova";
    document.body.appendChild(riga);
    document.body.appendChild(b);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", segnalaDev);
  else segnalaDev();
})();
