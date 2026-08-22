// Estensione Generatore OTT ↔ Airtable
// Legge Live Events da Airtable (dagli ultimi 2 giorni in avanti, tutto il calendario) e popola il pannello "Importa"

var EVENTS_DATA = [];
var AIRTABLE_CONFIG = {
  baseId: 'appdDMcS8JQ4PTdLB',
  tableId: 'tblXKPRWFCLw5pVSt',
  token: null // Salvato in sessionStorage al primo caricamento
};

// Mappatura: nomi italiani Airtable → compKey generatore (per loghi e squadre)
var COMP_MAPPING = {
  'Bundesliga Austria': 'bundesliga_austria',
  'Eredivisie': 'eredivisie',
  'Scottish Premiership': 'scottish_premiership',
  'Saudi Pro League': 'saudi_pro',
  'Carabao Cup': 'carabao',
  'DFB-Pokal': 'dfb_pokal',
  'Coppa di Germania': 'dfb_pokal',
  'Coupe de France': 'coupe_france',
  'Premier Sports Cup': 'scottish_lc',
  'Scottish Cup': 'scottish_cup',
  'Taça de Portugal': 'taca',
  'SuperSport HNL': 'hnl',
  'Copa Libertadores': 'libertadores',
  'Copa Sudamericana': 'sudamericana',
  'Recopa Sudamericana': 'recopa',
  'LPF Argentina': 'lpf',
  'Clausura Liga Profesional': 'lpf', // Argentina
  'Supercopa Internacional': 'supercopa_int',
  'Trofeo de Campeones': 'trofeo_campeones',
  'Saudi Super Cup': 'saudi_super',
  'Scottish Championship': 'scottish_championship',
  'Championship': 'scottish_championship',
  'EFL Championship': 'efl_championship',
  'Supertaça Portugal': 'supertaca',
  'Serie A': 'serie_a',
  'Coppa Italia': 'coppa_italia',
  'Coppa Italia Primavera': 'coppa_italia_primavera',
  'Primavera 1': 'primavera1',
  'Como 1907 | Prima Squ...': 'como_cup', // Fallback per Como
  'Studio Live': '', // Nessun logo per programmi
};

function getAirtableToken() {
  // Prova sessionStorage
  if (sessionStorage.airtableToken) return sessionStorage.airtableToken;

  // Chiedi all'utente
  var tok = prompt('Inserisci il token Airtable PAT per continuare:');
  if (tok) {
    sessionStorage.airtableToken = tok;
    AIRTABLE_CONFIG.token = tok;
  }
  return tok;
}

function loadAirtableEvents() {
  // Recupera il token (chiede se non esiste). Se la richiesta viene annullata o
  // bloccata dal browser non deve fermare tutto: la tendina si popola comunque,
  // anche solo per dire che non ci sono partite.
  var token = null;
  try { token = AIRTABLE_CONFIG.token || getAirtableToken(); }
  catch (e) { console.warn('Token Airtable non richiesto:', e && e.message); }
  if (!token) {
    console.warn('Token Airtable non disponibile');
    renderEventPanel();
    return;
  }

  // Dagli ultimi 2 giorni in avanti, senza limite superiore.
  // DATEADD(TODAY(), -2, 'days') = mezzanotte di due giorni fa: restano in
  // elenco l'altroieri, ieri, oggi (a qualsiasi ora) e tutto il futuro.
  // Esclude le partite rinviate e i PRE SHOW, che sono slot interni di studio
  // ("PRE SHOW SERATA 2: SOLO PARTITE MEZZANOTTE") e non diventano mai grafiche.
  // I FOOTBALL SHOW invece restano: sono programmi con una loro grafica. Prima
  // il filtro escludeva qualunque cosa contenesse "SHOW" e li portava via tutti.
  var filterFormula = 'AND(' +
    "IS_AFTER({Data | Orario}, DATEADD(TODAY(), -2, 'days')), " +
    'NOT({Partita} = BLANK()), ' +
    'NOT(FIND("RINVIATA", UPPER({Partita}))), ' +
    'NOT(FIND("PRE SHOW", UPPER({Partita})))' +
    ')';

  var url = 'https://api.airtable.com/v0/' + AIRTABLE_CONFIG.baseId + '/' + AIRTABLE_CONFIG.tableId;
  var params = {
    filterByFormula: filterFormula,
    pageSize: '100',
    'sort[0][field]': 'Data | Orario',
    'sort[0][direction]': 'asc'
  };

  airtableFetchAll(url, params, token)
    .then(records => {
      EVENTS_DATA = records.map(rec => parseAirtableRecord(rec));
      console.log('Caricati ' + EVENTS_DATA.length + ' eventi da Airtable', EVENTS_DATA);
        renderEventPanel();
    })
    .catch(err => {
      console.error('Errore Airtable:', err);
      renderEventPanel(); // Mostra il pannello anche se vuoto
    });
}

