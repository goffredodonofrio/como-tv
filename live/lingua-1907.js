/**
 * LINGUA-1907 — il MAM Como 1907 in inglese (Goffredo, 30/09/2026: "tutto in inglese per chi non e' in
 * Italia"; deciso: lingua del browser + bottone IT/EN).
 *
 * Un traduttore solo per mam-1907, cartelle-1907 e doppioni-1907. Traduce SOLO i testi dell'interfaccia:
 *  - le frasi intere che stanno in DIZ (testo di un nodo, title, placeholder, aria-label, confirm/prompt/alert);
 *  - alcune parole ricorrenti (elementi, cartelle, partite…) ma mai dentro i nomi: cartelle, file,
 *    persone, commenti restano come sono (vedi DATI).
 * La lingua: quella scelta col bottone (localStorage "mam1907-lingua"), se no inglese a chi non ha
 * l'italiano tra le lingue del browser. In italiano questo file non fa niente.
 *
 * <script src="lingua-1907.js"></script> in fondo alla pagina.
 */
(function () {
  "use strict";
  var scelta = null;
  try { scelta = localStorage.getItem("mam1907-lingua"); } catch (e) {}
  var langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "it"]).join(",");
  var L = scelta || (/(^|,)it\b/i.test(langs) ? "it" : "en");
  window.MAM1907_LINGUA = L;

  // IL BOTTONE IT / EN (nella barra in alto, accanto a chi e' entrato)
  function bottone() {
    var dove = document.querySelector(".ms-destra") || (window.NAV_MAM && window.NAV_MAM.destra);
    var c = document.getElementById("linguaMam");
    if (c && (!dove || dove.contains(c))) return;   // il menu' del sito puo' rifare la barra: allora lo rimetto
    if (c) c.remove();
    var b = document.createElement("span"); b.id = "linguaMam"; b.setAttribute("role", "group"); b.setAttribute("aria-label", L === "en" ? "language" : "lingua");
    b.innerHTML = '<button type="button" data-lg="it">IT</button><button type="button" data-lg="en">EN</button>';
    b.style.cssText = "display:inline-flex;border:1px solid rgba(201,162,75,.4);border-radius:7px;overflow:hidden;margin-right:6px;flex:0 0 auto";
    b.querySelectorAll("button").forEach(function (x) {
      var on = x.dataset.lg === L;
      x.style.cssText = "font:700 10.5px/1 Mazzard,system-ui,sans-serif;letter-spacing:.1em;padding:7px 9px;border:0;border-radius:0;cursor:pointer;" + (on ? "background:#C9A24B;color:#10131c" : "background:transparent;color:#D8D2C2");
      x.onclick = function () { try { localStorage.setItem("mam1907-lingua", x.dataset.lg); } catch (e) {} location.reload(); };
    });
    if (dove) dove.insertBefore(b, dove.firstChild);
    else { b.style.position = "fixed"; b.style.right = "14px"; b.style.bottom = "14px"; b.style.zIndex = "300"; b.style.background = "#1B1C20"; document.body.appendChild(b); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(bottone, 300); }); else setTimeout(bottone, 300);
  setTimeout(bottone, 2500);
  if (L !== "en") return;
  document.documentElement.lang = "en";

  var DIZ = {
    // la testata, la ricerca, la home
    "Buongiorno,": "Good morning,", "Buonasera,": "Good evening,", "Buon pomeriggio,": "Good afternoon,",
    "Il materiale del club: stagioni, format, documentari, academy. Cerca, guarda, commenta, condividi.": "The club's footage: seasons, formats, documentaries, academy. Search, watch, comment, share.",
    "Il materiale del club: stagioni, format, documentari, academy": "The club's footage: seasons, formats, documentaries, academy",
    "Cerca qui": "Search here", "Volti": "Faces", "Cerca": "Search", "Cerca un volto": "Search a face", "Scegli i volti": "Pick faces",
    "Como 1907": "Como 1907", "Organizza le cartelle": "Organise folders", "Tutte le stagioni": "All seasons", "Altri progetti": "Other projects",
    "Collezioni": "Collections", "Tutti i reparti": "All departments", "Scorciatoie": "Shortcuts", "Partite del Como": "Como matches",
    "Menzioni": "Mentions", "Link condivisi": "Shared links", "Doppioni 1907": "Duplicates 1907", "Raccolte 1907": "Collections 1907",
    "Nessuna ancora: tocca il": "None yet: tap the", "su una scheda e": "on a card and", "Salva in raccolta": "Save to collection",
    "Ordina": "Sort", "per data riprese": "by shooting date", "per nome": "by name", "per peso": "by size", "Griglia": "Grid", "Lista": "List",
    "Ordinate": "Sorted", "Cartelle vere": "Real folders", "Stagioni": "Seasons", "Senza stagione": "No season",
    "+ Nuova cartella": "+ New folder", "Nuova cartella": "New folder", "Sposta in…": "Move to…", "Rinomina questa cartella": "Rename this folder",
    "Cerca qui dentro": "Search in here", "Condividi la cartella": "Share this folder", "Rinomina": "Rename", "Rinomina…": "Rename…",
    "Per spostare, trascina cartelle e file su una cartella, sul percorso in alto o nella colonna a sinistra. ⌘ o Ctrl + clic per sceglierne più d’uno. Le modifiche vanno sulla NAS del club; il MAM si riallinea da solo in pochi minuti.":
      "To move, drag folders and files onto a folder, the path at the top or the left column. ⌘ or Ctrl + click to pick more than one. Changes go to the club NAS; the MAM catches up by itself in a few minutes.",
    "Le date sono quelle delle riprese, non della NAS (lì tutti i file hanno il giorno della copia, estate 2026): dal nome della cartella, dal calendario delle partite del Como, dalle cartelle vicine, dal nome del file o dall’orologio della camera.": "Dates are shooting dates, not NAS dates (there every file carries the copy date, summer 2026): from the folder name, the Como fixture list, nearby folders, the file name or the camera clock.",
    "Leggo la cartella sulla NAS…": "Reading the folder on the NAS…", "Carico…": "Loading…", "Cartella vuota.": "Empty folder.", "File": "Files",
    "Questa cartella non c’è più: forse è stata spostata o rinominata.": "This folder is gone: it may have been moved or renamed.", "Torna all’inizio": "Back to the start",
    "Non riesco a leggere la NAS del club in questo momento.": "I can't read the club NAS right now.", "Niente in questa stagione.": "Nothing in this season.",
    "Niente con questi filtri.": "Nothing with these filters.", "Servizi e partite": "Shoots and matches", "Servizio o partita": "Shoot or match",
    "Ramo": "Branch", "Data": "Date", "Durata": "Duration", "Materiale": "Footage", "Peso": "Size", "Nome": "Name", "Contenuto": "Contents",
    "Ultime riprese": "Latest shoot", "Partita": "Match", "Tipo": "Type", "Commenti": "Comments", "Elementi": "Items", "Scade": "Expires", "Visite": "Views",
    "partita intera": "full match", "materiale del club": "club footage", "Stagione": "Season", "Collezione": "Collection",
    "nell’indice da stanotte": "in the index from tonight", "vuota": "empty", "Danneggiato": "Damaged",
    // le schede, le azioni sulle clip
    "Rivedi": "Review", "Condividi": "Share", "Scarica": "Download", "Elimina": "Delete", "Scegli": "Select", "Chiudi": "Close",
    "Copia percorso": "Copy path", "Scarica l’originale": "Download the original", "Copia il link": "Copy link",
    "Condividi: link interno o esterno": "Share: internal or external link", "Scarica l’originale, così com’è": "Download the original, as it is",
    "Elimina dalla NAS del club (definitivo)": "Delete from the club NAS (permanent)", "Rivedi e commenta": "Review and comment",
    "Copia link": "Copy link", "Apri": "Open", "Apri nel MAM": "Open in the MAM", "Anteprima": "Preview", "Mostra nel MAM": "Show in the MAM",
    "Preparo l’anteprima…": "Preparing the preview…", "Anteprima non disponibile": "No preview available", "Questo formato si apre solo scaricandolo.": "This format only opens once downloaded.",
    "Questo originale il browser non lo legge": "The browser can't read this original", "Questo video è danneggiato": "This video is damaged",
    "La copia leggera non è riuscita.": "The light copy failed.", "Riprova": "Retry",
    // i commenti, lo stato
    "Stato": "Status", "Assegna a": "Assign to", "Nessuno": "None", "Da rivedere": "Needs review", "In lavorazione": "In progress", "Approvata": "Approved", "Da rifare": "Needs rework",
    "Tutti": "All", "Da risolvere": "Open", "Risolti": "Resolved", "Rispondi": "Reply", "✓ Risolvi": "✓ Resolve", "Riapri": "Reopen", "Modifica": "Edit",
    "Commenta": "Comment", "Annulla": "Cancel", "Salva": "Save", "+ fino a qui": "+ up to here", "× togli il tratto": "× remove range",
    "Scrivi un commento… @ per taggare un collega": "Write a comment… @ to tag a colleague", "Rispondi… @ per taggare": "Reply… @ to tag",
    "Invio per mandare · Maiusc+Invio a capo": "Enter to send · Shift+Enter for a new line", "Carico i commenti…": "Loading comments…",
    "I commenti non arrivano: riprova tra poco.": "Comments are not loading: try again shortly.", "i commenti lungo il video": "comments along the video",
    "il punto del video: si ferma quando scrivi": "the point in the video: it pauses while you type",
    "il commento vale per un tratto: porta il video alla fine del tratto e premi": "the comment covers a range: move the video to the end of the range and press",
    "Niente con questo filtro.": "Nothing with this filter.", "Stato aggiornato.": "Status updated.", "Assegnazione tolta.": "Assignment removed.",
    "Nessun commento. Porta il video al punto giusto, scrivi qui sotto e tagga chi deve vederlo con @.": "No comments. Move the video to the right point, write below and tag who should see it with @.",
    "Nessun commento. Scrivi qui sotto e tagga chi deve vederlo con @.": "No comments. Write below and tag who should see it with @.",
    "ti ha assegnato questa clip": "assigned this clip to you", "nuova": "new", "adesso": "now", "risolto da": "resolved by", "modificato": "edited",
    // condividere
    "Link interno": "Internal link", "Link esterno": "External link", "Titolo": "Title", "Password": "Password", "Crea il link": "Create link", "Copia": "Copy", "Revoca": "Revoke",
    "per chi entra nel MAM con Google (club e Como TV)": "for people who sign in to the MAM with Google (club and Como TV)",
    "per partner, sponsor, media: senza login, solo quello che scegli": "for partners, sponsors, media: no login, only what you pick",
    "facoltativa": "optional", "tra 1 giorno": "in 1 day", "tra 7 giorni": "in 7 days", "tra 30 giorni": "in 30 days", "tra 90 giorni": "in 90 days", "mai": "never",
    "si può scaricare l’originale": "the original can be downloaded", "Condividi con un link esterno": "Share with an external link", "Condividi (link esterno)…": "Share (external link)…",
    "Link interno copiato.": "Internal link copied.", "Link esterno copiato.": "External link copied.", "Link esterno creato e copiato.": "External link created and copied.",
    "Link copiato.": "Link copied.", "Link revocato.": "Link revoked.", "revocato": "revoked", "scaduto": "expired", "con password": "with password", "scaricabile": "downloadable",
    "I link condivisi non arrivano: riprova.": "Shared links are not loading: try again.",
    // menzioni, volti, raccolte
    "Nessuna menzione. Quando un collega ti tagga in un commento (@tuonome@comofootball.com) lo ritrovi qui.": "No mentions. When a colleague tags you in a comment (@yourname@comofootball.com) you'll find it here.",
    "Volti da battezzare": "Faces to name", "Battezza": "Name", "Non serve": "Not needed", "Sì, è lui": "Yes, that's him", "Insieme": "Together", "Uno o l’altro": "Either",
    "Vedi tutti": "See all", "Vedi tutte": "See all", "Tutte": "All", "Tutto": "All", "Solo video": "Videos only", "Solo foto": "Photos only", "Video e foto": "Videos and photos",
    "Svuota": "Clear", "Togli": "Remove", "Togli dalla raccolta": "Remove from collection", "Premiere": "Premiere", "Prepara le copie": "Prepare copies",
    "Nome della raccolta (nuova o esistente)": "Collection name (new or existing)",
    // doppioni
    "Doppioni": "Duplicates", "Cartelle copiate": "Copied folders", "File doppi": "Duplicate files", "Segnati": "Marked", "Eliminati": "Deleted",
    "Stato del materiale": "Footage status", "Da decidere": "To decide", "Già segnati": "Already marked", "solo contenuto verificato": "verified content only",
    "Può andare": "Can go", "Cartella che può andare": "Folder that can go", "Resta": "Stays", "Confronta": "Compare", "Deseleziona": "Deselect",
    "Togli il segno": "Unmark", "Segna da cancellare": "Mark for deletion", "Segnata": "Marked", "Segnata da cancellare": "Marked for deletion",
    "Nome e dimensione": "Name and size", "✓ Verificato": "✓ Verified", "✓ Contenuto verificato": "✓ Content verified", "✓ Eliminata": "✓ Deleted", "Eliminata": "Deleted",
    "Scegli tutti quelli in elenco": "Select all listed", "Ripulisci i file rimasti": "Clean up leftover files", "si possono liberare": "can be freed",
    "Carico i doppioni…": "Loading duplicates…", "Cerca nei percorsi…": "Search in paths…",
    // Cartelle 1907 (il Finder)
    "‹ Torna al MAM": "‹ Back to the MAM", "Torna alla schermata principale del MAM": "Back to the MAM main screen",
    "Eliminare dalla NAS del club?": "Delete from the club NAS?", "Elimino…": "Deleting…", "Per confermare scrivi ELIMINA": "To confirm, type ELIMINA",
    "Apri l’anteprima": "Open preview", "Stagioni": "Seasons",
    "Posizioni": "Locations", "+ Cartella": "+ Folder", "↑ Carica": "↑ Upload", "Cerca in questa cartella": "Search this folder", "Collegamenti": "Links",
    "Data modifica": "Date modified", "Dimensione": "Size", "Cartella": "Folder", "Anteprima rapida": "Quick Look", "Sposta qui": "Move here",
    "Carica dei file…": "Upload files…", "Carica dei file in questa cartella": "Upload files to this folder", "Come icone": "as Icons", "Come elenco": "as List",
    "Come colonne": "as Columns", "Come galleria": "as Gallery", "Seleziona tutto": "Select All", "Elimina dalla NAS…": "Delete from the NAS…",
    "Caricamenti": "Uploads", "chiudi": "close", "in coda": "queued", "carico": "uploading", "riprovo": "retrying", "controllo l’integrità": "checking integrity",
    "Nessuna sottocartella.": "No subfolders.", "Crea": "Create", "Rinominato.": "Renamed.", "Cartella creata.": "Folder created.",
    "Raccolte, commenti e link seguono il nome nuovo.": "Collections, comments and links follow the new name.",
    "La NAS del club non risponde. Riprova tra poco.": "The club NAS is not responding. Try again shortly.",
    "Trascina qui dei file dal Mac per caricarli.": "Drag files here from your Mac to upload them.",
    "Nessuna anteprima per questo tipo di file.": "No preview for this kind of file.",
    "La NAS del club come nel Finder. Clic destro per le azioni · ⌘1–4 le viste · Spazio l’anteprima · trascina i file dal Mac per caricarli.":
      "The club NAS, like the Finder. Right-click for actions · ⌘1–4 views · Space to preview · drag files from your Mac to upload them."
  };
  // le parole ricorrenti dentro le frasi (mai dentro i nomi)
  var PAROLE = [
    [/\belementi\b/g, "items"], [/\belemento\b/g, "item"], [/\bservizi\b/g, "shoots"], [/\bservizio\b/g, "shoot"], [/\bcartelle\b/g, "folders"], [/\bcartella\b/g, "folder"],
    [/\bpartite di Como TV\b/g, "Como TV matches"], [/\bpartite\b/g, "matches"], [/\bpartita\b/g, "match"], [/\bfoto\b/g, "photos"], [/\bStagione\b/g, "Season"],
    [/\breparti\b/g, "departments"], [/\bscelti\b/g, "selected"], [/\bscelto\b/g, "selected"], [/\bnuove\b/g, "new"], [/\bda risolvere\b/g, "open"], [/\btutti risolti\b/g, "all resolved"],
    [/\bvideo del club\b/g, "club videos"], [/\bmateriale del club\b/g, "club footage"], [/\bsi vede\b/g, "visible"], [/ · stato: /g, " · status: "],
    [/\bNe vedi\b/g, "Showing"], [/\bsu\b(?= \d)/g, "of"], [/\bMostrali tutti\b/g, "Show all"], [/\bcaricato e controllato\b/g, "uploaded and checked"], [/\bvuoto\b/g, "empty"],
    [/\bmin fa\b/g, "min ago"], [/\bh fa\b/g, "h ago"], [/\bIl link scade il\b/g, "The link expires on"]
  ];
  var DATI = ".fx-t b,.ell b,.tit > b,.etich,.nm,.testo,.c7-titolo,.fx-nome,.fx-bc a,.fx-bc b,#percorso a,.percorso a,.rc p,.cd-t b,.per,.nomec > span:last-child,.didascalia b,.lettore .info b,.lettore .info div,.ql .info b,.el-tab .tit small,.car b,.cm-nome,.menz,.c7-nome,.an-nome,[data-v] > span,#riass";
  function traduci(t) {
    if (!t) return t;
    var s = t.trim(); if (!s) return t;
    if (DIZ[s]) return t.replace(s, DIZ[s]);
    return null;
  }
  function parole(t) { var x = t; PAROLE.forEach(function (p) { x = x.replace(p[0], p[1]); }); return x; }
  function nodo(n) {
    if (n.nodeType === 3) {
      var p = n.parentNode; if (!p || /^(SCRIPT|STYLE|TEXTAREA)$/.test(p.nodeName)) return;
      var v = n.nodeValue, d = traduci(v);
      if (d != null) { if (d !== v) n.nodeValue = d; return; }
      if (p.closest && p.closest(DATI)) return;
      var w = parole(v); if (w !== v) n.nodeValue = w;
      return;
    }
    if (n.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(n.nodeName)) return;
    ["title", "placeholder", "aria-label"].forEach(function (a) { var v = n.getAttribute && n.getAttribute(a); if (v) { var d = traduci(v); var w = d != null ? d : parole(v); if (w !== v) n.setAttribute(a, w); } });
    if (n.nodeName === "OPTION" || n.nodeName === "BUTTON" || n.childNodes.length) for (var c = n.firstChild; c; c = c.nextSibling) nodo(c);
  }
  var LAVORO = false;
  var oss = new MutationObserver(function (mm) {
    if (LAVORO) return; LAVORO = true;
    try { mm.forEach(function (m) { if (m.type === "characterData") nodo(m.target); else m.addedNodes.forEach(nodo); if (m.type === "attributes") nodo(m.target); }); } finally { LAVORO = false; }
  });
  function parti() { nodo(document.body); oss.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder"] }); }
  if (document.body) parti(); else document.addEventListener("DOMContentLoaded", parti);
  // le finestre del browser (conferme, avvisi, domande)
  var c0 = window.confirm, a0 = window.alert, p0 = window.prompt;
  function tt(m) { m = String(m == null ? "" : m); var d = traduci(m); return d != null ? d : parole(m).replace(/Eliminare DEFINITIVAMENTE/g, "PERMANENTLY delete").replace(/dalla NAS del club/g, "from the club NAS").replace(/Non si recupera\./g, "It cannot be recovered.").replace(/Spostare/g, "Move").replace(/Revocare il link\?/g, "Revoke the link?"); }
  window.confirm = function (m) { return c0.call(window, tt(m)); };
  window.alert = function (m) { return a0.call(window, tt(m)); };
  window.prompt = function (m, d) { return p0.call(window, tt(m), d); };
})();
