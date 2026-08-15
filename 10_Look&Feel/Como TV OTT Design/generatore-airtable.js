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
      console.log('📷 Foto da allegato Airtable:', fotoUrl);
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
    fanVoice: fanVoice,
    partitaRaw: partita,
    fotoUrl: fotoUrl
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
      console.log('SELECT CHANGED:', this.value);
      var evt = EVENTS_DATA[parseInt(this.value)];
      applyEventToGenerator(evt);
      // Resetta il select dopo aver applicato (così puoi selezionare la stessa partita due volte)
      setTimeout(() => { this.value = ''; }, 100);
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

  // Carica foto da Airtable se disponibile
  if (evt.fotoUrl && typeof loadNat === 'function') {
    console.log('📷 Carico foto da Airtable:', evt.fotoUrl);
    console.log('DEBUG: SHIMG=', SHIMG);
    console.log('DEBUG: STATE[current]=', STATE[current]);
    // Carica come blob per aggirare CORS, poi converti in data URI
    fetch(evt.fotoUrl, {mode: 'cors'})
      .then(r => {
        console.log('✓ Fetch response:', r.status);
        return r.blob();
      })
      .then(blob => {
        console.log('✓ Blob caricato, size:', blob.size);
        var reader = new FileReader();
        reader.onload = function(){
          console.log('✓ DataURI convertito, lunghezza:', reader.result.length);
          SHIMG.photo = reader.result;
          delete STATE[current].adj.photo;
          // Usa loadNat() come per le foto locali per caricare dimensioni naturali
          if (typeof loadNat === 'function') {
            loadNat(reader.result, function(){
              console.log('✓ Dimensioni foto caricate via loadNat()');
              if (typeof autoPositionPhotoIfBanner === 'function') {
                autoPositionPhotoIfBanner();
              }
              if (typeof renderControls === 'function') renderControls();
              if (typeof renderStage === 'function') {
                console.log('✓ Chiamo renderStage()');
                renderStage();
              }
              if (typeof refreshThumbs === 'function') refreshThumbs();
              console.log('✓ Foto caricata da Airtable');
            });
          }
        };
        reader.readAsDataURL(blob);
      })
      .catch(e => {
        console.error('❌ Errore caricamento foto Airtable:', e);
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