// Airtable restituisce max 100 record per pagina: segue l'offset finché
// ci sono altre pagine, così l'elenco copre tutto il calendario.
function airtableFetchAll(baseUrl, params, token) {
  var all = [];
  var MAX_PAGES = 50; // guardia anti-loop (5.000 record)
  function page(offset, n) {
    var p = new URLSearchParams(params);
    if (offset) p.set('offset', offset);
    return fetch(baseUrl + '?' + p.toString(), {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    })
      .then(r => {
        if (!r.ok) throw new Error('Airtable error: ' + r.status);
        return r.json();
      })
      .then(data => {
        all = all.concat(data.records || []);
        if (data.offset && n < MAX_PAGES) return page(data.offset, n + 1);
        if (data.offset) console.warn('Airtable: raggiunto il limite di ' + MAX_PAGES + ' pagine');
        return all;
      });
  }
  return page(null, 1);
}

function parseAirtableRecord(rec) {
  var fields = rec.fields || {};
  var partita = fields['Partita'] || '';
  console.log('DEBUG parseAirtableRecord:', {
    partita: partita,
    competizione: fields['Competizione'],
    turno: fields['Turno'],
    allFields: fields
  });

  // Parsing "CASA-OSPITE" da Partita (gestisce: "PARMA-COMO", "A-B 3-4", "A-B RINVIATA", "A-B 3-4 (dcr)", ecc.)
  var cleanedPartita = partita
    .replace(/\s+RINVIATA.*$/i, '')      // Rimuovi RINVIATA e tutto dopo
    .replace(/\s*\(\d+-\d+.*?\).*$/i, '') // Rimuovi (N-N ...) e dopo
    .replace(/\s+\d+-\d+\s*(dcr)?.*$/i, '') // Rimuovi punteggio finale e dcr
    .trim();

  var parts = cleanedPartita.split('-');
  var home = (parts[0] || '').trim().replace(/^\d+\s*/, '').toUpperCase();
  var away = (parts[1] || '').trim().replace(/^\d+\s*/, '').toUpperCase();

  // Un programma non e' una partita: non ha due squadre e non vuole il "vs".
  // "FOOTBALL SHOW: Sorteggi Champions" diventa due righe, titolo e sottotitolo.
  var noVs = false;
  if (!away) {
    var titolo = cleanedPartita.replace(/^[^A-Za-z0-9]+/, '').trim();  // via l'emoji iniziale
    var duePunti = titolo.indexOf(':');
    if (duePunti > 0) {
      home = titolo.slice(0, duePunti).trim().toUpperCase();
      away = titolo.slice(duePunti + 1).trim().toUpperCase();
    } else {
      home = titolo.toUpperCase();
      away = '';
    }
    noVs = true;
  }

  // Parsing data/ora
  var dateTime = fields['Data | Orario'] || '';
  var date = '';
  var time = '';
  var year = 0;
  if (dateTime) {
    var dt = new Date(dateTime);
    var day = dt.getDate();
    var monthNames = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
    date = day + ' ' + monthNames[dt.getMonth()];
    time = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
    year = dt.getFullYear();
  }

  // Competizione (da singleSelect Airtable - è una stringa, non array)
  var comp = fields['Competizione'] || '';

  // Turno (da singleSelect Airtable - è una stringa, non array)
  var round = fields['Turno'] || '';

  // Fan Voice
  var fanVoice = !!fields['Fan Voice'];

  // English commentary
  var english = !!(fields['Commento 1'] || []).find(c => c.includes('Paul') || c.includes('EN'));

  // Foto Piattaforma (URL della foto o array di allegati Airtable)
  var fotoUrl = '';
  var fotoField = fields['Foto Piattaforma'];
  if (fotoField) {
    // Se è un array (allegati Airtable), prendi il primo URL
    if (Array.isArray(fotoField) && fotoField.length > 0) {
      fotoUrl = fotoField[0].url || '';
    }
    // Se è una stringa (URL manuale), usala direttamente
    else if (typeof fotoField === 'string') {
      fotoUrl = fotoField;
    }
  }

  return {
    id: rec.id,
    home: home,
    away: away,
    date: date,
    time: time,
    year: year,
    compBase: comp,
    compKey: comp.toLowerCase().replace(/\s+/g, '_'),
    round: round,
    english: english,
    noVs: noVs,
    fanVoice: fanVoice,
    partitaRaw: partita,
    fotoUrl: fotoUrl
  };
}

