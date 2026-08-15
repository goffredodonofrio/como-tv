// Estensione Generatore OTT ↔ Airtable
// Legge Live Events da Airtable (prossimi 14 giorni) e popola il pannello "Importa"

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
  'Supertaça Portugal': 'supertaca',
  'Serie A': 'serie_a',
  'Coppa Italia': 'coppa_italia',
  'Coppa Italia Primavera': 'coppa_italia_primavera',
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
  // Recupera il token (chiede se non esiste)
  var token = AIRTABLE_CONFIG.token || getAirtableToken();
  if (!token) {
    console.warn('Token Airtable non disponibile');
    renderEventPanel();
    return;
  }

  var today = new Date();
  var in14days = new Date(today);
  in14days.setDate(in14days.getDate() + 14);

  // Formatta le date per Airtable (YYYY-MM-DD)
  var todayStr = formatDateForAirtable(today);
  var in14daysStr = formatDateForAirtable(in14days);

  // Formula per filtrare eventi nei prossimi 14 giorni
  // Esclude non-partita (es. studio live, show) e partite rinviate
  var filterFormula = 'AND(' +
    'IS_AFTER({Data | Orario}, "' + todayStr + '"), ' +
    'IS_BEFORE({Data | Orario}, "' + in14daysStr + '"), ' +
    'NOT({Partita} = BLANK()), ' +
    'NOT(FIND("RINVIATA", {Partita})), ' +
    'NOT(FIND("SHOW", {Partita}))' +
    ')';

  var url = 'https://api.airtable.com/v0/' + AIRTABLE_CONFIG.baseId + '/' + AIRTABLE_CONFIG.tableId
    + '?filterByFormula=' + encodeURIComponent(filterFormula)
    + '&sort[0][field]=Data | Orario&sort[0][direction]=asc';

  fetch(url, {
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
      EVENTS_DATA = (data.records || []).map(rec => parseAirtableRecord(rec));
      console.log('Caricati ' + EVENTS_DATA.length + ' eventi da Airtable', EVENTS_DATA);
      if (data.records && data.records.length > 0) {
        console.log('Primo record raw:', data.records[0]);
      }
      renderEventPanel();
    })
    .catch(err => {
      console.error('Errore Airtable:', err);
      renderEventPanel(); // Mostra il pannello anche se vuoto
    });
}

