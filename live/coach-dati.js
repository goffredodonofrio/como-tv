/**
 * COACH-DATI — i "pezzi" della guida, uno per gesto (27/09/2026)
 * Li legge coach.js. Gli stessi pezzi sono i capitoli della guida
 * (guida/index.html): l'id del pezzo e' l'id del capitolo e del video.
 * Ogni editor di grafica senza un pezzo qui riceve da coach.js il pezzo
 * automatico "Manda ... in regia", fatto con i bottoni che la pagina ha.
 */
(function () {
  "use strict";
  function vis(e) { if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; }
  function primo(sel, cond) { var l = document.querySelectorAll(sel); for (var i = 0; i < l.length; i++) if (vis(l[i]) && (!cond || cond(l[i]))) return l[i]; return null; }
  function pannello(sel) { return function () { var e = document.querySelector(sel); return e ? (e.closest("section") || e) : null; }; }
  var aDestra = function (e) { return e.getBoundingClientRect().left > innerWidth * 0.62; };
  var SORGENTE_PRONTA = function () { var v = document.getElementById("videoS"); return v && v.currentSrc && v.readyState >= 1 ? v : null; };
  var APRI_SORGENTE = [
    { t: "Prima apri una partita: clicca Browser media", fai: "clic", su: { testo: "^browser media$", in: ".ws-giu" }, salta: SORGENTE_PRONTA },
    { t: "Scrivi il nome della partita: cremonese", fai: "scrivi", su: 'input[placeholder^="Cerca nell"]', atteso: "cremonese", salta: SORGENTE_PRONTA },
    { t: "Fai due clic sulla partita", fai: "vedi", quando: SORGENTE_PRONTA, su: { testo: "^full match ita - ", in: ".ws-giu" }, salta: SORGENTE_PRONTA }
  ];
  var APRI_MONTAGGIO = [
    { t: "Prima apri un montaggio: clicca Progetto", fai: "clic", su: { testo: "^progetto$", in: ".ws-giu" }, salta: { url: "[?&]seq=" } },
    { t: "Fai due clic su un montaggio", fai: "vedi", quando: { url: "[?&]seq=" }, su: "#bin .seqr", salta: { url: "[?&]seq=" } }
  ];
  var CAMPO = "#cercaLib", GOL = 'button.sg-t[data-sg="r|gol|Gol"]';
  // per le lezioni "dentro una partita": se sei gia' in una partita questi tre passi si saltano
  var APRI_PARTITA = [
    { t: "Prima apri una partita. Scrivi: nico paz", fai: "scrivi", su: "#cercaLib", atteso: "nico paz", salta: { url: "[?&]asset=" } },
    { t: "Nel menu clicca Nico Paz (Como)", fai: "clic", su: { testo: "^.{0,3}nico paz\\s*como", in: "#suggerisci", tag: "a" }, salta: { url: "[?&]asset=" } },
    { t: "Clicca una sua azione: si apre la partita", fai: "vedi", quando: { url: "[?&]asset=" }, su: "a.card", salta: { url: "[?&]asset=" } }
  ];
  var PEZZI = [
    // ═══════ HOME ═══════
    { id: "00-home", area: "Home", titolo: "Orientarsi nella home", video: "00-home", pagine: ["home"], passi: [
      { t: "Le tessere sono gli strumenti. In alto a sinistra la Guida", fai: "leggi", su: { testo: "^guida$", tag: ".tool-name" } },
      { t: "LIVE: grafiche in onda, redazione, regia, telecronaca", fai: "leggi", su: { testo: "^live$", tag: ".hub-titolo span" } },
      { t: "MAM e Magazzino: archivio, raccolte, montaggio, immagini", fai: "leggi", su: { testo: "^mam e magazzino$", tag: ".hub-titolo span" } },
      { t: "La barra in alto è uguale in tutte le pagine: clicca MAM", fai: "clic", su: { testo: "^mam$", tag: "a" } }
    ] },

    // ═══════ MAM ═══════
    { id: "m01", area: "MAM", titolo: "La pagina del MAM", video: "m01", pagine: ["mam"], pagina: "live/mam2.html", passi: [
      { t: "Qui scrivi cosa cerchi", fai: "leggi", su: "#campoG" },
      { t: "Questo riquadro dice quante partite sono pronte", fai: "leggi", su: { testo: "^archivio.*utilizzabili", tag: "div,section" } },
      { t: "Sfoglia: per guardare senza cercare", fai: "leggi", su: "#libCat" },
      { t: "Sotto, tutte le partite: la più recente in cima", fai: "leggi", su: "table.lista" }
    ] },
    { id: "m02", area: "MAM", titolo: "Cercare una partita", video: "m02", pagine: ["mam", "mam-partita"], pagina: "live/mam2.html", passi: [
      { t: "Clicca nel campo di ricerca", fai: "clic", su: CAMPO },
      { t: "Scrivi: como", fai: "scrivi", su: CAMPO, atteso: "como" },
      { t: "Nel menu, sotto Squadre, clicca Como", aiuto: "Clicca la squadra nel menu: non premere Invio.", fai: "clic", su: { testo: "^como( |\\d|ita|$)", in: "#suggerisci", tag: "a" } },
      { t: "Ora scrivi: genoa", fai: "scrivi", su: CAMPO, atteso: "genoa" },
      { t: "Clicca Genoa nel menu", fai: "clic", su: { testo: "^genoa( |\\d|ita|$)", in: "#suggerisci", tag: "a" } },
      { t: "Ecco la partita fra le due squadre", fai: "vedi", quando: { url: "[?&]asset=" }, su: "a.card" }
    ] },
    { id: "m03", area: "MAM", titolo: "Sfogliare l'archivio", video: "m03", pagine: ["mam"], pagina: "live/mam2.html", passi: [
      { t: "Apri il menu delle competizioni", fai: "clic", su: { testo: "^tutte le competizioni", tag: "button" } },
      { t: "Scegli Serie A", fai: "clic", su: { testo: "^serie a\\b", tag: "label,button,li,a,span" } },
      { t: "Clicca Anteprime: le partite come copertine", fai: "clic", su: { testo: "anteprime", tag: "button" } },
      { t: "Clicca Lista per tornare all'elenco", fai: "clic", su: { testo: "lista", tag: "button" } }
    ] },
    { id: "m04", area: "MAM", titolo: "Cercare un giocatore", video: "m04", pagine: ["mam"], pagina: "live/mam2.html", passi: [
      { t: "Clicca nel campo di ricerca", fai: "clic", su: CAMPO },
      { t: "Scrivi: nico paz", fai: "scrivi", su: CAMPO, atteso: "nico paz" },
      { t: "Nel menu clicca Nico Paz (Como)", aiuto: "Clicca il giocatore nel menu: così il MAM sa che è proprio lui.", fai: "clic", su: { testo: "^.{0,3}nico paz\\s*como", in: "#suggerisci", tag: "a" } },
      { t: "Ecco la sua scheda: i suoi numeri nell'archivio", fai: "leggi", su: ".sg-tessere" },
      { t: "Clicca una sua azione: la partita parte da lì", fai: "clic", su: "a.card" }
    ] },
    { id: "m05", area: "MAM", titolo: "Solo i gol, solo gli assist", video: "m05", pagine: ["mam"], pagina: "live/mam2.html", passi: [
      { t: "Scrivi: nico paz", fai: "scrivi", su: CAMPO, atteso: "nico paz" },
      { t: "Nel menu clicca Nico Paz (Como)", aiuto: "Clicca il giocatore nel menu: così il MAM sa che è proprio lui.", fai: "clic", su: { testo: "^.{0,3}nico paz\\s*como", in: "#suggerisci", tag: "a" } },
      { t: "Clicca la casella Gol: restano solo i gol", aiuto: "Nella scheda di Nico Paz, il primo numero.", fai: "clic", su: GOL },
      { t: "Apri Filtri: competizione e stagione", fai: "clic", su: { testo: "^filtri", tag: "button" } }
    ] },
    { id: "m06", area: "MAM", titolo: "Cercare una frase della telecronaca", video: "m06", pagine: ["mam"], pagina: "live/mam2.html", passi: [
      { t: "Scrivi la frase tra virgolette: \"che gol\"", aiuto: "Le virgolette dicono al MAM che è una frase, non un nome.", fai: "scrivi", su: CAMPO, atteso: "\"che gol\"" },
      { t: "Premi Invio", fai: "tasto", tasto: "Enter", su: CAMPO },
      { t: "Clicca un momento: la partita parte lì", fai: "clic", su: "a.card" }
    ] },
    { id: "m07", area: "MAM", titolo: "Guardare una partita", video: "m07", pagine: ["mam", "mam-partita"], pagina: "live/mam2.html", passi: APRI_PARTITA.concat([
      { t: "Premi Spazio: parte", fai: "tasto", tasto: " ", su: "#video" },
      { t: "Premi J: indietro di 10 secondi", fai: "tasto", tasto: "j", su: "#video" },
      { t: "Premi L: avanti (ancora L: più veloce)", fai: "tasto", tasto: "l", su: "#video" },
      { t: "Premi K: ferma", fai: "tasto", tasto: "k", su: "#video" },
      { t: "Freccia destra: un fotogramma avanti", fai: "tasto", tasto: "ArrowRight", su: "#video" }
    ]) },
    { id: "m08", area: "MAM", titolo: "La barra della partita", video: "m08", pagine: ["mam", "mam-partita"], pagina: "live/mam2.html", passi: APRI_PARTITA.concat([
      { t: "Questa è la barra: sopra la casa, sotto gli ospiti", fai: "leggi", su: ".momenti-riga" },
      { t: "Clicca un pallone: il video salta al gol", aiuto: "Il pallone è un gol. Passaci sopra per vedere l'azione.", fai: "clic", su: "#momenti .az.gol" }
    ]) },
    { id: "m09", area: "MAM", titolo: "Le azioni della partita", video: "m09", pagine: ["mam", "mam-partita"], pagina: "live/mam2.html", passi: APRI_PARTITA.concat([
      { t: "Nel campo a destra scrivi un nome: paz", fai: "scrivi", su: "#cercaS", atteso: "paz" },
      { t: "Spunta un'azione: la scegli per il montaggio", fai: "clic", su: function () { return primo("input[type=checkbox]", aDestra); } }
    ]) },
    { id: "m10", area: "MAM", titolo: "Scegliere le azioni e usarle", video: "m10", pagine: ["mam"], pagina: "live/mam2.html", passi: [
      { t: "Scrivi: nico paz", fai: "scrivi", su: CAMPO, atteso: "nico paz" },
      { t: "Nel menu clicca Nico Paz (Como)", aiuto: "Clicca il giocatore nel menu: così il MAM sa che è proprio lui.", fai: "clic", su: { testo: "^.{0,3}nico paz\\s*como", in: "#suggerisci", tag: "a" } },
      { t: "Clicca il + su un'azione", fai: "clic", su: "a.card button.scegli" },
      { t: "Clicca il + su un'altra azione", fai: "clic", su: function () { return primo("a.card button.scegli", function (b) { return b.getAttribute("aria-pressed") !== "true"; }); } },
      { t: "Salva in raccolta: dagli un nome", aiuto: "In palestra la raccolta resta nell'ambiente di prova.", fai: "clic", su: { testo: "salva in raccolta", tag: "button" } }
    ] },
    { id: "02-raccolte", area: "MAM", titolo: "Mandare una macchia in regia", video: "02-raccolte", pagine: ["mam", "raccolte"], pagina: "live/mam2.html", passi: [
      { t: "Si parla dei pali di Nico Paz? Scrivi: nico paz", fai: "scrivi", su: CAMPO, atteso: "nico paz" },
      { t: "Nel menu clicca Nico Paz (Como)", aiuto: "Clicca il giocatore nel menu: così il MAM sa che è proprio lui.", fai: "clic", su: { testo: "^.{0,3}nico paz\\s*como", in: "#suggerisci", tag: "a" } },
      { t: "Clicca la casella Pali (o Tiri)", fai: "clic", su: ['button.sg-t[data-sg="r|palo|Palo"]', 'button.sg-t[data-sg="r|tiro|Tiro"]'] },
      { t: "Clicca il + sulle azioni da mandare", fai: "clic", su: "a.card button.scegli" },
      { t: "Nella barra in basso clicca Invia alla regia", fai: "clic", su: function () { var l = document.querySelectorAll("button"); for (var i = 0; i < l.length; i++) { var b = l[i]; if (vis(b) && /invia alla regia/i.test(b.textContent) && b.getBoundingClientRect().top > innerHeight * 0.6) return b; } return null; } },
      { t: "Scegli il vMix", fai: "scegli", su: function () { var l = document.querySelectorAll("select"); for (var i = 0; i < l.length; i++) if (vis(l[i]) && /vmix/i.test(l[i].textContent)) return l[i]; return null; } },
      { t: "Clicca Invia alla regia: parte un filmato grezzo", aiuto: "8 secondi prima e 10 dopo ogni azione. In palestra finisce nella scaletta di prova.", fai: "clic", su: function () { var l = document.querySelectorAll("button"); var c = null; for (var i = 0; i < l.length; i++) { var b = l[i]; if (vis(b) && /invia alla regia/i.test(b.textContent) && b.getBoundingClientRect().top < innerHeight * 0.6) c = b; } return c; } }
    ] },

    // ═══════ EDITING (palestra: si costruisce davvero) ═══════
    { id: "e01", area: "Editing", titolo: "Le zone dell'Editing", video: "e01", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: [
      { t: "Sorgente: la partita da cui prendi i pezzi", fai: "leggi", su: pannello("#videoS") },
      { t: "Programma: il tuo montaggio", fai: "leggi", su: pannello("#videoE") },
      { t: "Timeline: i pezzi uno dopo l'altro", fai: "leggi", su: pannello("#pista") },
      { t: "Pannelli: partite (Browser media) e montaggi (Progetto)", fai: "leggi", su: pannello("#bin") }
    ] },
    { id: "e02", area: "Editing", titolo: "Aprire una partita", video: "e02", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: [
      { t: "Clicca Browser media", fai: "clic", su: { testo: "^browser media$", in: ".ws-giu" } },
      { t: "Scrivi il nome della partita: cremonese", fai: "scrivi", su: 'input[placeholder^="Cerca nell"]', atteso: "cremonese" },
      { t: "Fai due clic sulla partita", fai: "vedi", quando: SORGENTE_PRONTA, su: { testo: "^full match ita - ", in: ".ws-giu" } },
      { t: "Clicca sul video e premi Spazio", fai: "tasto", tasto: " ", su: "#videoS" }
    ] },
    { id: "e03", area: "Editing", titolo: "Segnare inizio e fine", video: "e03", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_SORGENTE.concat([
      { t: "Clicca sul video, poi premi I: inizio del pezzo", fai: "tasto", tasto: "i", su: "#videoS" },
      { t: "Guarda l'azione (Spazio) e premi O alla fine", fai: "tasto", tasto: "o", su: "#videoS" },
      { t: "Qui leggi inizio, fine e durata", fai: "leggi", su: function () { var e = document.getElementById("srgTIn"); return e ? e.parentElement : null; } }
    ]) },
    { id: "e04", area: "Editing", titolo: "Mettere il pezzo nel montaggio", video: "e04", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_SORGENTE.concat([
      { t: "Clicca sul video e premi I all'inizio dell'azione", fai: "tasto", tasto: "i", su: "#videoS" },
      { t: "Premi O alla fine dell'azione", fai: "tasto", tasto: "o", su: "#videoS" },
      { t: "Premi la virgola (o INSERISCI) e dai un nome", fai: "vedi", quando: { url: "[?&]seq=" }, su: "#srgInserisci" },
      { t: "Il pezzo è nella timeline: il montaggio è nato", fai: "leggi", su: "#pista" }
    ]) },
    { id: "e05", area: "Editing", titolo: "Aggiungere altri pezzi", video: "e05", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_SORGENTE.concat([
      { t: "Nella Sorgente vai a un'altra azione e premi I", fai: "tasto", tasto: "i", su: "#videoS" },
      { t: "Premi O alla fine", fai: "tasto", tasto: "o", su: "#videoS" },
      { t: "Premi la virgola: il pezzo va dopo la testina", fai: "tasto", tasto: ",", su: "#srgInserisci" },
      { t: "Clicca tutta: vedi tutto il montaggio", fai: "clic", su: "#eTutta" }
    ]) },
    { id: "e06", area: "Editing", titolo: "Guardare il montaggio", video: "e06", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_MONTAGGIO.concat([
      { t: "Clicca nella timeline e premi Spazio", fai: "tasto", tasto: " ", su: "#pista" },
      { t: "Freccia giù: il pezzo dopo", fai: "tasto", tasto: "ArrowDown", su: "#pista" },
      { t: "Home: torna all'inizio", fai: "tasto", tasto: "Home", su: "#pista" },
      { t: "Clicca sul righello per spostarti", fai: "clic", su: "#cRig" }
    ]) },
    { id: "e07", area: "Editing", titolo: "Togliere un pezzo (e annullare)", video: "e07", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_MONTAGGIO.concat([
      { t: "Clicca un pezzo: si illumina", fai: "clic", su: "#pista [data-i]" },
      { t: "Premi Canc (o Backspace)", fai: "tasto", tasto: ["Backspace", "Delete"], su: "#pista" },
      { t: "Premi Cmd + Z: torna com'era", fai: "tasto", tasto: "z", cmd: true, su: "#pista" }
    ]) },
    { id: "e08", area: "Editing", titolo: "Tagliare un pezzo in due", video: "e08", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_MONTAGGIO.concat([
      { t: "Premi C: prendi la lametta", fai: "tasto", tasto: "c", su: "#attrezzi" },
      { t: "Clicca un pezzo dove vuoi tagliarlo", fai: "clic", su: "#pista [data-i]" },
      { t: "Premi V: torni alla freccia", fai: "tasto", tasto: "v", su: "#attrezzi" }
    ]) },
    { id: "e09", area: "Editing", titolo: "Accorciare un pezzo", video: "e09", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_MONTAGGIO.concat([
      { t: "Trascina il bordo di un pezzo", aiuto: "Porta il mouse sul bordo: il pezzo si accorcia o si allunga.", fai: "leggi", su: "#pista [data-i]" },
      { t: "Oppure: testina nel punto giusto e premi Q (taglia l'inizio)", fai: "tasto", tasto: ["q", "w"], su: "#pista" }
    ]) },
    { id: "e10", area: "Editing", titolo: "Scrivere un titolo", video: "e10", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_MONTAGGIO.concat([
      { t: "Clicca nella timeline e premi T", aiuto: "Ti chiede il nome grande, la riga piccola e dove metterlo.", fai: "tasto", tasto: "t", su: "#pista" },
      { t: "Il titolo è sul video e sopra i pezzi", fai: "leggi", su: pannello("#videoE") }
    ]) },
    { id: "e11", area: "Editing", titolo: "Orizzontale o verticale", video: "e11", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_MONTAGGIO.concat([
      { t: "Clicca 9:16: verticale per storie e reel", fai: "clic", su: { testo: "^9:16$", tag: "button" } },
      { t: "Clicca 16:9 per tornare orizzontale", fai: "clic", su: { testo: "^16:9$", tag: "button" } }
    ]) },
    { id: "e12", area: "Editing", titolo: "Esportare il video", video: "e12", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_MONTAGGIO.concat([
      { t: "In basso a sinistra apri Esporta", fai: "clic", su: { testo: "^esporta$", in: ".ws-giu" } },
      { t: "Clicca Esporta… (o Cmd + M)", fai: "clic", su: "#eApriEsporta" },
      { t: "A sinistra spunta i formati", fai: "clic", su: { testo: "^9:16", tag: "label,div,span" } },
      { t: "Spunta: metti anche in una raccolta", fai: "clic", su: { testo: "metti anche in una raccolta", tag: "label,span,div" } },
      { t: "ESPORTA fa partire il file (in palestra non premerlo)", aiuto: "L'esportazione usa il server: in allenamento fermati qui.", fai: "leggi", su: { testo: "^esporta$", tag: "button" } }
    ]) },
    { id: "e13", area: "Editing", titolo: "Ritrovare un montaggio", video: "e13", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: [
      { t: "Clicca Progetto, in basso a sinistra", fai: "clic", su: { testo: "^progetto$", in: ".ws-giu" } },
      { t: "Due clic su un montaggio per aprirlo", fai: "vedi", quando: { url: "[?&]seq=" }, su: "#bin .seqr" }
    ] },
    { id: "e14", area: "Editing", titolo: "Tutti i tasti", video: "e14", pagine: ["editing"], pagina: "live/mam2.html?montaggio=1", passi: APRI_MONTAGGIO.concat([
      { t: "Clicca nella timeline e premi ?", fai: "tasto", tasto: "?", su: "#pista" }
    ]) },

    // ═══════ GRAFICHE LIVE ═══════
    { id: "05-grafiche-live", area: "Grafiche live", titolo: "Il catalogo delle grafiche", video: "05-grafiche-live", pagine: ["classifiche"], pagina: "live/classifiche.html", passi: [
      { t: "Ogni anteprima è la grafica vera: passaci sopra", fai: "leggi", su: { testo: "^formazioni premium con foto$", tag: "h3,h2,div,span,b" } },
      { t: "Clicca Apri l'editor su Formazioni Premium con foto", fai: "vedi", quando: { url: "formazioni-premium\\.html" }, su: function () { var l = document.querySelectorAll("a"); for (var i = 0; i < l.length; i++) if (vis(l[i]) && /formazioni-premium\.html$/.test(l[i].getAttribute("href") || "")) return l[i]; return null; } }
    ] },
    { id: "g01", area: "Grafiche live", titolo: "Preparare le formazioni (Premium con foto)", video: "g01", pagine: ["formazioni-premium"], pagina: "live/formazioni-premium.html", sostituisceGenerico: true, passi: [
      { t: "Nel riquadro in alto scegli la competizione", fai: "scegli", su: "select.ufComp" },
      { t: "Scegli il giorno della partita", fai: "scegli", su: "input.ufData" },
      { t: "Scegli la partita", fai: "scegli", su: "select.ufMatch" },
      { t: "Clicca Prendi le formazioni", fai: "clic", su: "button.ufCarica" },
      { t: "Controlla gli undici: nomi, numeri, foto", aiuto: "Un nome sbagliato si corregge nella sua casella. Senza foto c'è la versione solo maglie.", fai: "leggi", su: "input.slotpick" },
      { t: "Clicca Anteprima e guardala", fai: "clic", su: { testo: "^anteprima$", tag: "button.modebtn" } },
      { t: "Scegli il vMix", fai: "scegli", su: "#canaleSel" },
      { t: "Clicca Invia alla regia", aiuto: "In palestra arriva nella scaletta di prova, non in onda.", fai: "clic", su: "#btnRegia2" }
    ] },
    { id: "g01b", area: "Grafiche live", titolo: "I risultati della giornata", pagine: ["risultati"], pagina: "live/risultati.html", sostituisceGenerico: true, passi: [
      { t: "Scegli la competizione", fai: "scegli", su: "#comp" },
      { t: "Scegli i giorni: dal", fai: "scegli", su: "#dal" },
      { t: "…al", fai: "scegli", su: "#al" },
      { t: "Clicca Carica", fai: "clic", su: "#btnLoad" },
      { t: "Clicca Anteprima", fai: "clic", su: "#btnPrevG" },
      { t: "Scegli il vMix", fai: "scegli", su: "#canaleSel" },
      { t: "Clicca Invia alla regia", fai: "clic", su: "#btnRegia" }
    ] },
    { id: "g02", area: "Grafiche live", titolo: "Correggere una grafica in scaletta", video: "g02", pagine: ["redazione"], pagina: "live/redazione.html", sostituisceGenerico: true, passi: [
      { t: "Da dove: scegli il canale", fai: "scegli", su: "#fonte" },
      { t: "Chi corregge: scegli il tuo nome", fai: "scegli", su: "#chi" },
      { t: "Clicca la grafica nella scaletta", fai: "clic", su: "#voci .voce" },
      { t: "Correggi i campi e clicca Anteprima", fai: "clic", su: "#btnAnteprima" },
      { t: "Dove va: Al suo posto", fai: "scegli", su: "#canaleSel" },
      { t: "Clicca Invia alla regia", fai: "clic", su: "#btnRegia" }
    ] },

    // ═══════ ALTRI STRUMENTI ═══════
    { id: "04-magazzino", area: "Altri strumenti", titolo: "Trovare un'immagine nel Magazzino", video: "04-magazzino", pagine: ["magazzino"], pagina: "live/magazzino.html", passi: [
      { t: "Scrivi: nico paz", fai: "scrivi", su: "#cerca", atteso: "nico paz" },
      { t: "Clicca Nico Paz nel menu", fai: "clic", su: { testo: "^nico paz", tag: "a,button,li" } },
      { t: "Clicca una foto per vederla grande", fai: "clic", su: "button.im" }
    ] },
    { id: "06-telecronaca", area: "Altri strumenti", titolo: "Prendere la formazione per la telecronaca", video: "06-telecronaca", pagine: ["telecronaca"], pagina: "live/telecronaca.html", passi: [
      { t: "Scegli il giorno", fai: "clic", su: "button.gg" },
      { t: "Clicca una partita", fai: "clic", su: "div.scheda" },
      { t: "Clicca Prendi la formazione", fai: "clic", su: "#btnPrendi" },
      { t: "Prendi la penna e disegna sul campo", fai: "clic", su: { testo: "penna", tag: "button" } }
    ] },
    { id: "07-grafiche-statiche", area: "Grafiche statiche", titolo: "Fare una copertina", video: "07-grafiche-statiche", pagine: ["statiche"], pagina: "10_Look%26Feel/Como%20TV%20OTT%20Design/generatore.html", passi: [
      { t: "Scegli la partita dal menu in alto", aiuto: "Riempie da solo competizione, squadre, data e ora. Si può anche scrivere a mano.", fai: "scegli", su: "#airtableEventSelect" },
      { t: "Controlla i campi a sinistra", fai: "leggi", su: function () { var e = document.querySelector("input"); return e ? (e.closest("section,.pannello,.card,div[class*=cont]") || e.parentElement.parentElement) : null; } },
      { t: "Clicca SELEZIONA su un gruppo di modelli", fai: "clic", su: "button.gselbtn" },
      { t: "Scarica: la freccia in alto a destra, o lo ZIP per tutti", fai: "leggi", su: ["#dlAll", "#dlPng"] }
    ] },
    { id: "07b-social", area: "Grafiche statiche", titolo: "Fare un post per i social", pagine: ["social"], pagina: "10_Look%26Feel/Como%20TV%20OTT%20Design/generatore.html?solo=social", passi: [
      { t: "Scegli la partita dal menu in alto", fai: "scegli", su: "#airtableEventSelect" },
      { t: "Clicca SELEZIONA su Social media", aiuto: "Il primo gruppo: i formati per il feed e le storie.", fai: "clic", su: "button.gselbtn" },
      { t: "Clicca il mirino: sposti la foto nel riquadro", fai: "clic", su: "#tMirino" },
      { t: "Scarica tutto nello ZIP", fai: "leggi", su: "#dlAll" }
    ] },
  ];
  window.COACH_DATI = { pezzi: PEZZI };
})();