function renderEventPanel() {
  // La tendina vive nella barra in alto. Se il posto c'e', si usa quello e si
  // toglie di mezzo il vecchio pannello laterale, che altrimenti resta li' da
  // una sessione precedente con dentro un secondo select con lo stesso id.
  var inBarra = document.querySelector('#barra #airtableEventSelect');
  if (inBarra) {
    var vecchioPannello = document.getElementById('airtableImportPanel');
    if (vecchioPannello) vecchioPannello.remove();
    fillEventSelect(inBarra);
    if (!inBarra.dataset.wired) {
      inBarra.dataset.wired = '1';
      inBarra.onchange = function() {
        if (this.value === '') return;
        applyEventToGenerator(EVENTS_DATA[parseInt(this.value)]);
        // niente azzeramento: la tendina mostra la partita su cui stai lavorando
      };
    }
    return;
  }
  // Controlla se il pannello Airtable esiste già
  var existing = document.getElementById('airtableImportPanel');
  if (existing) {
    // Aggiorna il select con gli eventi (in caso di ricarica)
    var select = document.getElementById('airtableEventSelect');
    if (select) fillEventSelect(select);
    return;
  }

  var wrap = document.querySelector('.wrap');
  if (!wrap) return;

  // Crea contenitore Airtable (senza classe pbody, sarà un elemento sibling di step/card)
  var panelContainer = document.createElement('div');
  panelContainer.id = 'airtableImportPanel';

  // Sezione "Importa da Airtable"
  var importSec = document.createElement('div');
  importSec.className = 'step';
  var stepSpan = document.createElement('span');
  stepSpan.className = 'n';
  stepSpan.textContent = '1';
  importSec.appendChild(stepSpan);
  importSec.appendChild(document.createTextNode('Importa da Airtable'));
  panelContainer.appendChild(importSec);

  var card = document.createElement('div');
  card.className = 'card';
  card.id = 'airtableEventCard';

  if (EVENTS_DATA.length === 0) {
    card.innerHTML = '<p style="color: var(--fg3); font-size: 12px;">Nessun evento dagli ultimi 2 giorni in avanti</p>';
  } else {
    var select = document.createElement('select');
    select.id = 'airtableEventSelect';
    select.style.width = '100%';
    fillEventSelect(select);

    select.onchange = function() {
      if (this.value === '') return;
      applyEventToGenerator(EVENTS_DATA[parseInt(this.value)]);
    };

    card.appendChild(select);
  }

  panelContainer.appendChild(card);

  // Inserisci DENTRO il .wrap come prima colonna (Step 1)
  var pbody = wrap.querySelector('.pbody');
  if (pbody) {
    pbody.insertBefore(panelContainer, pbody.firstChild);
  } else {
    wrap.parentNode.insertBefore(panelContainer, wrap);
  }
}