function formatDateForAirtable(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function parseAirtableRecord(rec) {
  var fields = rec.fields || {};
  // Log dei nomi campi per debug
  if (!window.airtableFieldsLogged) {
    console.log('Nomi campi Airtable:', Object.keys(fields));
    window.airtableFieldsLogged = true;
  }

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

  // Parsing data/ora
  var dateTime = fields['Data | Orario'] || '';
  var date = '';
  var time = '';
  if (dateTime) {
    var dt = new Date(dateTime);
    var day = dt.getDate();
    var monthNames = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
    date = day + ' ' + monthNames[dt.getMonth()];
    time = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  }

  // Competizione (da singleSelect Airtable - è una stringa, non array)
  var comp = fields['Competizione'] || '';

  // Turno (da singleSelect Airtable - è una stringa, non array)
  var round = fields['Turno'] || '';

  // Fan Voice
  var fanVoice = !!fields['Fan Voice'];

  // English commentary
  var english = !!(fields['Commento 1'] || []).find(c => c.includes('Paul') || c.includes('EN'));

  return {
    id: rec.id,
    home: home,
    away: away,
    date: date,
    time: time,
    compBase: comp,
    compKey: comp.toLowerCase().replace(/\s+/g, '_'),
    round: round,
    english: english,
    fanVoice: fanVoice,
    partitaRaw: partita
  };
}

function renderEventPanel() {
  // Controlla se il pannello Airtable esiste già
  var existing = document.getElementById('airtableImportPanel');
  if (existing) {
    // Aggiorna il select con gli eventi (in caso di ricarica)
    var select = document.getElementById('airtableEventSelect');
    if (select && EVENTS_DATA.length > 0) {
      // Pulisci opzioni vecchie (tranne la prima)
      while (select.options.length > 1) select.remove(1);
      // Aggiungi nuove opzioni
      EVENTS_DATA.forEach((evt, idx) => {
        var label = evt.home + ' vs ' + evt.away
          + ' · ' + evt.date
          + ' · ' + evt.compBase;
        select.appendChild(createOption(idx, label));
      });
    }
    return;
  }

  var wrap = document.querySelector('.wrap');
  if (!wrap) return;

  // Crea contenitore Airtable FUORI dalla struttura del generatore
  var panelContainer = document.createElement('div');
  panelContainer.id = 'airtableImportPanel';
  panelContainer.className = 'pbody';
  panelContainer.style.marginBottom = '20px';
  panelContainer.style.borderBottom = '1px solid var(--fg3)';
  panelContainer.style.paddingBottom = '20px';

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
    card.innerHTML = '<p style="color: var(--fg3); font-size: 12px;">Nessun evento nei prossimi 14 giorni</p>';
  } else {
    var select = document.createElement('select');
    select.id = 'airtableEventSelect';
    select.style.width = '100%';
    select.appendChild(createOption('', '— Scegli partita —'));

    EVENTS_DATA.forEach((evt, idx) => {
      var label = evt.home + ' vs ' + evt.away
        + ' · ' + evt.date
        + ' · ' + evt.compBase;
      select.appendChild(createOption(idx, label));
    });

    select.onchange = function() {
      if (!this.value) return;
      var evt = EVENTS_DATA[parseInt(this.value)];
      applyEventToGenerator(evt);
    };

    card.appendChild(select);
  }

  panelContainer.appendChild(card);

  // Inserisci PRIMA del .wrap (così rimane sempre visibile)
  wrap.parentNode.insertBefore(panelContainer, wrap);
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

  SHARED.home = evt.home || 'Home';
  SHARED.away = evt.away || 'Away';
  SHARED.compBase = evt.compBase || '';
  SHARED.comp = evt.compBase + (evt.round ? ' · ' + evt.round : '');
  SHARED.round = evt.round || '';
  SHARED.date = evt.date || '';
  SHARED.time = evt.time || '';
  SHARED.english = evt.english || false;

  // Mappatura competizione italiano → compKey (per loghi e squadre)
  var mappedCompKey = COMP_MAPPING[evt.compBase] || evt.compKey || '';
  SHARED.compKey = mappedCompKey;

  // Carica il logo della competizione
  if (typeof LOGO_LIB !== 'undefined' && LOGO_LIB[mappedCompKey]) {
    if (typeof SHIMG !== 'undefined') {
      SHIMG.logoComp = LOGO_LIB[mappedCompKey].d;
      console.log('Logo caricato per', mappedCompKey);
    }
  }

  console.log('Evento applicato:', {
    home: SHARED.home,
    away: SHARED.away,
    comp: SHARED.comp,
    round: SHARED.round,
    compKey: SHARED.compKey
  });

  // Il pannello Airtable rimane visibile (è fuori da fieldsCard)
  if (typeof renderControls === 'function') renderControls();
  if (typeof renderStage === 'function') renderStage();
  if (typeof refreshThumbs === 'function') refreshThumbs();

  // AFTER renderControls(), compila TUTTI i campi
  setTimeout(function() {
    console.log('Post-renderControls: compilazione campi', { home: SHARED.home, away: SHARED.away, comp: SHARED.comp, round: SHARED.round });

    // Aggiorna TEAMS con le squadre di Airtable
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

    // Seleziona TUTTI i select (competizione, turno, squadra casa, squadra ospite)
    var selects = document.querySelectorAll('select');
    var selectIdx = 0;

    // Select 0: Competizione
    if (selects[selectIdx] && SHARED.compKey) {
      selects[selectIdx].value = SHARED.compKey;
      selects[selectIdx].dispatchEvent(new Event('change'));
      console.log('Set compKey:', SHARED.compKey);
    }
    selectIdx++;

    // Select 1: Turno
    if (selects[selectIdx] && SHARED.round) {
      selects[selectIdx].value = SHARED.round;
      selects[selectIdx].dispatchEvent(new Event('change'));
      console.log('Set round:', SHARED.round);
    }
    selectIdx++;

    // Select 2: Squadra casa
    if (selects[selectIdx] && SHARED.home) {
      var homeSelect = selects[selectIdx];
      var homeFound = false;
      for (var i = 0; i < homeSelect.options.length; i++) {
        if (homeSelect.options[i].value === SHARED.home || homeSelect.options[i].text === SHARED.home) {
          homeSelect.value = homeSelect.options[i].value;
          homeFound = true;
          break;
        }
      }
      if (homeFound) homeSelect.dispatchEvent(new Event('change'));
      console.log('Set home:', SHARED.home, homeFound ? 'found' : 'not found');
    }
    selectIdx++;

    // Select 3: Squadra ospite
    if (selects[selectIdx] && SHARED.away) {
      var awaySelect = selects[selectIdx];
      var awayFound = false;
      for (var i = 0; i < awaySelect.options.length; i++) {
        if (awaySelect.options[i].value === SHARED.away || awaySelect.options[i].text === SHARED.away) {
          awaySelect.value = awaySelect.options[i].value;
          awayFound = true;
          break;
        }
      }
      if (awayFound) awaySelect.dispatchEvent(new Event('change'));
      console.log('Set away:', SHARED.away, awayFound ? 'found' : 'not found');
    }

    // Input text: Data e Ora
    var inputs = document.querySelectorAll('input[type="text"]');
    inputs.forEach(input => {
      var label = input.previousElementSibling ? input.previousElementSibling.textContent : '';
      if (label.includes('Data') || label.includes('data')) {
        input.value = SHARED.date;
        input.dispatchEvent(new Event('input'));
        console.log('Set date:', SHARED.date);
      }
    });

    var timeInputs = document.querySelectorAll('input[type="text"]');
    timeInputs.forEach(input => {
      var label = input.previousElementSibling ? input.previousElementSibling.textContent : '';
      if (label.includes('Ora') || label.includes('ora')) {
        input.value = SHARED.time;
        input.dispatchEvent(new Event('input'));
        console.log('Set time:', SHARED.time);
      }
    });
  }, 150);
}

// Carica gli eventi al caricamento della pagina
window.addEventListener('load', function() {
  setTimeout(loadAirtableEvents, 500);
});
