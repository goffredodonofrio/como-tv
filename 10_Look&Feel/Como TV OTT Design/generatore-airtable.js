// Estensione Generatore OTT ↔ Airtable
// Legge Live Events da Airtable (prossimi 14 giorni) e popola il pannello "Importa"

var EVENTS_DATA = [];
var AIRTABLE_CONFIG = {
  baseId: 'appdDMcS8JQ4PTdLB',
  tableId: 'tblXKPRWFCLw5pVSt',
  token: null // Salvato in sessionStorage al primo caricamento
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
      console.log('Caricati ' + EVENTS_DATA.length + ' eventi da Airtable');
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
  var partita = fields['Partita'] || '';

  // Parsing "CASA-OSPITE" da Partita
  var parts = partita.split('-');
  var home = (parts[0] || '').trim().replace(/\s+RINVIATA.*/, '').replace(/^\d+\s*/, '');
  var away = (parts[1] || '').trim().replace(/\s*\d+\s*(dcr)?$/, '').trim();

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

  // Competizione
  var comp = (fields['Competizione'] || [''])[0] || '';
  var round = (fields['Turno'] || [''])[0] || '';

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
  var fc = document.getElementById('fieldsCard');
  if (!fc) return;

  // Crea la sezione "Importa" come Step 1
  var importSec = document.createElement('div');
  importSec.className = 'step';
  var stepSpan = document.createElement('span');
  stepSpan.className = 'n';
  stepSpan.textContent = '1';
  importSec.appendChild(stepSpan);
  importSec.appendChild(document.createTextNode('Importa da Airtable'));
  fc.insertBefore(importSec, fc.firstChild);

  var card = document.createElement('div');
  card.className = 'card';

  if (EVENTS_DATA.length === 0) {
    card.innerHTML = '<p style="color: var(--fg3); font-size: 12px;">Nessun evento nei prossimi 14 giorni</p>';
  } else {
    var select = document.createElement('select');
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

  fc.insertBefore(card, fc.firstChild.nextSibling);

  // Rinumerazione step esistenti (Formato → 2, Contenuto → 3)
  setTimeout(function() {
    var allSteps = fc.querySelectorAll('.step');
    allSteps.forEach(function(step, idx) {
      var numSpan = step.querySelector('.n');
      if (numSpan) numSpan.textContent = String(idx + 1);
    });
  }, 50);
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
  SHARED.compKey = evt.compKey || '';
  SHARED.english = evt.english || false;

  if (typeof renderControls === 'function') renderControls();
  if (typeof renderStage === 'function') renderStage();
  if (typeof refreshThumbs === 'function') refreshThumbs();
}

// Carica gli eventi al caricamento della pagina
window.addEventListener('load', function() {
  setTimeout(loadAirtableEvents, 500);
});