// Riempie il menu a tendina: placeholder + un'opzione per evento.
function fillEventSelect(select) {
  var scelta = select.value;   // l'elenco si ricostruisce, la scelta no
  select.innerHTML = '';
  select.appendChild(createOption('', EVENTS_DATA.length ? '— Scegli partita —' : '— nessuna partita da Airtable —'));
  EVENTS_DATA.forEach((evt, idx) => {
    select.appendChild(createOption(idx, eventLabel(evt)));
  });
  if (scelta !== '' && select.querySelector('option[value="' + scelta + '"]')) select.value = scelta;
}

// "CASA vs OSPITE · 16 Ago · 16:00 · Serie A"
// L'anno compare solo se l'evento non è dell'anno corrente.
function eventLabel(evt) {
  var parts = [evt.noVs ? (evt.home + (evt.away ? ': ' + evt.away : '')) : (evt.home + ' vs ' + evt.away)];
  var when = evt.date || '';
  if (when && evt.year && evt.year !== new Date().getFullYear()) when += ' ' + evt.year;
  if (when) parts.push(when);
  if (evt.time) parts.push(evt.time);
  if (evt.compBase) parts.push(evt.compBase);
  return parts.join(' · ');
}

function createOption(val, text) {
  var opt = document.createElement('option');
  opt.value = val;
  opt.textContent = text;
  return opt;
}

function applyEventToGenerator(evt) {
  if (typeof SHARED === 'undefined') return;
  if (typeof pushUndo === 'function') pushUndo();

  console.log('🎯 CAMBIO PARTITA:', evt.home, 'vs', evt.away);

  // Aggiorna SHARED (dati globali)
  SHARED.home = evt.home || 'Home';
  SHARED.away = evt.away || 'Away';
  SHARED.compBase = evt.compBase || '';
  SHARED.comp = evt.compBase + (evt.round ? ' · ' + evt.round : '');
  SHARED.round = evt.round || '';
  SHARED.date = evt.date || '';
  SHARED.time = evt.time || '';
  SHARED.year = evt.year || new Date().getFullYear();
  SHARED.english = evt.english || false;
  SHARED.noVs = !!evt.noVs;   // i template tolgono il "vs" quando non c'e' un avversario

  // Mappatura competizione
  var mappedCompKey = COMP_MAPPING[evt.compBase] || evt.compKey || '';
  SHARED.compKey = mappedCompKey;

  // Aggiorna TEAMS
  if (SHARED.compKey && typeof TEAMS !== 'undefined') {
    var teamsForComp = new Set();
    EVENTS_DATA.forEach(e => {
      if (COMP_MAPPING[e.compBase] === SHARED.compKey) {
        teamsForComp.add(e.home);
        teamsForComp.add(e.away);
      }
    });
    if (!TEAMS[SHARED.compKey]) {
      TEAMS[SHARED.compKey] = { label: SHARED.compBase, name: SHARED.compBase, teams: [] };
    }
    TEAMS[SHARED.compKey].teams = Array.from(teamsForComp).sort();
  }

  // Carica logo
  if (typeof LOGO_LIB !== 'undefined' && LOGO_LIB[mappedCompKey] && typeof SHIMG !== 'undefined') {
    SHIMG.logoComp = LOGO_LIB[mappedCompKey].d;
  }

  // Ricorda da quale record vengono questi dati: e' il legame che permette,
  // giorni dopo, di riaprire la sessione e accorgersi che l'orario e' cambiato.
  if (typeof AIRTABLE_REC !== 'undefined') {
    window.AIRTABLE_REC = { id: evt.id, nome: eventLabel(evt), quando: Date.now() };
  }

  // Foto: allegato Airtable oppure link nel campo URL.
  if (evt.fotoUrl && typeof fotoNuova === 'function') {
    if (typeof avviso === 'function') avviso('Scarico la foto…');
    scaricaFoto(evt.fotoUrl)
      .then(dataUri => {
        // fotoNuova azzera i ritagli di TUTTI i formati, riconosce il volto e
        // riancora ogni formato al proprio mirino.
        fotoNuova(dataUri, { tipo: 'airtable', url: evt.fotoUrl }, function () {
          if (typeof avvisoVia === 'function') avvisoVia();
        });
      })
      .catch(e => {
        console.error('Foto non caricata:', e);
        // Silenzio qui significava esportare 32 grafiche col fondo di default
        // senza accorgersene: va detto, e va detto dove si guarda.
        if (typeof avviso === 'function') {
          avviso('<b>Foto non caricata</b> (' + (e && e.message ? e.message : 'errore') +
                 '). Le grafiche useranno lo sfondo di default: carica la foto a mano.', { male: true });
        }
      });
  }

  // Aggiorna i campi nel DOM (aspetta che siano creati)
  setTimeout(updateFieldsInDOM, 100);

  // Re-render canvas e anteprime
  setTimeout(function() {
    if (typeof renderStage === 'function') renderStage();
    if (typeof refreshThumbs === 'function') refreshThumbs();
  }, 150);
}

function updateFieldsInDOM() {
  console.log('📝 Aggiorna campi da Airtable:', {home: SHARED.home, away: SHARED.away, comp: SHARED.compBase, round: SHARED.round, date: SHARED.date, time: SHARED.time});

  // Aggiorna TUTTI gli input text e select
  var allInputs = document.querySelectorAll('input[type="text"], select');
  var updated = {comp: false, round: false, home: false, away: false, date: false, time: false};

  allInputs.forEach((el) => {
    var label = el.previousElementSibling ? el.previousElementSibling.textContent.toLowerCase() : '';
    var isSelect = el.tagName === 'SELECT';
    var isInput = el.tagName === 'INPUT';

    // Competizione
    if (label.includes('competizione') && !updated.comp) {
      if (isInput) el.value = SHARED.compBase;
      if (isSelect) el.value = SHARED.compKey;
      el.dispatchEvent(new Event('change'));
      updated.comp = true;
      console.log('✓ Competizione:', SHARED.compBase);
    }

    // Giornata / Turno
    if ((label.includes('giornata') || label.includes('turno')) && !updated.round) {
      el.value = SHARED.round;
      el.dispatchEvent(new Event('change'));
      updated.round = true;
      console.log('✓ Turno:', SHARED.round);
    }

    // Squadra casa
    if (label.includes('squadra casa') && !updated.home) {
      if (isInput) {
        el.value = SHARED.home;
        el.dispatchEvent(new Event('input'));
      } else if (isSelect) {
        // Cerca option con testo matching
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].text.toUpperCase() === SHARED.home.toUpperCase()) {
            el.value = el.options[i].value;
            break;
          }
        }
        el.dispatchEvent(new Event('change'));
      }
      updated.home = true;
      console.log('✓ Home:', SHARED.home);
    }

    // Squadra ospite
    if (label.includes('squadra ospite') && !updated.away) {
      if (isInput) {
        el.value = SHARED.away;
        el.dispatchEvent(new Event('input'));
      } else if (isSelect) {
        // Cerca option con testo matching
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].text.toUpperCase() === SHARED.away.toUpperCase()) {
            el.value = el.options[i].value;
            break;
          }
        }
        el.dispatchEvent(new Event('change'));
      }
      updated.away = true;
      console.log('✓ Away:', SHARED.away);
    }

    // Data
    if (label.includes('data') && !updated.date) {
      el.value = SHARED.date;
      el.dispatchEvent(new Event('input'));
      updated.date = true;
      console.log('✓ Data:', SHARED.date);
    }

    // Ora
    if (label.includes('ora') && !updated.time) {
      el.value = SHARED.time;
      el.dispatchEvent(new Event('input'));
      updated.time = true;
      console.log('✓ Ora:', SHARED.time);
    }
  });

  console.log('✓ Campi aggiornati da Airtable');
}

// Carica gli eventi al caricamento della pagina
window.addEventListener('load', function() {
  setTimeout(loadAirtableEvents, 500);
});


// ---- rilettura di un singolo record ----
// Serve a riaprire una sessione di giorni prima e confrontare i dati con quelli
// veri di adesso. Rilegge dall'API, non dall'elenco gia' in memoria: l'elenco e'
// stato caricato all'avvio e potrebbe essere vecchio quanto la sessione.
function airtableLeggiRecord(recordId) {
  var token = null;
  try { token = AIRTABLE_CONFIG.token || sessionStorage.airtableToken || getAirtableToken(); }
  catch (e) {}
  if (!token) return Promise.reject(new Error('token non disponibile'));
  var url = 'https://api.airtable.com/v0/' + AIRTABLE_CONFIG.baseId + '/' +
            AIRTABLE_CONFIG.tableId + '/' + encodeURIComponent(recordId);
  return fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => {
      if (r.status === 404) { var e = new Error('record non trovato'); e.sparito = true; throw e; }
      if (!r.ok) throw new Error('Airtable error: ' + r.status);
      return r.json();
    })
    .then(rec => parseAirtableRecord(rec));
}

// Confronto campo per campo fra i dati a schermo e quelli di Airtable adesso.
// Solo testo: la foto e i ritagli non entrano mai in questo confronto.
function airtableDifferenze(evt) {
  if (!evt || typeof SHARED === 'undefined') return [];
  var mappa = [
    { campo: 'home',     etichetta: 'Casa',          nuovo: evt.home || '' },
    { campo: 'away',     etichetta: 'Ospite',        nuovo: evt.away || '' },
    { campo: 'date',     etichetta: 'Data',          nuovo: evt.date || '' },
    { campo: 'time',     etichetta: 'Ora',           nuovo: evt.time || '' },
    { campo: 'compBase', etichetta: 'Competizione',  nuovo: evt.compBase || '' },
    { campo: 'round',    etichetta: 'Giornata',      nuovo: evt.round || '' }
  ];
  return mappa.filter(function (m) {
    var vecchio = SHARED[m.campo] == null ? '' : String(SHARED[m.campo]);
    return vecchio.trim() !== String(m.nuovo).trim();
  }).map(function (m) {
    m.vecchio = SHARED[m.campo] == null ? '' : String(SHARED[m.campo]);
    return m;
  });
}


// ---- foto da link ----
// Un link di Google Drive non e' scaricabile da un altro sito: drive.google.com
// non manda le intestazioni CORS e per giunta il link di condivisione e' una
// pagina HTML, non un'immagine. L'unica porta che Google lascia aperta e'
// lh3.googleusercontent.com. La foto va scaricata davvero, non solo puntata:
// un'immagine di un altro dominio "sporca" la canvas e l'export JPEG fallisce.
function driveFileId(url) {
  var m = String(url).match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/) ||
          String(url).match(/drive\.google\.com\/.*[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}
// In ordine di preferenza: originale, poi ridotto a 2000px, poi il link nudo
// (che si ferma a 1280px, troppo poco per un export a 1920).
function indirizziFoto(url) {
  var id = driveFileId(url);
  if (!id) return [url];
  var b = 'https://lh3.googleusercontent.com/d/' + id;
  return [b + '=d', b + '=w2000', b];
}
function scaricaFoto(url) {
  var lista = indirizziFoto(url);
  function prova(i) {
    if (i >= lista.length) {
      return Promise.reject(new Error(driveFileId(url)
        ? 'Google Drive non la lascia scaricare: il file e\' condiviso con "chiunque abbia il link"?'
        : 'il sito che la ospita non ne consente il download da un altro dominio'));
    }
    return fetch(lista[i], { mode: 'cors' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(blob => {
        if (blob.type && blob.type.indexOf('image/') !== 0) throw new Error('non e\' un\'immagine');
        return new Promise((ris, no) => {
          var reader = new FileReader();
          reader.onload = function () { ris(reader.result); };
          reader.onerror = function () { no(new Error('file illeggibile')); };
          reader.readAsDataURL(blob);
        });
      })
      .catch(function () { return prova(i + 1); });
  }
  return prova(0);
}
